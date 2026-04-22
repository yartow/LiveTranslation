import { useState, useCallback } from 'react';

export type TranscriptionProvider = 'whisper' | 'browser';
export type TranslationProvider = 'openai' | 'claude' | 'none';

export interface AppSettings {
  openaiApiKey: string;
  anthropicApiKey: string;
  transcriptionProvider: TranscriptionProvider;
  translationProvider: TranslationProvider;
}

const PREFS_KEY = 'sermonscribe_prefs';

const defaultSettings: AppSettings = {
  openaiApiKey: '',
  anthropicApiKey: '',
  transcriptionProvider: 'whisper',
  translationProvider: 'openai',
};

const VALID_TRANSCRIPTION: TranscriptionProvider[] = ['whisper', 'browser'];
const VALID_TRANSLATION: TranslationProvider[] = ['openai', 'claude', 'none'];

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
