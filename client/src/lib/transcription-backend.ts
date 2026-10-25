import type { TranslationProvider } from './chunk-based-transcription';

/**
 * What Live mode (Home.tsx) needs from any speech-to-text backend. The optional
 * methods exist only on backends that capture and chunk audio themselves; a
 * caller uses `backend.setX?.(…)` instead of checking which class it holds.
 */
export interface TranscriptionBackend {
  stop(): Promise<void>;
  /** Pushes changed settings to a running session; backends ignore the fields they have no use for. */
  updateConfig(
    sourceLanguage: string,
    targetLanguage: string,
    detectSpeakers: boolean,
    translationProvider?: TranslationProvider,
    openaiApiKey?: string,
    anthropicApiKey?: string,
    glossary?: string,
    sermonContext?: string,
    ollamaBaseUrl?: string,
    ollamaModel?: string,
  ): void;
  setNormalizationGain?(gain: number): void;
  /** Tail of the transcript so far, used as Whisper context for the next chunk. */
  setPreviousTranscript?(text: string): void;
  setChunkDuration?(ms: number): void;
  setVADThreshold?(ms: number): void;
}
