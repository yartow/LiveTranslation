import { useState, useCallback } from 'react';

export type TranscriptionProvider = 'whisper' | 'browser' | 'transformers';
export type TranslationProvider = 'openai' | 'claude' | 'none';
export type SpeechMode = 'monologue' | 'dialogue';
export type DisplayContent = 'original' | 'translation' | 'both';
export type TextDisplay = 'subtitle' | 'stream';
export type LocalWhisperModel = 'tiny' | 'small' | 'medium';

export interface AppSettings {
  openaiApiKey: string;
  anthropicApiKey: string;
  transcriptionProvider: TranscriptionProvider;
  translationProvider: TranslationProvider;
  speechMode: SpeechMode;
  displayContent: DisplayContent;
  textDisplay: TextDisplay;
  theologicalGlossary: string;
  localWhisperModel: LocalWhisperModel;
  defaultSourceLanguage: string;
  defaultTargetLanguage: string;
}

const PREFS_KEY = 'sermonscribe_prefs';

const defaultSettings: AppSettings = {
  openaiApiKey: '',
  anthropicApiKey: '',
  transcriptionProvider: 'whisper',
  translationProvider: 'openai',
  speechMode: 'monologue',
  displayContent: 'translation',
  textDisplay: 'subtitle',
  theologicalGlossary: '',
  localWhisperModel: 'tiny',
  defaultSourceLanguage: 'en',
  defaultTargetLanguage: 'nl',
};

const VALID_TRANSCRIPTION: TranscriptionProvider[] = ['whisper', 'browser', 'transformers'];
const VALID_TRANSLATION: TranslationProvider[] = ['openai', 'claude', 'none'];
const VALID_LOCAL_MODEL: LocalWhisperModel[] = ['tiny', 'small', 'medium'];

function loadSettings(): AppSettings {
  let prefs: Partial<AppSettings> = {};
  let keys: Partial<AppSettings> = {};

  try {
    const stored = localStorage.getItem(PREFS_KEY);
    if (stored) prefs = JSON.parse(stored);
  } catch {}

  try {
    const stored = sessionStorage.getItem(PREFS_KEY);
    if (stored) keys = JSON.parse(stored);
  } catch {}

  const merged = { ...defaultSettings, ...prefs, ...keys };

  // Validate enums; fall back to defaults for unrecognised values
  if (!VALID_TRANSCRIPTION.includes(merged.transcriptionProvider)) {
    merged.transcriptionProvider = defaultSettings.transcriptionProvider;
  }
  if (!VALID_TRANSLATION.includes(merged.translationProvider)) {
    merged.translationProvider = defaultSettings.translationProvider;
  }
  if (!VALID_LOCAL_MODEL.includes(merged.localWhisperModel)) {
    merged.localWhisperModel = defaultSettings.localWhisperModel;
  }

  return merged;
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const updateSettings = useCallback((updates: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...updates };

      // Provider preferences are not sensitive — persist across sessions
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({
          transcriptionProvider: next.transcriptionProvider,
          translationProvider: next.translationProvider,
          localWhisperModel: next.localWhisperModel,
          speechMode: next.speechMode,
          displayContent: next.displayContent,
          textDisplay: next.textDisplay,
          theologicalGlossary: next.theologicalGlossary,
          defaultSourceLanguage: next.defaultSourceLanguage,
          defaultTargetLanguage: next.defaultTargetLanguage,
        }));
      } catch {}

      // API keys are sensitive — use sessionStorage so they clear on tab close
      try {
        sessionStorage.setItem(PREFS_KEY, JSON.stringify({
          openaiApiKey: next.openaiApiKey,
          anthropicApiKey: next.anthropicApiKey,
        }));
      } catch {}

      return next;
    });
  }, []);

  return { settings, updateSettings };
}
