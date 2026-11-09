import { useEffect, useRef } from 'react';
import type { AppSettings } from '@/hooks/useSettings';
import type { TranslationRuntimeConfig } from '@/hooks/useTranslationQueue';
import type { IngestConfig } from '@/lib/sermon/ingest-buffer';
import { serviceContextForPrompt, plannedPassages } from '@/lib/sermon/service-context';

// A sermon row shorter than this holds for an extra half-window before it
// flushes alone — see ingest-buffer.ts's IngestConfig.minBlockWords.
const SERMON_MIN_BLOCK_WORDS = 12;

function buildTranslationConfig(settings: AppSettings): TranslationRuntimeConfig {
  return {
    sourceLanguage: settings.defaultSourceLanguage || 'nl',
    targetLanguage: settings.defaultTargetLanguage || 'en',
    translationProvider: settings.sermonTranslationProvider,
    model: settings.sermonModel,
    openaiApiKey: settings.openaiApiKey,
    anthropicApiKey: settings.anthropicApiKey,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    ollamaModel: settings.ollamaModel,
    glossary: settings.theologicalGlossary,
    glossaryCsv: settings.sermonGlossaryEnabled ? settings.sermonGlossaryCsv : undefined,
    disambiguationPrompt: settings.sermonGlossaryEnabled ? settings.sermonDisambiguationPrompt : undefined,
    bibleVersion: settings.sermonBibleVersion,
    deityCapitals: settings.sermonDeityCapitals,
    glossaryWarnings: settings.sermonGlossaryWarnings,
    scriptureEnabled: settings.sermonScriptureEnabled,
    esvApiKey: settings.esvApiKey,
    scriptureFallback: settings.sermonScriptureFallback,
    stabilityMs: settings.sermonStabilityMs,
    contextBefore: settings.sermonContextBefore,
    contextAfter: settings.sermonContextAfter,
    backTranslationCheck: settings.sermonBackTranslationCheck,
    backTranslationThreshold: settings.sermonBackTranslationThreshold,
    serviceContext: serviceContextForPrompt(settings.sermonServiceContext),
    plannedPassages: plannedPassages(settings.sermonServiceContext),
  };
}

function buildIngestConfig(settings: AppSettings): IngestConfig {
  return { maxLatencyMs: settings.sermonMaxLatencySecs * 1000, minBlockWords: SERMON_MIN_BLOCK_WORDS, showEarly: true };
}

/**
 * Settings (persisted, useSettings) is the single source of truth for both the
 * Sermon mode pages in SettingsDialog and the two most-used controls
 * duplicated inline in the toolbar (plan §"Risico's", point 5) — no separate
 * local state to fall out of sync with the dialog.
 *
 * Returns refs that are re-read every tick/dispatch: that is the whole
 * mechanism behind "a settings change takes effect on the next tick, no
 * restart" (AC9). See ingest-buffer.ts's evaluate() and useTranslationQueue.ts.
 */
export function useSermonRuntimeConfig(settings: AppSettings) {
  const autoTranslateRef = useRef(settings.sermonAutoTranslate);
  useEffect(() => { autoTranslateRef.current = settings.sermonAutoTranslate; }, [settings.sermonAutoTranslate]);

  const translationConfigRef = useRef<TranslationRuntimeConfig>(buildTranslationConfig(settings));
  useEffect(() => { translationConfigRef.current = buildTranslationConfig(settings); }, [settings]);

  const ingestConfigRef = useRef<IngestConfig>(buildIngestConfig(settings));
  useEffect(() => { ingestConfigRef.current = buildIngestConfig(settings); }, [settings.sermonMaxLatencySecs]); // eslint-disable-line react-hooks/exhaustive-deps

  return { autoTranslateRef, translationConfigRef, ingestConfigRef };
}
