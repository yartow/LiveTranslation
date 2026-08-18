// Dispatch layer for POST /api/sermon/translate — one call per dirty
// segment, run under a shared concurrency cap, each with its own
// abort/timeout, provider errors isolated per-item so one bad segment never
// fails the whole batch. See server/routes.ts for the HTTP layer and the
// plan doc §4 for the full design.

import { client as openaiClient } from './openai';
import { makeClient as ollamaClient } from './ollama';
import { buildSystemPrompt, buildUserMessage, getFileGlossaryContext } from './sermon-prompt';
import { getGlossaryBundle } from './glossary-store';
import { checkGlossaryAdherence, type GlossaryWarning } from './glossary-check';
import { adjudicateScripture, type ReadingCandidate } from './scripture';
import { Semaphore } from './semaphore';

export type SermonTranslationProvider = 'openai' | 'claude' | 'ollama';

export interface TranslateItemInput {
  id: string;
  text: string;
  before: string[];
  after: string[];
  /** A detected/continuing Bible reading to check `text` against — see client/src/lib/sermon/bible-ref.ts and server/lib/scripture.ts. Absent when no reference applies to this segment. */
  readingCandidate?: ReadingCandidate;
  /** How to render a spoken reference announcement in English (e.g. "John 3:16") — passed through to the prompt as a rendering hint only, see sermon-prompt.ts. */
  referenceHint?: string;
}

/** Mirrors the outcome of server/lib/scripture.ts's adjudicateScripture for one item — see that module for the full verbatim/paraphrase/ended semantics. */
export interface ScriptureResultInfo {
  verbatim: boolean;
  /** True when this segment was checked against an ongoing reading and the match dropped below threshold (or scripture substitution is policy-disabled) — tells the client to stop treating subsequent segments as a continuation of that reading. */
  readingEnded: boolean;
  text?: string;
  reference?: string;
  version?: 'ESV' | 'KJV';
  verseEnd?: number;
}

export type TranslateItemResult =
  | { id: string; status: 'ok'; translation: string; warnings?: GlossaryWarning[]; scripture?: ScriptureResultInfo }
  | { id: string; status: 'error'; error: string };

export interface TranslateOptions {
  targetLanguage: string;
  translationProvider: SermonTranslationProvider;
  model?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  /** Free-text glossary from client settings — the v1 fallback, used only when no file glossary is loaded. See sermon-prompt.ts's getFileGlossaryContext. */
  glossaryOverride?: string;
  /** Basenames selecting which files server/lib/glossary-store.ts loads — server-default selection is used when omitted. */
  glossaryCsv?: string;
  disambiguationPrompt?: string;
  bibleVersion?: string;
  deityCapitals?: boolean;
  /** Non-blocking per-segment glossary-adherence check — on by default. */
  glossaryWarningsEnabled?: boolean;
  /** Master switch for the whole Bible-quote pipeline — on by default; when false, every item's readingCandidate is ignored and translation proceeds as if it were never sent. */
  scriptureEnabled?: boolean;
  esvApiKey?: string;
  /** What to do for a verbatim reading when the ESV API doesn't return text (no key, request failed) — 'kjv' (default) substitutes the bundled public-domain KJV instead; 'none' skips substitution entirely (falls through to a normal model translation) rather than ever surfacing KJV wording. */
  scriptureFallback?: 'kjv' | 'none';
  signal?: AbortSignal;
}

// The MLX sidecar caps its own concurrency at 1 because it's a single local
// process; LLM translation calls are ordinary hosted API calls, so a modest
// cap here is purely about not hammering a provider with an entire Refresh's
// worth of segments at once (plan §"Risico's", point 5/6) — it is not a
// hardware constraint like whisperSemaphore/mlxSemaphore in chunk-transcription.ts.
const semaphore = new Semaphore(4);

const ITEM_TIMEOUT_MS = 20_000;
// A whole-batch deadline on top of the per-item timeout: with SERMON_MAX_ITEMS
// (server/routes.ts) at 100 and a concurrency cap of 4, a batch could
// otherwise queue up to ~25 sequential waves of ITEM_TIMEOUT_MS each before
// every item has at least had a chance to start — bounding total request
// time regardless of batch size, on top of (not instead of) each item's own
// timeout once it's actually running.
const BATCH_TIMEOUT_MS = 90_000;

export interface TranslateDeps {
  callModel?: (systemPrompt: string, userMessage: string, opts: TranslateOptions, signal: AbortSignal) => Promise<string>;
}

/** Translates each item independently (own semaphore slot, own timeout); never throws — failures become {status:'error'} entries. */
export async function translateSegments(
  items: TranslateItemInput[],
  opts: TranslateOptions,
  deps: TranslateDeps = {},
): Promise<TranslateItemResult[]> {
  // Bundle lookup + prompt build happen once per batch, outside the per-item
  // map below — not per item — so a Refresh across dozens of segments still
  // does a single bundle cache read and a single (memoized) prompt build.
  const bundle = getGlossaryBundle({ csv: opts.glossaryCsv, prompt: opts.disambiguationPrompt });
  const glossaryContext = getFileGlossaryContext({
    bundle,
    bibleVersion: opts.bibleVersion ?? 'KJV',
    deityCapitals: opts.deityCapitals ?? false,
    fallbackGlossary: opts.glossaryOverride,
  });
  const systemPrompt = buildSystemPrompt(opts.targetLanguage, glossaryContext);
  const callModel = deps.callModel ?? callModelDefault;
  const warningsEnabled = opts.glossaryWarningsEnabled !== false && !!bundle;

  const scriptureEnabled = opts.scriptureEnabled !== false;

  // Batch-wide deadline — combined into every item's own signal below so a
  // queued (not-yet-started) item can never outlive it even though its own
  // ITEM_TIMEOUT_MS timer hasn't started counting yet.
  const batchTimeout = AbortSignal.timeout(BATCH_TIMEOUT_MS);
  const batchSignal = opts.signal ? AbortSignal.any([batchTimeout, opts.signal]) : batchTimeout;

  return Promise.all(items.map(async (item): Promise<TranslateItemResult> => {
    await semaphore.acquire();
    try {
      const timeout = AbortSignal.timeout(ITEM_TIMEOUT_MS);
      const combinedSignal = AbortSignal.any([timeout, batchSignal]);

      // Scripture adjudication happens BEFORE the model call — a verbatim
      // reading substitutes the exact verse text directly and skips the
      // model entirely (spec "Bijbelcitaten" Layer 1); a paraphrase instead
      // adds Layer-2 guidance to the prompt below; "ended" and a policy-
      // declined verbatim both fall through to an ordinary translation, the
      // latter flagged readingEnded so the client stops checking subsequent
      // segments against this reading.
      let scriptureGuidance: string | undefined;
      let scriptureInfo: ScriptureResultInfo | undefined;

      // Verbatim substitution only makes sense when the target is English —
      // the substituted text is always ESV/KJV English wording (scripture.ts),
      // so substituting it into a non-English target stream would silently
      // insert untranslated English into (say) a Dutch translation instead of
      // the Dutch rendering of the verse. Paraphrase guidance (<VERSTEKST_ESV>,
      // still just a register hint fed to the model) is unaffected.
      const isEnglishTarget = opts.targetLanguage.split('-')[0].toLowerCase() === 'en';

      if (scriptureEnabled && item.readingCandidate) {
        const verdict = await adjudicateScripture(item.text, item.readingCandidate, {
          esvApiKey: opts.esvApiKey,
          signal: combinedSignal,
        });

        if (verdict.kind === 'verbatim' && !isEnglishTarget) {
          // Genuinely a verbatim reading, but substitution would insert
          // English text into a non-English target — fall through to an
          // ordinary model translation of the preacher's own (Dutch) words,
          // without marking the reading as ended, since it hasn't.
        } else if (verdict.kind === 'verbatim') {
          const fallbackDeclined = verdict.version === 'KJV' && opts.scriptureFallback === 'none';
          if (!fallbackDeclined) {
            return {
              id: item.id, status: 'ok', translation: verdict.text,
              scripture: {
                verbatim: true, readingEnded: false, text: verdict.text,
                reference: verdict.reference, version: verdict.version, verseEnd: verdict.verseEnd,
              },
            };
          }
          scriptureInfo = { verbatim: false, readingEnded: true };
        } else if (verdict.kind === 'paraphrase') {
          // Bundled/ESV verse text is trusted operator-grade data (unlike
          // the glossary, it needs no sanitizeGlossary-style fencing or
          // injection-keyword filtering) but is embedded into the prompt as
          // <VERSTEKST_ESV>, so a literal ``` sequence — vanishingly
          // unlikely in Bible prose, but free to guard against — must not
          // be able to close that block early. Mirrors the same guard on
          // the glossary's disambiguation doc (CLAUDE.md "Security notes").
          scriptureGuidance = verdict.guidance.replace(/```+/g, "'");
        } else {
          scriptureInfo = { verbatim: false, readingEnded: true };
        }
      }

      const userMessage = buildUserMessage({
        before: item.before, target: item.text, after: item.after,
        scriptureGuidance, referenceHint: item.referenceHint,
      });

      const translation = await callModel(systemPrompt, userMessage, opts, combinedSignal);
      if (typeof translation !== 'string' || !translation.trim()) {
        return { id: item.id, status: 'error', error: 'Empty translation response' };
      }

      const result: TranslateItemResult = { id: item.id, status: 'ok', translation };
      if (scriptureInfo) result.scripture = scriptureInfo;
      if (warningsEnabled && bundle) {
        const warnings = checkGlossaryAdherence(item.text, translation, bundle.checkIndex);
        if (warnings.length > 0) result.warnings = warnings;
      }
      return result;
    } catch (err) {
      console.error(`Sermon translate item ${item.id} failed:`, err);
      return { id: item.id, status: 'error', error: classifyError(err) };
    } finally {
      semaphore.release();
    }
  }));
}

function classifyError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error';
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'Translation timed out';
  const msg = error.message;
  const anyErr = error as { status?: number };
  if (anyErr.status === 401 || msg.toLowerCase().includes('api key')) return 'API key invalid or missing';
  if (anyErr.status === 429 || msg.toLowerCase().includes('rate limit')) return 'Rate limit exceeded — try again shortly';
  // Anything else (network errors, provider-side 5xxs, etc.) is logged with
  // full detail by the caller above — the client only gets a generic
  // message so internal details (hostnames, stack fragments) never leak.
  return 'Translation failed';
}

async function callModelDefault(systemPrompt: string, userMessage: string, opts: TranslateOptions, signal: AbortSignal): Promise<string> {
  if (opts.translationProvider === 'claude') return callClaudeCached(systemPrompt, userMessage, opts.anthropicApiKey || '', signal);
  if (opts.translationProvider === 'ollama') return callOllama(systemPrompt, userMessage, opts, signal);
  return callOpenAI(systemPrompt, userMessage, opts, signal);
}

function extractTranslation(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.translation === 'string' ? parsed.translation : '';
  } catch {
    return '';
  }
}

async function callOpenAI(systemPrompt: string, userMessage: string, opts: TranslateOptions, signal: AbortSignal): Promise<string> {
  const response = await openaiClient(opts.openaiApiKey).chat.completions.create(
    {
      model: opts.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    },
    { signal },
  );
  return extractTranslation(response.choices[0]?.message?.content || '{}');
}

async function callOllama(systemPrompt: string, userMessage: string, opts: TranslateOptions, signal: AbortSignal): Promise<string> {
  const response = await ollamaClient(opts.ollamaBaseUrl || 'http://localhost:11434').chat.completions.create(
    {
      model: opts.ollamaModel || 'qwen2.5:14b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    },
    { signal },
  );
  return extractTranslation(response.choices[0]?.message?.content || '{}');
}

// Claude prompt caching needs `system` as a block array with cache_control —
// the existing callClaude() in anthropic.ts uses a plain string `system` and
// is shared by other callers, so this is a separate implementation rather
// than a retrofit (plan §4: "Bestaande callClaude niet aanpassen").
async function callClaudeCached(systemPrompt: string, userMessage: string, apiKey: string, signal: AbortSignal): Promise<string> {
  const effectiveKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!effectiveKey) throw new Error('No Anthropic API key provided. Add one in Settings.');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': effectiveKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = await response.json() as { content?: Array<{ text?: string }> };
  const raw = data.content?.[0]?.text ?? '';
  const match = raw.match(/\{[\s\S]*\}/);
  return match ? extractTranslation(match[0]) : '';
}
