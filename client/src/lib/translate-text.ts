import type { ChunkTranscriptionEvents, TranslationProvider } from './chunk-based-transcription';

export interface TranslateTextConfig {
  targetLanguage: string;
  detectSpeakers: boolean;
  translationProvider: TranslationProvider;
  openaiApiKey: string;
  anthropicApiKey: string;
  glossary: string;
  sermonContext: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

/**
 * Text-only correct + translate for the backends whose speech-to-text runs in
 * the browser (Web Speech API, local Whisper): POSTs to /api/translate and
 * reports through `onTranslation`. Any failure falls back to the untranslated
 * text, so a chunk of speech is never lost to a translation error.
 */
export async function translateRecognizedText(
  text: string,
  chunkIndex: number,
  config: TranslateTextConfig,
  events: Pick<ChunkTranscriptionEvents, 'onTranslation' | 'onError'>,
): Promise<void> {
  if (config.translationProvider === 'none') {
    events.onTranslation(text, '', chunkIndex);
    return;
  }

  try {
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        targetLanguage: config.targetLanguage,
        detectSpeakers: config.detectSpeakers,
        translationProvider: config.translationProvider,
        openaiApiKey: config.openaiApiKey,
        anthropicApiKey: config.anthropicApiKey,
        glossary: config.glossary || undefined,
        sermonContext: config.sermonContext || undefined,
        ollamaBaseUrl: config.ollamaBaseUrl || undefined,
        ollamaModel: config.ollamaModel || undefined,
      }),
    });

    if (!response.ok) {
      events.onError('Translation request failed');
      events.onTranslation(text, '', chunkIndex);
      return;
    }

    const data = await response.json();
    events.onTranslation(data.correctedText || text, data.translatedText || '', chunkIndex);
  } catch {
    events.onError('Translation failed — check your API key in Settings.');
    events.onTranslation(text, '', chunkIndex);
  }
}
