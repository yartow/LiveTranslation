// Dispatch layer for POST /api/sermon/translate — one call per dirty
// segment, run under a shared concurrency cap, each with its own
// abort/timeout, provider errors isolated per-item so one bad segment never
// fails the whole batch. See server/routes.ts for the HTTP layer and the
// plan doc §4 for the full design.

import { client as openaiClient } from './openai';
import { makeClient as ollamaClient, OLLAMA_NO_THINKING } from './ollama';
import { buildSystemPrompt, buildUserMessage, buildServiceContextBlock, getFileGlossaryContext, type CorrectionExample } from './sermon-prompt';
import { similarity } from './text-similarity';
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
  /** True when the segment was recognised as the preacher's own words around the announced passage (the paraphrase band) — the client uses it to treat the reading as really under way. */
  paraphrase?: boolean;
  /** Paraphrase only: the first verse the match started at (>= the checked candidate) — the client moves the reading up to it. */
  verseStart?: number;
  text?: string;
  reference?: string;
  version?: 'ESV' | 'LSB' | 'KJV';
  verseEnd?: number;
}

export type TranslateItemResult =
  | {
      id: string; status: 'ok'; translation: string; warnings?: GlossaryWarning[]; scripture?: ScriptureResultInfo;
      /** Back-translation check only: how close the English, translated back to Dutch, is to what was said (0-1). */
      fidelity?: number;
      /** fidelity is below the operator's threshold — set only when true. */
      lowFidelity?: boolean;
    }
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
  /** Earlier hand corrections in this sermon (machine -> human), shown to the model as examples of the translator's preferences. Per request. */
  examples?: CorrectionExample[];
  /** Translate every result back to Dutch and compare it with the source (costs a second call per segment). Off by default. */
  backTranslationCheck?: boolean;
  /** Below this similarity (0-1) a back-translated segment is flagged. Default BACK_TRANSLATION_THRESHOLD. */
  backTranslationThreshold?: number;
  /** "Today's service" (title, planned passages, names/terms, notes) as labelled lines — see client/src/lib/sermon/service-context.ts and sermon-prompt.ts's buildServiceContextBlock. Part of the cached system prefix. */
  serviceContext?: string;
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

/** Segments have no length limit, so the per-item deadline grows with the text: +1 s per 500 characters on top of the base. */
export function itemTimeoutMs(textLength: number): number {
  return ITEM_TIMEOUT_MS + Math.ceil(textLength / 500) * 1000;
}

/** Claude's output cap, scaled to the request instead of a fixed 512 (which truncated long segments into an empty translation): ~1 token per 2 characters, 1024-8192. */
export function claudeMaxTokens(userMessageLength: number): number {
  return Math.min(8192, Math.max(1024, Math.ceil(userMessageLength / 2)));
}
// A whole-batch deadline on top of the per-item timeout: with SERMON_MAX_ITEMS
// (server/routes.ts) at 100 and a concurrency cap of 4, a batch could
// otherwise queue up to ~25 sequential waves of ITEM_TIMEOUT_MS each before
// every item has at least had a chance to start — bounding total request
// time regardless of batch size, on top of (not instead of) each item's own
// timeout once it's actually running.
const BATCH_TIMEOUT_MS = 90_000;

/** One line of a session's translations.jsonl: what was asked, what came back, how long it took. */
export interface TranslationLogEntry {
  at: string;
  id: string;
  provider: SermonTranslationProvider;
  model: string;
  latencyMs: number;
  source: string;
  before: string[];
  after: string[];
  translation?: string;
  error?: string;
  warnings?: GlossaryWarning[];
  /** How the Bible-quote pipeline treated the item, when it was checked. */
  scripture?: { kind: 'verbatim' | 'paraphrase' | 'ended'; reference?: string; version?: string };
  /** The first answer broke a glossary term and a second call was made — see sermon-translate.ts. */
  retried?: boolean;
  /** Back-translation similarity to the source (0-1), when the check ran. */
  fidelity?: number;
  /** The English translated back to Dutch, when the check ran — what the score was computed from. */
  backTranslation?: string;
}

export interface TranslateDeps {
  callModel?: (systemPrompt: string, userMessage: string, opts: TranslateOptions, signal: AbortSignal) => Promise<string>;
  /** Called once per item with the outcome (success or error). Must not throw. */
  log?: (entry: TranslationLogEntry) => void;
}

/** What translateOne learned beyond the result itself, for the log. */
interface ItemMeta {
  retried?: boolean;
  fidelity?: number;
  back?: string;
}

/** Placeholder until calibrated against a real session's translations.jsonl (fidelity is logged for every checked item). */
export const BACK_TRANSLATION_THRESHOLD = 0.2;
/** Fewer words than this and bigram overlap says nothing. */
const BACK_TRANSLATION_MIN_WORDS = 5;
const BACK_TRANSLATION_SYSTEM = 'Translate the English text between <TEKST> tags into Dutch. Translate literally and completely; never add, drop or explain anything. Reply with exactly {"translation": "..."} — a single JSON object, no explanation, no markdown fencing.';

const DEFAULT_MODELS: Record<SermonTranslationProvider, string> = {
  openai: 'gpt-4o-mini',
  claude: 'claude-haiku-4-5-20251001',
  ollama: 'qwen3.6:latest',
};

export function modelLabel(opts: Pick<TranslateOptions, 'translationProvider' | 'model' | 'ollamaModel'>): string {
  if (opts.translationProvider === 'ollama') return opts.ollamaModel || DEFAULT_MODELS.ollama;
  if (opts.translationProvider === 'claude') return DEFAULT_MODELS.claude;
  return opts.model || DEFAULT_MODELS.openai;
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
  const systemPrompt = buildSystemPrompt(opts.targetLanguage, glossaryContext, buildServiceContextBlock(opts.serviceContext));
  const callModel = deps.callModel ?? callModelDefault;
  const warningsEnabled = opts.glossaryWarningsEnabled !== false && !!bundle;

  const scriptureEnabled = opts.scriptureEnabled !== false;

  // Batch-wide deadline — combined into every item's own signal below so a
  // queued (not-yet-started) item can never outlive it even though its own
  // ITEM_TIMEOUT_MS timer hasn't started counting yet.
  const batchTimeout = AbortSignal.timeout(BATCH_TIMEOUT_MS);
  const batchSignal = opts.signal ? AbortSignal.any([batchTimeout, opts.signal]) : batchTimeout;

  const translateOne = async (item: TranslateItemInput, meta: ItemMeta): Promise<TranslateItemResult> => {
      const timeout = AbortSignal.timeout(itemTimeoutMs(item.text.length));
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
          bibleVersion: opts.bibleVersion,
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
          scriptureInfo = { verbatim: false, readingEnded: false, paraphrase: true, verseStart: verdict.verseStart };
        } else {
          scriptureInfo = { verbatim: false, readingEnded: true };
        }
      }

      const messageInput = {
        before: item.before, target: item.text, after: item.after,
        scriptureGuidance, referenceHint: item.referenceHint, examples: opts.examples,
      };
      const userMessage = buildUserMessage(messageInput);

      let translation = await callModel(systemPrompt, userMessage, opts, combinedSignal);
      if (typeof translation !== 'string' || !translation.trim()) {
        return { id: item.id, status: 'error', error: 'Empty translation response' };
      }

      let warnings: GlossaryWarning[] = [];
      if (warningsEnabled && bundle) {
        warnings = checkGlossaryAdherence(item.text, translation, bundle.checkIndex);
        // A required glossary term was left out: ask once more, naming the terms, and keep the second
        // answer only if it breaks fewer of them. Any failure of the retry keeps the first answer.
        if (warnings.length > 0) {
          meta.retried = true;
          try {
            const second = await callModel(systemPrompt, buildUserMessage({ ...messageInput, terminologyFix: warnings }), opts, combinedSignal);
            if (typeof second === 'string' && second.trim()) {
              const secondWarnings = checkGlossaryAdherence(item.text, second, bundle.checkIndex);
              if (secondWarnings.length < warnings.length) { translation = second; warnings = secondWarnings; }
            }
          } catch { /* keep the first answer */ }
        }
      }

      const result: TranslateItemResult = { id: item.id, status: 'ok', translation };
      if (scriptureInfo) result.scripture = scriptureInfo;
      if (warnings.length > 0) result.warnings = warnings;

      // Optional: translate it back to Dutch and see how far that is from what was said.
      if (opts.backTranslationCheck && item.text.trim().split(/\s+/).length >= BACK_TRANSLATION_MIN_WORDS) {
        try {
          const back = await callModel(BACK_TRANSLATION_SYSTEM, `<TEKST>\n${translation.replace(/<\/?TEKST>/gi, '')}\n</TEKST>`, opts, combinedSignal);
          if (typeof back === 'string' && back.trim()) {
            const fidelity = Math.round(similarity(item.text, back) * 100) / 100;
            meta.fidelity = fidelity;
            meta.back = back;
            result.fidelity = fidelity;
            if (fidelity < (opts.backTranslationThreshold ?? BACK_TRANSLATION_THRESHOLD)) result.lowFidelity = true;
          }
        } catch { /* the check is advisory: no score, the translation stands */ }
      }
      return result;
  };

  return Promise.all(items.map(async (item): Promise<TranslateItemResult> => {
    await semaphore.acquire();
    const startedAt = Date.now();
    const meta: ItemMeta = {};
    let outcome: TranslateItemResult;
    try {
      outcome = await translateOne(item, meta);
    } catch (err) {
      console.error(`Sermon translate item ${item.id} failed:`, err);
      outcome = { id: item.id, status: 'error', error: classifyError(err) };
    } finally {
      semaphore.release();
    }
    if (deps.log) {
      try {
        deps.log({
          at: new Date(startedAt).toISOString(), id: item.id,
          provider: opts.translationProvider, model: modelLabel(opts),
          latencyMs: Date.now() - startedAt,
          source: item.text, before: item.before, after: item.after,
          ...(outcome.status === 'ok'
            ? {
                translation: outcome.translation,
                warnings: outcome.warnings,
                scripture: outcome.scripture
                  ? {
                      kind: outcome.scripture.verbatim ? 'verbatim' as const : outcome.scripture.paraphrase ? 'paraphrase' as const : 'ended' as const,
                      reference: outcome.scripture.reference, version: outcome.scripture.version,
                    }
                  : undefined,
              }
            : { error: outcome.error }),
          retried: meta.retried, fidelity: meta.fidelity, backTranslation: meta.back,
        });
      } catch { /* a debugging aid must never fail a translation */ }
    }
    return outcome;
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
      model: opts.ollamaModel || 'qwen3.6:latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
      ...OLLAMA_NO_THINKING,
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
      max_tokens: claudeMaxTokens(userMessage.length),
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
