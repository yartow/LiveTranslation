import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Header from '@/components/Header';
import SermonToolbar from '@/components/sermon/SermonToolbar';
import SegmentGrid from '@/components/sermon/SegmentGrid';
import SettingsDialog from '@/components/SettingsDialog';
import { useToast } from '@/hooks/use-toast';
import { useSettings } from '@/hooks/useSettings';
import { segmentReducer, initState, selectDirtyIds } from '@/lib/sermon/segment-store';
import { isRefreshAllChord, isRefreshOneChord, type KeyChord } from '@/lib/sermon/hotkeys';
import { useTranslationQueue, type TranslationRuntimeConfig } from '@/hooks/useTranslationQueue';
import { useSermonIngest } from '@/hooks/useSermonIngest';
import type { IngestConfig } from '@/lib/sermon/ingest-buffer';

// Sermon mode is its own page/route (/sermon) rather than a mode of Home.tsx
// — Home's TranscriptionSegment model is chunk-level, id-less, and flattened
// to one element by every correction path, so it can't carry the per-
// sentence identity this feature depends on. See the plan doc for the full
// rationale. This does mean recording/audio-level plumbing is duplicated
// rather than shared with Home.tsx — accepted as known debt for v1.

const isMacPlatform = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform || '');

export default function SermonMode() {
  const { settings, updateSettings } = useSettings();
  const { toast } = useToast();

  const sessionIdRef = useRef(`s${Date.now().toString(36)}`);
  const [state, dispatch] = useReducer(segmentReducer, sessionIdRef.current, initState);

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
    stabilityMs: settings.sermonStabilityMs,
    contextBefore: settings.sermonContextBefore,
    contextAfter: settings.sermonContextAfter,
  });
  const translationConfigRef = useRef<TranslationRuntimeConfig>(buildTranslationConfig());
  useEffect(() => { translationConfigRef.current = buildTranslationConfig(); }, [settings]);

  const ingestConfigRef = useRef<IngestConfig>({ maxLatencyMs: settings.sermonMaxLatencySecs * 1000 });
  useEffect(() => {
    ingestConfigRef.current = { maxLatencyMs: settings.sermonMaxLatencySecs * 1000 };
  }, [settings.sermonMaxLatencySecs]);

  const { refreshAll, refreshOne } = useTranslationQueue(state, dispatch, translationConfigRef, autoTranslateRef);

  const { isRecording, isProcessing, start, stop } = useSermonIngest({
    dispatch,
    ingestConfigRef,
    sourceLanguage: settings.defaultSourceLanguage || 'nl',
    targetLanguage: settings.defaultTargetLanguage || 'en',
    engine: settings.transcriptionProvider === 'mlx' ? 'mlx' : 'openai',
    correctionProvider: settings.sermonCorrectionProvider,
    openaiApiKey: settings.openaiApiKey,
    anthropicApiKey: settings.anthropicApiKey,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    ollamaModel: settings.ollamaModel,
    glossary: settings.theologicalGlossary,
    debugMode: settings.debugMode,
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
        onToggleRecording={() => { isRecording ? stop() : start(); }}
        dirtyCount={dirtyCount}
        onRefreshAll={refreshAll}
        autoTranslate={settings.sermonAutoTranslate}
        onToggleAutoTranslate={(v) => updateSettings({ sermonAutoTranslate: v })}
        maxLatencySecs={settings.sermonMaxLatencySecs}
        onChangeMaxLatencySecs={(v) => updateSettings({ sermonMaxLatencySecs: v })}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isMac={isMacPlatform}
      />
      <SegmentGrid state={state} dispatch={dispatch} activeSegmentIdRef={activeSegmentIdRef} onRefreshOne={refreshOne} />
      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdate={updateSettings}
      />
    </div>
  );
}
