import { useState, useCallback } from 'react';

export type TranscriptionProvider = 'whisper' | 'browser' | 'transformers' | 'mlx';
export type TranslationProvider = 'openai' | 'claude' | 'ollama' | 'none';
export type ImprovementProvider = 'openai' | 'claude';
export type SpeechMode = 'monologue' | 'dialogue';
export type DisplayContent = 'original' | 'translation' | 'both';
export type TextDisplay = 'subtitle' | 'stream';
export type LocalWhisperModel = 'tiny' | 'small' | 'medium';
// Sermon mode never offers 'none' — a correction/translation call is always required there.
export type SermonTranslationProvider = 'openai' | 'claude' | 'ollama';
export type SermonBibleVersion = 'KJV' | 'ESV' | 'NASB' | 'NKJV';
export type SermonScriptureFallback = 'kjv' | 'none';

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
  // local Ollama
  ollamaBaseUrl: string;
  ollamaModel: string;
  // audio pipeline
  // Capture the mic without the browser's echo-cancel / noise-suppress / auto-gain
  // (they hurt Whisper — see chunk-based-transcription.ts).
  rawAudioCapture: boolean;
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
  // sermon mode — see client/src/pages/SermonMode.tsx
  sermonMaxLatencySecs: number;
  sermonStabilityMs: number;
  sermonContextBefore: number;
  sermonContextAfter: number;
  sermonTranslationProvider: SermonTranslationProvider;
  sermonModel: string;
  sermonCorrectionProvider: SermonTranslationProvider;
  // Run the per-chunk LLM correction pass on live ASR text. Off = use Whisper's
  // own text as-is (faster, no risk of the model rewriting correct words).
  sermonAsrCorrection: boolean;
  sermonAutoTranslate: boolean;
  // sermon mode — file-based glossary (see server/lib/glossary-store.ts)
  sermonGlossaryEnabled: boolean;
  sermonGlossaryCsv: string;
  sermonDisambiguationPrompt: string;
  sermonBibleVersion: SermonBibleVersion;
  sermonDeityCapitals: boolean;
  sermonGlossaryWarnings: boolean;
  // sermon mode — Bible-quote pipeline (see server/lib/scripture.ts, CLAUDE.md "Scripture pipeline")
  sermonScriptureEnabled: boolean;
  esvApiKey: string; // sessionStorage, like openaiApiKey/anthropicApiKey
  sermonScriptureFallback: SermonScriptureFallback;
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
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'qwen3.6:latest',
  rawAudioCapture: true,
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
  // 10s target block duration — see ingest-buffer.ts and useSermonIngest.ts's
  // SERMON_VAD_SILENCE_MS. A 6s default produced short, choppy segments;
  // an existing localStorage profile keeps its stored value across this
  // change (the useSettings migration below only clamps, never bumps it).
  sermonMaxLatencySecs: 10,
  sermonStabilityMs: 1200,
  sermonContextBefore: 2,
  sermonContextAfter: 1,
  sermonTranslationProvider: 'openai',
  sermonModel: 'gpt-4o-mini',
  sermonCorrectionProvider: 'openai',
  sermonAsrCorrection: true,
  sermonAutoTranslate: true,
  sermonGlossaryEnabled: true,
  sermonGlossaryCsv: 'preek_woordenlijst_NL_EN_1.csv',
  sermonDisambiguationPrompt: 'context_afhankelijke_termen_prompt_v2.md',
  sermonBibleVersion: 'ESV',
  sermonDeityCapitals: false,
  sermonGlossaryWarnings: true,
  sermonScriptureEnabled: true,
  esvApiKey: '',
  sermonScriptureFallback: 'kjv',
};

const VALID_TRANSCRIPTION: TranscriptionProvider[] = ['whisper', 'browser', 'transformers', 'mlx'];
const VALID_TRANSLATION: TranslationProvider[] = ['openai', 'claude', 'ollama', 'none'];
const VALID_IMPROVEMENT: ImprovementProvider[] = ['openai', 'claude'];
const VALID_LOCAL_MODEL: LocalWhisperModel[] = ['tiny', 'small', 'medium'];
const VALID_SERMON_PROVIDER: SermonTranslationProvider[] = ['openai', 'claude', 'ollama'];
const VALID_BIBLE_VERSION: SermonBibleVersion[] = ['KJV', 'ESV', 'NASB', 'NKJV'];
const VALID_SCRIPTURE_FALLBACK: SermonScriptureFallback[] = ['kjv', 'none'];

// A glossary filename must match server/lib/glossary-file.ts's isSafeGlossaryName
// contract (no path separators, no traversal, correct extension) — validated
// again server-side since this is only a client-side usability guard.
function isPlausibleGlossaryFilename(name: unknown, ext: string): name is string {
  return typeof name === 'string'
    && name.trim().length > 0
    && name.length <= 128
    && !name.includes('/') && !name.includes('\\') && !name.includes('..')
    && name.toLowerCase().endsWith(ext);
}

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

  // Sermon mode range/enum validation
  if (typeof merged.sermonMaxLatencySecs !== 'number') {
    merged.sermonMaxLatencySecs = defaultSettings.sermonMaxLatencySecs;
  } else {
    merged.sermonMaxLatencySecs = clamp(merged.sermonMaxLatencySecs, 3, 20);
  }
  if (typeof merged.sermonStabilityMs !== 'number') {
    merged.sermonStabilityMs = defaultSettings.sermonStabilityMs;
  } else {
    merged.sermonStabilityMs = clamp(merged.sermonStabilityMs, 300, 5000);
  }
  if (typeof merged.sermonContextBefore !== 'number') {
    merged.sermonContextBefore = defaultSettings.sermonContextBefore;
  } else {
    merged.sermonContextBefore = clamp(Math.round(merged.sermonContextBefore), 0, 5);
  }
  if (typeof merged.sermonContextAfter !== 'number') {
    merged.sermonContextAfter = defaultSettings.sermonContextAfter;
  } else {
    merged.sermonContextAfter = clamp(Math.round(merged.sermonContextAfter), 0, 3);
  }
  if (!VALID_SERMON_PROVIDER.includes(merged.sermonTranslationProvider)) {
    merged.sermonTranslationProvider = defaultSettings.sermonTranslationProvider;
  }
  if (!VALID_SERMON_PROVIDER.includes(merged.sermonCorrectionProvider)) {
    merged.sermonCorrectionProvider = defaultSettings.sermonCorrectionProvider;
  }
  if (typeof merged.sermonModel !== 'string' || !merged.sermonModel.trim() || merged.sermonModel.length > 80) {
    merged.sermonModel = defaultSettings.sermonModel;
  }
  if (typeof merged.sermonAsrCorrection !== 'boolean') {
    merged.sermonAsrCorrection = defaultSettings.sermonAsrCorrection;
  }
  if (typeof merged.sermonAutoTranslate !== 'boolean') {
    merged.sermonAutoTranslate = defaultSettings.sermonAutoTranslate;
  }

  // Sermon mode — file-based glossary validation
  if (typeof merged.sermonGlossaryEnabled !== 'boolean') {
    merged.sermonGlossaryEnabled = defaultSettings.sermonGlossaryEnabled;
  }
  if (!isPlausibleGlossaryFilename(merged.sermonGlossaryCsv, '.csv')) {
    merged.sermonGlossaryCsv = defaultSettings.sermonGlossaryCsv;
  }
  if (!isPlausibleGlossaryFilename(merged.sermonDisambiguationPrompt, '.md')) {
    merged.sermonDisambiguationPrompt = defaultSettings.sermonDisambiguationPrompt;
  }
  if (!VALID_BIBLE_VERSION.includes(merged.sermonBibleVersion)) {
    merged.sermonBibleVersion = defaultSettings.sermonBibleVersion;
  }
  if (typeof merged.sermonDeityCapitals !== 'boolean') {
    merged.sermonDeityCapitals = defaultSettings.sermonDeityCapitals;
  }
  if (typeof merged.sermonGlossaryWarnings !== 'boolean') {
    merged.sermonGlossaryWarnings = defaultSettings.sermonGlossaryWarnings;
  }

  // Sermon mode — Bible-quote pipeline validation
  if (typeof merged.sermonScriptureEnabled !== 'boolean') {
    merged.sermonScriptureEnabled = defaultSettings.sermonScriptureEnabled;
  }
  if (typeof merged.esvApiKey !== 'string') {
    merged.esvApiKey = defaultSettings.esvApiKey;
  }
  if (!VALID_SCRIPTURE_FALLBACK.includes(merged.sermonScriptureFallback)) {
    merged.sermonScriptureFallback = defaultSettings.sermonScriptureFallback;
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
          ollamaBaseUrl: next.ollamaBaseUrl,
          ollamaModel: next.ollamaModel,
          rawAudioCapture: next.rawAudioCapture,
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
          sermonMaxLatencySecs: next.sermonMaxLatencySecs,
          sermonStabilityMs: next.sermonStabilityMs,
          sermonContextBefore: next.sermonContextBefore,
          sermonContextAfter: next.sermonContextAfter,
          sermonTranslationProvider: next.sermonTranslationProvider,
          sermonModel: next.sermonModel,
          sermonCorrectionProvider: next.sermonCorrectionProvider,
          sermonAsrCorrection: next.sermonAsrCorrection,
          sermonAutoTranslate: next.sermonAutoTranslate,
          sermonGlossaryEnabled: next.sermonGlossaryEnabled,
          sermonGlossaryCsv: next.sermonGlossaryCsv,
          sermonDisambiguationPrompt: next.sermonDisambiguationPrompt,
          sermonBibleVersion: next.sermonBibleVersion,
          sermonDeityCapitals: next.sermonDeityCapitals,
          sermonGlossaryWarnings: next.sermonGlossaryWarnings,
          sermonScriptureEnabled: next.sermonScriptureEnabled,
          sermonScriptureFallback: next.sermonScriptureFallback,
        }));
      } catch {}

      // API keys are sensitive — use sessionStorage so they clear on tab close
      try {
        sessionStorage.setItem(PREFS_KEY, JSON.stringify({
          openaiApiKey: next.openaiApiKey,
          anthropicApiKey: next.anthropicApiKey,
          esvApiKey: next.esvApiKey,
        }));
      } catch {}

      return next;
    });
  }, []);

  return { settings, updateSettings };
}
