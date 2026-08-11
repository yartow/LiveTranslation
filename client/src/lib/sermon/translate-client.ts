// Thin client for POST /api/sermon/translate (server/routes.ts + server/lib/sermon-translate.ts).
// Kept separate from useTranslationQueue.ts so the hook's batching/debounce/
// staleness logic doesn't need to know about fetch or the wire format.

export interface TranslateItem {
  id: string;
  text: string;
  before: string[];
  after: string[];
}

export interface TranslateResultOk {
  id: string;
  status: 'ok';
  translation: string;
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
  /** Free-text glossary from settings.theologicalGlossary — the v1 glossary seam, see server/lib/sermon-prompt.ts. */
  glossary?: string;
  sermonContext?: string;
  signal?: AbortSignal;
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
      sermonContext: opts.sermonContext,
      items: items.map(i => ({ id: i.id, text: i.text, before: i.before, after: i.after })),
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Sermon translate request failed (${res.status})`);
  }

  const data = await res.json() as { results: TranslateResult[] };
  return data.results;
}
