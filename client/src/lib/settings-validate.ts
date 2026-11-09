// Turns whatever was found in localStorage/sessionStorage into a well-formed
// AppSettings: unknown enum values, wrong types and out-of-range numbers fall
// back to (or are clamped toward) the defaults. Pure — hooks/useSettings.ts
// does the storage reads and hands the merged object here.

import { normalizeServiceContext } from '@/lib/sermon/service-context';
import type { AppSettings } from '@/hooks/useSettings';

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

function clampedNumber(value: unknown, fallback: number, min: number, max: number, round = false): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return clamp(round ? Math.round(value) : value, min, max);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

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

export function sanitizeSettings(merged: AppSettings, defaults: AppSettings): AppSettings {
  const s: AppSettings = { ...merged };

  s.transcriptionProvider = oneOf(s.transcriptionProvider, ['whisper', 'browser', 'transformers', 'mlx'], defaults.transcriptionProvider);
  s.translationProvider = oneOf(s.translationProvider, ['openai', 'claude', 'ollama', 'none'], defaults.translationProvider);
  s.improvementProvider = oneOf(s.improvementProvider, ['openai', 'claude'], defaults.improvementProvider);
  s.localWhisperModel = oneOf(s.localWhisperModel, ['tiny', 'small', 'medium'], defaults.localWhisperModel);
  if (typeof s.defaultLookbackChars !== 'number' || s.defaultLookbackChars < 100) {
    s.defaultLookbackChars = defaults.defaultLookbackChars;
  }

  // Audio pipeline
  if (![0, 500, 1000].includes(s.chunkOverlapMs)) s.chunkOverlapMs = defaults.chunkOverlapMs;
  s.vadSilenceThresholdMs = clampedNumber(s.vadSilenceThresholdMs, defaults.vadSilenceThresholdMs, 200, 2000);
  s.audioNormalizationGain = clampedNumber(s.audioNormalizationGain, defaults.audioNormalizationGain, 0.1, 10);
  s.assemblyEndOfTurnThreshold = clampedNumber(s.assemblyEndOfTurnThreshold, defaults.assemblyEndOfTurnThreshold, 0.5, 1.0);
  s.assemblyTurnSilenceMs = clampedNumber(s.assemblyTurnSilenceMs, defaults.assemblyTurnSilenceMs, 200, 2000);
  if (typeof s.micDeviceId !== 'string' || s.micDeviceId.length > 512) s.micDeviceId = defaults.micDeviceId;
  if (!Array.isArray(s.deviceProfiles)) s.deviceProfiles = [];

  // Sermon mode
  s.sermonMaxLatencySecs = clampedNumber(s.sermonMaxLatencySecs, defaults.sermonMaxLatencySecs, 3, 20);
  s.sermonStabilityMs = clampedNumber(s.sermonStabilityMs, defaults.sermonStabilityMs, 300, 5000);
  s.sermonContextBefore = clampedNumber(s.sermonContextBefore, defaults.sermonContextBefore, 0, 5, true);
  s.sermonContextAfter = clampedNumber(s.sermonContextAfter, defaults.sermonContextAfter, 0, 3, true);
  s.sermonTranslationProvider = oneOf(s.sermonTranslationProvider, ['openai', 'claude', 'ollama'], defaults.sermonTranslationProvider);
  s.sermonCorrectionProvider = oneOf(s.sermonCorrectionProvider, ['openai', 'claude', 'ollama'], defaults.sermonCorrectionProvider);
  if (typeof s.sermonModel !== 'string' || !s.sermonModel.trim() || s.sermonModel.length > 80) {
    s.sermonModel = defaults.sermonModel;
  }
  s.sermonAsrCorrection = boolOr(s.sermonAsrCorrection, defaults.sermonAsrCorrection);
  s.sermonAutoTranslate = boolOr(s.sermonAutoTranslate, defaults.sermonAutoTranslate);
  s.sermonBackTranslationCheck = boolOr(s.sermonBackTranslationCheck, defaults.sermonBackTranslationCheck);
  s.sermonBackTranslationThreshold = clampedNumber(s.sermonBackTranslationThreshold, defaults.sermonBackTranslationThreshold, 0.05, 0.6);

  // Sermon mode — file-based glossary
  s.sermonGlossaryEnabled = boolOr(s.sermonGlossaryEnabled, defaults.sermonGlossaryEnabled);
  if (!isPlausibleGlossaryFilename(s.sermonGlossaryCsv, '.csv')) s.sermonGlossaryCsv = defaults.sermonGlossaryCsv;
  if (!isPlausibleGlossaryFilename(s.sermonDisambiguationPrompt, '.md')) s.sermonDisambiguationPrompt = defaults.sermonDisambiguationPrompt;
  s.sermonBibleVersion = oneOf(s.sermonBibleVersion, ['KJV', 'ESV', 'LSB', 'NASB', 'NKJV'], defaults.sermonBibleVersion);
  s.sermonDeityCapitals = boolOr(s.sermonDeityCapitals, defaults.sermonDeityCapitals);
  s.sermonGlossaryWarnings = boolOr(s.sermonGlossaryWarnings, defaults.sermonGlossaryWarnings);

  // Sermon mode — Bible-quote pipeline
  s.sermonScriptureEnabled = boolOr(s.sermonScriptureEnabled, defaults.sermonScriptureEnabled);
  if (typeof s.esvApiKey !== 'string') s.esvApiKey = defaults.esvApiKey;
  s.sermonScriptureFallback = oneOf(s.sermonScriptureFallback, ['kjv', 'none'], defaults.sermonScriptureFallback);
  s.sermonServiceContext = normalizeServiceContext(s.sermonServiceContext);

  return s;
}
