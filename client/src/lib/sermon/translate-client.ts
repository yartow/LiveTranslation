// Thin client for POST /api/sermon/translate (server/routes.ts + server/lib/sermon-translate.ts).
// Kept separate from useTranslationQueue.ts so the hook's batching/debounce/
// staleness logic doesn't need to know about fetch or the wire format.

export interface ReadingCandidate {
  bookNumber: number;
  chapter: number;
  verse: number;
}

export interface TranslateItem {
  id: string;
  text: string;
  before: string[];
  after: string[];
  /** A detected/continuing Bible reading to check `text` against — see bible-ref.ts and server/lib/scripture.ts. */
  readingCandidate?: ReadingCandidate;
  /** How to render a spoken reference announcement in English (e.g. "John 3:16"). */
  referenceHint?: string;
}

/** Mirrors server/lib/sermon-translate.ts's ScriptureResultInfo. */
export interface ScriptureResult {
  verbatim: boolean;
  readingEnded: boolean;
  text?: string;
  reference?: string;
  version?: 'ESV' | 'KJV';
  verseEnd?: number;
}

export interface TranslateResultOk {
  id: string;
  status: 'ok';
  translation: string;
  warnings?: { term: string; expected: string }[];
  scripture?: ScriptureResult;
}

export interface TranslateResultError {
  id: string;
  status: 'error';
  error: string;
}

export type TranslateResult = TranslateResultOk | TranslateResultError;

export interface TranslateRequestOptions {
  sourceLanguage: string;
  targetLanguage: string;
  translationProvider: 'openai' | 'claude' | 'ollama';
  model?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  /** Free-text glossary from settings.theologicalGlossary — the v1 fallback, used server-side only when no file glossary is loaded. See server/lib/sermon-prompt.ts. */
  glossary?: string;
  /** File-based glossary selection (server/lib/glossary-store.ts) — basenames, resolved server-side against GLOSSARY_DIR. */
  glossaryCsv?: string;
  disambiguationPrompt?: string;
  bibleVersion?: string;
  deityCapitals?: boolean;
  glossaryWarnings?: boolean;
  sermonContext?: string;
  /** Master switch for the Bible-quote pipeline — see CLAUDE.md "Scripture pipeline". */
  scriptureEnabled?: boolean;
  esvApiKey?: string;
  scriptureFallback?: 'kjv' | 'none';
  signal?: AbortSignal;
}

// Bounds a batch's server round-trip so a stalled request can never leave
// segments stuck at TRANSLATING forever (see useTranslationQueue.ts's
// runBatch, which dispatches MARK_TRANSLATING before this call and has no
// other mechanism to un-stick it if the fetch itself never settles).
const SERMON_TRANSLATE_TIMEOUT_MS = 30_000;

function timeoutSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SERMON_TRANSLATE_TIMEOUT_MS);
  if (!callerSignal) return timeout;
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([timeout, callerSignal])
    : callerSignal; // very old runtime without AbortSignal.any — caller cancellation still works, just without the extra timeout
}

export async function translateItems(items: TranslateItem[], opts: TranslateRequestOptions): Promise<TranslateResult[]> {
  if (items.length === 0) return [];

  const res = await fetch('/api/sermon/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceLanguage: opts.sourceLanguage,
      targetLanguage: opts.targetLanguage,
      translationProvider: opts.translationProvider,
      model: opts.model,
      openaiApiKey: opts.openaiApiKey,
      anthropicApiKey: opts.anthropicApiKey,
      ollamaBaseUrl: opts.ollamaBaseUrl,
      ollamaModel: opts.ollamaModel,
      glossary: opts.glossary,
      glossaryCsv: opts.glossaryCsv,
      disambiguationPrompt: opts.disambiguationPrompt,
      bibleVersion: opts.bibleVersion,
      deityCapitals: opts.deityCapitals,
      glossaryWarnings: opts.glossaryWarnings,
      sermonContext: opts.sermonContext,
      scriptureEnabled: opts.scriptureEnabled,
      esvApiKey: opts.esvApiKey,
      scriptureFallback: opts.scriptureFallback,
      items: items.map(i => ({
        id: i.id, text: i.text, before: i.before, after: i.after,
        readingCandidate: i.readingCandidate, referenceHint: i.referenceHint,
      })),
    }),
    signal: timeoutSignal(opts.signal),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Sermon translate request failed (${res.status})`);
  }

  const data = await res.json() as { results: TranslateResult[] };
  return data.results;
}
