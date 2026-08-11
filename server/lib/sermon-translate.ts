// Dispatch layer for POST /api/sermon/translate — one call per dirty
// segment, run under a shared concurrency cap, each with its own
// abort/timeout, provider errors isolated per-item so one bad segment never
// fails the whole batch. See server/routes.ts for the HTTP layer and the
// plan doc §4 for the full design.

import { client as openaiClient } from './openai';
import { makeClient as ollamaClient } from './ollama';
import { buildSystemPrompt, buildUserMessage, getGlossaryContext } from './sermon-prompt';
import { Semaphore } from './semaphore';

export type SermonTranslationProvider = 'openai' | 'claude' | 'ollama';

export interface TranslateItemInput {
  id: string;
  text: string;
  before: string[];
  after: string[];
}

export type TranslateItemResult =
  | { id: string; status: 'ok'; translation: string }
  | { id: string; status: 'error'; error: string };

export interface TranslateOptions {
  targetLanguage: string;
  translationProvider: SermonTranslationProvider;
  model?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  /** Free-text glossary from client settings — the v1 glossary seam, see sermon-prompt.ts. */
  glossaryOverride?: string;
  signal?: AbortSignal;
}

// The MLX sidecar caps its own concurrency at 1 because it's a single local
// process; LLM translation calls are ordinary hosted API calls, so a modest
// cap here is purely about not hammering a provider with an entire Refresh's
// worth of segments at once (plan §"Risico's", point 5/6) — it is not a
// hardware constraint like whisperSemaphore/mlxSemaphore in chunk-transcription.ts.
const semaphore = new Semaphore(4);

const ITEM_TIMEOUT_MS = 20_000;

export interface TranslateDeps {
  callModel?: (systemPrompt: string, userMessage: string, opts: TranslateOptions, signal: AbortSignal) => Promise<string>;
}

/** Translates each item independently (own semaphore slot, own timeout); never throws — failures become {status:'error'} entries. */
export async function translateSegments(
  items: TranslateItemInput[],
  opts: TranslateOptions,
  deps: TranslateDeps = {},
): Promise<TranslateItemResult[]> {
  const glossaryContext = getGlossaryContext(opts.glossaryOverride);
  const systemPrompt = buildSystemPrompt(opts.targetLanguage, glossaryContext);
  const callModel = deps.callModel ?? callModelDefault;

  return Promise.all(items.map(async (item): Promise<TranslateItemResult> => {
    await semaphore.acquire();
    try {
      const timeout = AbortSignal.timeout(ITEM_TIMEOUT_MS);
      const combinedSignal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
      const userMessage = buildUserMessage({ before: item.before, target: item.text, after: item.after });

      const translation = await callModel(systemPrompt, userMessage, opts, combinedSignal);
      if (typeof translation !== 'string' || !translation.trim()) {
        return { id: item.id, status: 'error', error: 'Empty translation response' };
      }
      return { id: item.id, status: 'ok', translation };
    } catch (err) {
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
  return msg;
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
