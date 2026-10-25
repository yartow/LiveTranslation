import { useState, useCallback } from 'react';
import { EMPTY_SERVICE_CONTEXT, type ServiceContext } from '@/lib/sermon/service-context';
import { sanitizeSettings } from '@/lib/settings-validate';

export type TranscriptionProvider = 'whisper' | 'browser' | 'transformers' | 'mlx';
export type TranslationProvider = 'openai' | 'claude' | 'ollama' | 'none';
export type ImprovementProvider = 'openai' | 'claude';
export type SpeechMode = 'monologue' | 'dialogue';
export type DisplayContent = 'original' | 'translation' | 'both';
export type TextDisplay = 'subtitle' | 'stream';
export type LocalWhisperModel = 'tiny' | 'small' | 'medium';
// Sermon mode never offers 'none' — a correction/translation call is always required there.
export type SermonTranslationProvider = 'openai' | 'claude' | 'ollama';
export type SermonBibleVersion = 'KJV' | 'ESV' | 'LSB' | 'NASB' | 'NKJV';
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
  // Microphone to record from: a deviceId from enumerateDevices(); '' = the system default input.
  micDeviceId: string;
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
  // Translate every result back to Dutch and flag lines that drift (a second model call per segment).
  sermonBackTranslationCheck: boolean;
  // Flagged when the back-translation's similarity to the source is below this (0.05-0.6).
  sermonBackTranslationThreshold: number;
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
  // sermon mode — "Today's service" (title, passages, names/terms, notes). sessionStorage, not localStorage:
  // it is about THIS service, and must not silently bias next week's.
  sermonServiceContext: ServiceContext;
}

const PREFS_KEY = 'cttay_prefs';

export const defaultSettings: AppSettings = {
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
  micDeviceId: '',
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
  sermonBackTranslationCheck: false,
  sermonBackTranslationThreshold: 0.2,
  sermonGlossaryEnabled: true,
  sermonGlossaryCsv: 'preek_woordenlijst_NL_EN_1.csv',
  sermonDisambiguationPrompt: 'context_afhankelijke_termen_prompt_v2.md',
  sermonBibleVersion: 'ESV',
  sermonDeityCapitals: false,
  sermonGlossaryWarnings: true,
  sermonScriptureEnabled: true,
  esvApiKey: '',
  sermonScriptureFallback: 'kjv',
  sermonServiceContext: EMPTY_SERVICE_CONTEXT,
};

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

  return sanitizeSettings({ ...defaultSettings, ...prefs, ...keys }, defaultSettings);
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
          micDeviceId: next.micDeviceId,
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
          sermonBackTranslationCheck: next.sermonBackTranslationCheck,
          sermonBackTranslationThreshold: next.sermonBackTranslationThreshold,
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
          sermonServiceContext: next.sermonServiceContext,
        }));
      } catch {}

      return next;
    });
  }, []);

  return { settings, updateSettings };
}
