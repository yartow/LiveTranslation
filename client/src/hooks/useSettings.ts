import { useState, useCallback } from 'react';

export type TranscriptionProvider = 'whisper' | 'browser' | 'transformers';
export type TranslationProvider = 'openai' | 'claude' | 'none';
export type ImprovementProvider = 'openai' | 'claude';
export type SpeechMode = 'monologue' | 'dialogue';
export type DisplayContent = 'original' | 'translation' | 'both';
export type TextDisplay = 'subtitle' | 'stream';
export type LocalWhisperModel = 'tiny' | 'small' | 'medium';

export interface DeviceProfile {
  id: string;
  name: string;
  externalMic: boolean;
  micDeviceId?: string;
  // audio settings snapshot
  audioNormalizationGain: number;
  chunkOverlapMs: number;
  useVADChunking: boolean;
  vadSilenceThresholdMs: number;
  assemblyEndOfTurnThreshold: number;
  assemblyTurnSilenceMs: number;
  useTranscriptAsWhisperContext: boolean;
  chunkDurationSecs: number;
}

export interface AppSettings {
  openaiApiKey: string;
  anthropicApiKey: string;
  transcriptionProvider: TranscriptionProvider;
  translationProvider: TranslationProvider;
  improvementProvider: ImprovementProvider;
  defaultLookbackChars: number;
  speechMode: SpeechMode;
  displayContent: DisplayContent;
  textDisplay: TextDisplay;
  theologicalGlossary: string;
  localWhisperModel: LocalWhisperModel;
  defaultSourceLanguage: string;
  defaultTargetLanguage: string;
  debugMode: boolean;
  // audio pipeline
  useTranscriptAsWhisperContext: boolean;
  chunkOverlapMs: number;
  useVADChunking: boolean;
  vadSilenceThresholdMs: number;
  audioNormalizationGain: number;
  showAdvancedAudioDuringRecording: boolean;
  // AssemblyAI tuning (applied at session start)
  assemblyEndOfTurnThreshold: number;
  assemblyTurnSilenceMs: number;
  // device profiles
  deviceProfiles: DeviceProfile[];
  activeDeviceProfileId: string | null;
}

const PREFS_KEY = 'cttay_prefs';

const defaultSettings: AppSettings = {
  openaiApiKey: '',
  anthropicApiKey: '',
  transcriptionProvider: 'whisper',
  translationProvider: 'openai',
  improvementProvider: 'openai',
  defaultLookbackChars: 1000,
  speechMode: 'monologue',
  displayContent: 'translation',
  textDisplay: 'subtitle',
  theologicalGlossary: '',
  localWhisperModel: 'tiny',
  defaultSourceLanguage: 'en',
  defaultTargetLanguage: 'nl',
  debugMode: false,
  useTranscriptAsWhisperContext: true,
  chunkOverlapMs: 500,
  useVADChunking: false,
  vadSilenceThresholdMs: 800,
  audioNormalizationGain: 1.0,
  showAdvancedAudioDuringRecording: false,
  assemblyEndOfTurnThreshold: 0.7,
  assemblyTurnSilenceMs: 700,
  deviceProfiles: [],
  activeDeviceProfileId: null,
};

const VALID_TRANSCRIPTION: TranscriptionProvider[] = ['whisper', 'browser', 'transformers'];
const VALID_TRANSLATION: TranslationProvider[] = ['openai', 'claude', 'none'];
const VALID_IMPROVEMENT: ImprovementProvider[] = ['openai', 'claude'];
const VALID_LOCAL_MODEL: LocalWhisperModel[] = ['tiny', 'small', 'medium'];

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

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
  if (!VALID_IMPROVEMENT.includes(merged.improvementProvider)) {
    merged.improvementProvider = defaultSettings.improvementProvider;
  }
  if (!VALID_LOCAL_MODEL.includes(merged.localWhisperModel)) {
    merged.localWhisperModel = defaultSettings.localWhisperModel;
  }
  if (typeof merged.defaultLookbackChars !== 'number' || merged.defaultLookbackChars < 100) {
    merged.defaultLookbackChars = defaultSettings.defaultLookbackChars;
  }
  // Audio pipeline range validation
  if (![0, 500, 1000].includes(merged.chunkOverlapMs)) {
    merged.chunkOverlapMs = defaultSettings.chunkOverlapMs;
  }
  if (typeof merged.vadSilenceThresholdMs !== 'number') {
    merged.vadSilenceThresholdMs = defaultSettings.vadSilenceThresholdMs;
  } else {
    merged.vadSilenceThresholdMs = clamp(merged.vadSilenceThresholdMs, 200, 2000);
  }
  if (typeof merged.audioNormalizationGain !== 'number') {
    merged.audioNormalizationGain = defaultSettings.audioNormalizationGain;
  } else {
    merged.audioNormalizationGain = clamp(merged.audioNormalizationGain, 0.1, 10);
  }
  if (typeof merged.assemblyEndOfTurnThreshold !== 'number') {
    merged.assemblyEndOfTurnThreshold = defaultSettings.assemblyEndOfTurnThreshold;
  } else {
    merged.assemblyEndOfTurnThreshold = clamp(merged.assemblyEndOfTurnThreshold, 0.5, 1.0);
  }
  if (typeof merged.assemblyTurnSilenceMs !== 'number') {
    merged.assemblyTurnSilenceMs = defaultSettings.assemblyTurnSilenceMs;
  } else {
    merged.assemblyTurnSilenceMs = clamp(merged.assemblyTurnSilenceMs, 200, 2000);
  }
  if (!Array.isArray(merged.deviceProfiles)) {
    merged.deviceProfiles = [];
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
          improvementProvider: next.improvementProvider,
          defaultLookbackChars: next.defaultLookbackChars,
          localWhisperModel: next.localWhisperModel,
          speechMode: next.speechMode,
          displayContent: next.displayContent,
          textDisplay: next.textDisplay,
          theologicalGlossary: next.theologicalGlossary,
          defaultSourceLanguage: next.defaultSourceLanguage,
          defaultTargetLanguage: next.defaultTargetLanguage,
          debugMode: next.debugMode,
          useTranscriptAsWhisperContext: next.useTranscriptAsWhisperContext,
          chunkOverlapMs: next.chunkOverlapMs,
          useVADChunking: next.useVADChunking,
          vadSilenceThresholdMs: next.vadSilenceThresholdMs,
          audioNormalizationGain: next.audioNormalizationGain,
          showAdvancedAudioDuringRecording: next.showAdvancedAudioDuringRecording,
          assemblyEndOfTurnThreshold: next.assemblyEndOfTurnThreshold,
          assemblyTurnSilenceMs: next.assemblyTurnSilenceMs,
          deviceProfiles: next.deviceProfiles,
          activeDeviceProfileId: next.activeDeviceProfileId,
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
