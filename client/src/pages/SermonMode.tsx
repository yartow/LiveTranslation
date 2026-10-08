import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Header from '@/components/Header';
import SermonToolbar from '@/components/sermon/SermonToolbar';
import SegmentGrid from '@/components/sermon/SegmentGrid';
import SettingsDialog from '@/components/SettingsDialog';
import { useToast } from '@/hooks/use-toast';
import { useSettings } from '@/hooks/useSettings';
import { segmentReducer, initState, selectDirtyIds, type SegmentAction } from '@/lib/sermon/segment-store';
import { isRefreshAllChord, isRefreshOneChord, type KeyChord } from '@/lib/sermon/hotkeys';
import { useTranslationQueue, type TranslationRuntimeConfig } from '@/hooks/useTranslationQueue';
import { useSermonIngest } from '@/hooks/useSermonIngest';
import { useListenerBroadcast } from '@/hooks/useListenerBroadcast';
import type { IngestConfig } from '@/lib/sermon/ingest-buffer';
import { isMacPlatform } from '@/lib/platform';

// A sermon row shorter than this holds for an extra half-window before it
// flushes alone — see ingest-buffer.ts's IngestConfig.minBlockWords.
const SERMON_MIN_BLOCK_WORDS = 12;

// Sermon mode is its own page/route ("/", see App.tsx) rather than a mode of
// Home.tsx — Home's TranscriptionSegment model is chunk-level, id-less, and
// flattened to one element by every correction path, so it can't carry the
// per-sentence identity this feature depends on. See the plan doc for the
// full rationale. This does mean recording/audio-level plumbing is
// duplicated rather than shared with Home.tsx — accepted as known debt for v1.

export default function SermonMode() {
  const { settings, updateSettings } = useSettings();
  const { toast } = useToast();

  const sessionIdRef = useRef(`s${Date.now().toString(36)}`);
  const [state, dispatch] = useReducer(segmentReducer, sessionIdRef.current, initState);

  // A ref mirror of `state`, kept authoritative two ways: (1) every action
  // dispatched through applyAction below applies the same pure reducer to it
  // synchronously, so code that flushes a pending edit and immediately reads
  // segment text in the same synchronous tick (see useTranslationQueue.ts's
  // runBatch) sees the edit right away — a plain `useReducer` dispatch alone
  // only takes effect on the next render, one tick later. (2) it's also
  // reassigned from `state` on every render as a fallback, so it can never
  // drift even if some future code path dispatches through the raw reducer
  // dispatch instead of applyAction.
  const stateRef = useRef(state);
  stateRef.current = state;

  const applyAction = useCallback((action: SegmentAction) => {
    stateRef.current = segmentReducer(stateRef.current, action);
    dispatch(action);
  }, [dispatch]);

  // Registry of per-segment "flush the pending debounced source edit now"
  // callbacks, populated by SourceCell. A manual Refresh (button or hotkey)
  // calls these before reading segment text — see useTranslationQueue.ts.
  const flushersRef = useRef(new Map<string, () => void>());

  const activeSegmentIdRef = useRef<string | null>(null);
  const [isDark, setIsDark] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Settings (persisted, useSettings) is the single source of truth for both
  // the full "Preekmodus" section in SettingsDialog and the two most-used
  // controls duplicated inline in the toolbar (plan §"Risico's", point 5) —
  // no separate local state to fall out of sync with the dialog.
  const autoTranslateRef = useRef(settings.sermonAutoTranslate);
  useEffect(() => { autoTranslateRef.current = settings.sermonAutoTranslate; }, [settings.sermonAutoTranslate]);

  // Single ref, re-read every tick/dispatch — this is the whole mechanism
  // behind "a settings change takes effect on the next tick, no restart"
  // (AC9). See ingest-buffer.ts's evaluate() and useTranslationQueue.ts.
  const buildTranslationConfig = (): TranslationRuntimeConfig => ({
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
  });
  const translationConfigRef = useRef<TranslationRuntimeConfig>(buildTranslationConfig());
  useEffect(() => { translationConfigRef.current = buildTranslationConfig(); }, [settings]);

  const ingestConfigRef = useRef<IngestConfig>({ maxLatencyMs: settings.sermonMaxLatencySecs * 1000, minBlockWords: SERMON_MIN_BLOCK_WORDS });
  useEffect(() => {
    ingestConfigRef.current = { maxLatencyMs: settings.sermonMaxLatencySecs * 1000, minBlockWords: SERMON_MIN_BLOCK_WORDS };
  }, [settings.sermonMaxLatencySecs]);

  const { refreshAll, refreshOne } = useTranslationQueue(stateRef, applyAction, translationConfigRef, autoTranslateRef, flushersRef);

  // Listener mode (CLAUDE.md "Listener mode") — pushes finished translations
  // to any connected phones. Reads `state` directly (not stateRef) so it
  // re-runs its diff on every render, same as the dirtyCount useMemo below.
  const { listenerCount } = useListenerBroadcast(stateRef, state);

  const { isRecording, isProcessing, start, stop } = useSermonIngest({
    dispatch: applyAction,
    stateRef,
    ingestConfigRef,
    sourceLanguage: settings.defaultSourceLanguage || 'nl',
    targetLanguage: settings.defaultTargetLanguage || 'en',
    engine: settings.transcriptionProvider === 'mlx' ? 'mlx' : 'openai',
    correctionProvider: settings.sermonCorrectionProvider,
    asrCorrection: settings.sermonAsrCorrection,
    openaiApiKey: settings.openaiApiKey,
    anthropicApiKey: settings.anthropicApiKey,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    ollamaModel: settings.ollamaModel,
    glossary: settings.theologicalGlossary,
    debugMode: settings.debugMode,
    normalizationGain: settings.audioNormalizationGain,
    rawAudioCapture: settings.rawAudioCapture,
    onError: (message) => toast({ title: 'Opnamefout', description: message, variant: 'destructive' }),
  });

  const dirtyCount = useMemo(() => selectDirtyIds(state).length, [state]);

  // Cmd/Ctrl+Shift+Enter (refresh all) and Cmd/Ctrl+Enter (refresh the
  // segment under the cursor) — capture phase on window so preventDefault
  // wins even while the cursor is inside a source textarea (AC10). See
  // hotkeys.ts for the chord predicates and the plan §7 for why capture.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      const chord: KeyChord = { metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, code: e.code };
      if (isRefreshAllChord(chord)) {
        e.preventDefault(); e.stopPropagation();
        refreshAll();
      } else if (isRefreshOneChord(chord)) {
        e.preventDefault(); e.stopPropagation();
        refreshOne(activeSegmentIdRef.current);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [refreshAll, refreshOne]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  return (
    <div className="flex flex-col h-screen bg-background">
      <Header isDark={isDark} onThemeToggle={() => setIsDark(d => !d)} onSettingsOpen={() => setIsSettingsOpen(true)} />
      <SermonToolbar
        isRecording={isRecording}
        isProcessing={isProcessing}
        onToggleRecording={() => {
          if (isRecording) {
            stop().catch((err) => toast({ title: 'Opnamefout', description: err instanceof Error ? err.message : 'Kon opname niet stoppen', variant: 'destructive' }));
          } else {
            start();
          }
        }}
        dirtyCount={dirtyCount}
        onRefreshAll={refreshAll}
        autoTranslate={settings.sermonAutoTranslate}
        onToggleAutoTranslate={(v) => updateSettings({ sermonAutoTranslate: v })}
        maxLatencySecs={settings.sermonMaxLatencySecs}
        onChangeMaxLatencySecs={(v) => updateSettings({ sermonMaxLatencySecs: v })}
        listenerCount={listenerCount}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isMac={isMacPlatform}
      />
      <SegmentGrid
        state={state}
        dispatch={applyAction}
        activeSegmentIdRef={activeSegmentIdRef}
        onRefreshOne={refreshOne}
        flushersRef={flushersRef}
      />
      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdate={updateSettings}
      />
    </div>
  );
}
