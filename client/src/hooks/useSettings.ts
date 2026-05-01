import { useState, useCallback } from 'react';

export type TranscriptionProvider = 'whisper' | 'browser';
export type TranslationProvider = 'openai' | 'claude' | 'none';
export type SpeechMode = 'monologue' | 'dialogue';
export type DisplayContent = 'original' | 'translation' | 'both';
export type TextDisplay = 'subtitle' | 'stream';

export interface AppSettings {
  openaiApiKey: string;
  anthropicApiKey: string;
  transcriptionProvider: TranscriptionProvider;
  translationProvider: TranslationProvider;
  speechMode: SpeechMode;
  displayContent: DisplayContent;
  textDisplay: TextDisplay;
}

const STORAGE_KEY = 'sermonscribe_settings';

const defaultSettings: AppSettings = {
  openaiApiKey: '',
  anthropicApiKey: '',
  transcriptionProvider: 'whisper',
  translationProvider: 'openai',
  speechMode: 'monologue',
  displayContent: 'translation',
  textDisplay: 'subtitle',
};

function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...defaultSettings, ...JSON.parse(stored) };
    }
  } catch {
    // Ignore parse errors — start fresh
  }
  return { ...defaultSettings };
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const updateSettings = useCallback((updates: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...updates };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage quota exceeded or private browsing — silently continue
      }
      return next;
    });
  }, []);

  return { settings, updateSettings };
}
