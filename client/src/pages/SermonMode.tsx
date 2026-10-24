import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Header from '@/components/Header';
import SermonToolbar from '@/components/sermon/SermonToolbar';
import AudioBar from '@/components/sermon/AudioBar';
import MicAlertBanner, { type MicAlert } from '@/components/sermon/MicAlertBanner';
import AddToGlossaryBubble, { type SourceSelection } from '@/components/sermon/AddToGlossaryBubble';
import AddToGlossaryDialog, { type GlossarySaved } from '@/components/sermon/AddToGlossaryDialog';
import SegmentGrid from '@/components/sermon/SegmentGrid';
import SettingsDialog from '@/components/settings/SettingsDialog';
import { useToast } from '@/hooks/use-toast';
import { useSettings, type AppSettings } from '@/hooks/useSettings';
import { useDevKeyAutofill } from '@/hooks/useDevKeyAutofill';
import { segmentReducer, initState, nextSegmentId, selectDirtyIds, type SegmentAction } from '@/lib/sermon/segment-store';
import { focusSegmentCell, type CellKind } from '@/lib/sermon/focus-cell';
import { RecordingStoppedError, realDeviceId } from '@/lib/chunk-based-transcription';
import { isRefreshAllChord, isRefreshOneChord, type KeyChord } from '@/lib/sermon/hotkeys';
import { useTranslationQueue, type TranslationRuntimeConfig } from '@/hooks/useTranslationQueue';
import { useSermonIngest } from '@/hooks/useSermonIngest';
import { useListenerBroadcast } from '@/hooks/useListenerBroadcast';
import { useMicDevices } from '@/hooks/useMicDevices';
import { LevelStore } from '@/lib/sermon/audio-level';
import type { IngestConfig } from '@/lib/sermon/ingest-buffer';
import { isMacPlatform } from '@/lib/platform';
import { replacePhrase } from '@/lib/sermon/glossary-fix';

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
  useDevKeyAutofill(settings, updateSettings);
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
  // the Sermon mode pages in SettingsDialog and the two most-used
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

  const ingestConfigRef = useRef<IngestConfig>({ maxLatencyMs: settings.sermonMaxLatencySecs * 1000, minBlockWords: SERMON_MIN_BLOCK_WORDS, showEarly: true });
  useEffect(() => {
    ingestConfigRef.current = { maxLatencyMs: settings.sermonMaxLatencySecs * 1000, minBlockWords: SERMON_MIN_BLOCK_WORDS, showEarly: true };
  }, [settings.sermonMaxLatencySecs]);

  const { refreshAll, refreshOne } = useTranslationQueue(stateRef, applyAction, translationConfigRef, autoTranslateRef, flushersRef);

  // Listener mode (CLAUDE.md "Listener mode") — pushes finished translations
  // to any connected phones. Reads `state` directly (not stateRef) so it
  // re-runs its diff on every render, same as the dirtyCount useMemo below.
  // The "send to listeners" switch. Session-only on purpose (not a setting): it
  // starts on at every page load so it can't stay off by accident into the next service.
  const [listenersEnabled, setListenersEnabled] = useState(true);
  const { listenerCount } = useListenerBroadcast(stateRef, state, listenersEnabled);

  // Audio bar: which mic is in use and how loud it is. The level store is an
  // external store so ~10 audio frames a second only re-render the meter.
  const [levelStore] = useState(() => new LevelStore());
  const mic = useMicDevices();

  // The microphone the recording runs on can stop mid-service (unplugged, a wireless transmitter
  // out of battery). The recording then moves to the system default (the built-in mic once the
  // receiver is gone) and this alert stays on screen, red and flickering, until it is acknowledged.
  const [micAlert, setMicAlert] = useState<MicAlert | null>(null);
  // Set after useSermonIngest (which provides switchMic) — the hook's own onStreamReady needs it.
  const micEndedRef = useRef<(fromLabel: string, fromDeviceId: string) => void>(() => {});
  // The SAVED choice (settings.micDeviceId) — not necessarily what is recording: after a fallback
  // or a failover the recording is on another device and the saved one is kept for next time.
  const micDeviceIdRef = useRef(settings.micDeviceId);
  micDeviceIdRef.current = settings.micDeviceId;
  // The deviceId the recording really runs on ('' = system default), set whenever a stream is
  // (re)opened. The failover alert and the default-input watcher go by this, not by the setting.
  const recordingDeviceIdRef = useRef('');
  // An automatic switch (track ended / macOS changed the default) in flight. Both events arrive
  // when a device is unplugged, in either order, and must produce one switch, not two.
  const autoSwitchRef = useRef<Promise<void> | null>(null);
  // When the recording last moved microphone — the default-input watcher ignores the macOS event
  // that trails a switch we just made.
  const lastMicSwitchAtRef = useRef(0);
  // Page-level `isRecording` mirrored for stable callbacks.
  const isRecordingRef = useRef(false);

  const { isRecording, isProcessing, isPaused, start, stop, pause, resume, switchMic } = useSermonIngest({
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
    micDeviceId: settings.micDeviceId,
    onAudioLevel: (rms, peak) => levelStore.push(rms, peak),
    onStreamReady: (stream) => {
      const label = stream.getAudioTracks()[0]?.label || 'Microphone';
      const deviceId = realDeviceId(stream);
      recordingDeviceIdRef.current = deviceId;
      mic.attachStream(stream, () => micEndedRef.current(label, deviceId));
    },
    onNotice: (message) => toast({ title: 'Microphone', description: message }),
    onError: (message) => toast({ title: 'Recording error', description: message, variant: 'destructive' }),
  });

  isRecordingRef.current = isRecording;

  // Moves the recording to the system default and raises the alert. Only one at a time. '' = the
  // system default; the saved choice (settings.micDeviceId) is kept on purpose, so the next
  // recording tries the original microphone again.
  const autoSwitchToDefault = (alert: Omit<MicAlert, 'to'>) => {
    if (autoSwitchRef.current) return;
    lastMicSwitchAtRef.current = Date.now();
    autoSwitchRef.current = switchMic('')
      .then(({ label }) => setMicAlert({ ...alert, to: label }))
      .catch((err) => {
        // Stop pressed meanwhile: there is no recording left to warn about.
        if (!(err instanceof RecordingStoppedError)) setMicAlert({ ...alert, to: null });
      })
      .finally(() => { autoSwitchRef.current = null; });
  };

  micEndedRef.current = (fromLabel: string, fromDeviceId: string) => {
    autoSwitchToDefault({ reason: 'stopped', from: fromLabel, fromDeviceId });
  };

  // macOS moved its default input (a USB device was plugged in or removed) while recording on
  // "System default". Chrome may or may not have followed, so reopen the default to be certain.
  const prevDefaultLabelRef = useRef('');
  useEffect(() => {
    const prev = prevDefaultLabelRef.current;
    prevDefaultLabelRef.current = mic.defaultLabel;
    // Only when the recording really is on the system default (not merely when the setting says so).
    if (!isRecording || recordingDeviceIdRef.current !== '' || !prev || !mic.defaultLabel || prev === mic.defaultLabel) return;
    if (Date.now() - lastMicSwitchAtRef.current < 3000) return;
    autoSwitchToDefault({ reason: 'default-changed', from: prev, fromDeviceId: '' });
  }, [mic.defaultLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Resolves true when the choice is saved and, if recording, the recording really moved to it. */
  const handleChangeMic = useCallback(async (deviceId: string): Promise<boolean> => {
    const previous = micDeviceIdRef.current;
    updateSettings({ micDeviceId: deviceId });
    if (!isRecording) return true;
    lastMicSwitchAtRef.current = Date.now();
    try {
      const { label, fellBack } = await switchMic(deviceId);
      toast({
        title: 'Microphone changed',
        description: fellBack ? `That microphone is not available. Now recording from ${label}.` : `Now recording from ${label}.`,
      });
      return true;
    } catch (err) {
      // Stop was pressed while the device was opening: nothing was recording, so the choice
      // stands for the next recording and there is nothing to report.
      if (err instanceof RecordingStoppedError) return true;
      // Roll back only if nobody picked another microphone in the meantime.
      if (micDeviceIdRef.current === deviceId) updateSettings({ micDeviceId: previous });
      toast({
        title: 'Could not switch microphone',
        description: `${err instanceof Error ? err.message : 'The microphone could not be opened'}. The previous microphone keeps recording.`,
        variant: 'destructive',
      });
      return false;
    }
  }, [isRecording, switchMic, updateSettings, toast]);

  // "Add row" / Return in the last row: an empty row to type into by hand, for when nothing comes
  // in from the microphone. If the last row is still blank, go there instead of stacking blank rows.
  const pendingFocusRef = useRef<{ id: string; cell: CellKind } | null>(null);
  const handleAddRow = useCallback((cell: CellKind = 'target') => {
    const s = stateRef.current;
    const last = s.ids.length ? s.byId[s.ids[s.ids.length - 1]] : undefined;
    if (last && !last.sourceText.trim() && !last.translatedText.trim()) {
      focusSegmentCell(last.id, cell);
      return;
    }
    const id = nextSegmentId(s);
    const t = last?.endTime ?? 0;
    pendingFocusRef.current = { id, cell };
    applyAction({ type: 'APPEND_SEGMENT', id, sourceText: '', startTime: t, endTime: t, approximateTiming: true, now: Date.now() });
  }, [applyAction]);

  // Return in the last row. While recording the live text keeps arriving below, so a row added
  // here would end up stranded mid-transcript — Return then only saves; the Add row button still adds.
  const handleEnterLastRow = useCallback((cell: CellKind) => {
    if (isRecordingRef.current) return;
    handleAddRow(cell);
  }, [handleAddRow]);

  // Settings → Microphone also writes micDeviceId; during a recording that must move the
  // recording too (not just the saved choice), like the audio-bar picker does.
  const handleSettingsUpdate = useCallback((updates: Partial<AppSettings>) => {
    const { micDeviceId, ...rest } = updates;
    if (micDeviceId === undefined || !isRecording || micDeviceId === micDeviceIdRef.current) {
      updateSettings(updates);
      return;
    }
    if (Object.keys(rest).length) updateSettings(rest);
    handleChangeMic(micDeviceId);
  }, [isRecording, updateSettings, handleChangeMic]);

  // No signal while stopped or paused: clear the meter and the "recording from" label.
  useEffect(() => {
    if (!isRecording || isPaused) levelStore.reset();
    if (!isRecording) mic.clearActive();
  }, [isRecording, isPaused, levelStore, mic.clearActive]);

  // Session archive (server has ASR_DEBUG_DIR — see server/lib/chunk-transcription.ts): while
  // recording, snapshot what is on screen every minute and once more after stop, so a gap in the
  // transcript can be traced to the stage that lost it. A no-op when the server archive is off.
  const archiveActiveRef = useRef(false);
  useEffect(() => {
    fetch('/api/asr-debug/status').then(r => r.json()).then(j => { archiveActiveRef.current = !!j.enabled; }).catch(() => {});
  }, []);
  const postTranscriptSnapshot = useCallback(() => {
    if (!archiveActiveRef.current) return;
    const s = stateRef.current;
    // An empty page (e.g. just reloaded) must not overwrite the previous session's snapshot.
    if (!s.ids.length) return;
    const segments = s.ids.map(id => {
      const g = s.byId[id];
      return {
        id, index: g.index, startTime: g.startTime, endTime: g.endTime, status: g.status,
        sourceText: g.sourceText, translatedText: g.translatedText,
        manualOverride: g.manualOverride, lastSourceChangeAt: g.lastSourceChangeAt, error: g.error,
      };
    });
    fetch('/api/asr-debug/transcript', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ savedAt: Date.now(), sessionId: s.sessionId, segments }),
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!isRecording) {
      // After stop the last ingest flush / translations may still land a moment later.
      postTranscriptSnapshot();
      const late = setTimeout(postTranscriptSnapshot, 4000);
      return () => clearTimeout(late);
    }
    const timer = setInterval(postTranscriptSnapshot, 60_000);
    return () => clearInterval(timer);
  }, [isRecording, postTranscriptSnapshot]);

  // "Add to glossary": highlighted words in a source cell -> floating bubble -> dialog.
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [glossarySelection, setGlossarySelection] = useState<SourceSelection | null>(null);
  const handleSelectText = useCallback((sel: SourceSelection | null) => setSelection(sel), []);
  const dismissBubble = useCallback(() => setSelection(null), []);

  const handleGlossarySaved = useCallback((r: GlossarySaved) => {
    setGlossarySelection(null);
    let rowNote = '';
    if (r.fixRow) {
      const { segmentId, start } = r.selection;
      // Commit anything typed in the last moments before reading the row's text.
      flushersRef.current.get(segmentId)?.();
      const seg = stateRef.current.byId[segmentId];
      // The phrase as finally typed (it may be narrower than the highlight); live updates may have moved it, so take the closest match.
      const fixed = seg ? replacePhrase(seg.sourceText, r.heard || r.selection.text, r.dutch, start) : null;
      if (seg && fixed !== null) {
        applyAction({ type: 'REPLACE_SOURCE', id: segmentId, sourceText: fixed, now: Date.now() });
        rowNote = ' This row was corrected.';
      } else {
        rowNote = ' The row had changed, so it was left as it is.';
      }
    }
    toast({
      title: 'Added to glossary',
      description: (r.correctionAdded ? 'New transcripts are corrected automatically.' : 'Saved.') + rowNote,
    });
  }, [applyAction, toast]);

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
        isPaused={isPaused}
        onTogglePause={isPaused ? resume : pause}
        onToggleRecording={() => {
          if (isRecording) {
            stop().catch((err) => toast({ title: 'Recording error', description: err instanceof Error ? err.message : 'Could not stop recording', variant: 'destructive' }));
          } else {
            start();
          }
        }}
        dirtyCount={dirtyCount}
        onRefreshAll={refreshAll}
        onAddRow={() => handleAddRow('target')}
        autoTranslate={settings.sermonAutoTranslate}
        onToggleAutoTranslate={(v) => updateSettings({ sermonAutoTranslate: v })}
        maxLatencySecs={settings.sermonMaxLatencySecs}
        onChangeMaxLatencySecs={(v) => updateSettings({ sermonMaxLatencySecs: v })}
        listenerCount={listenerCount}
        listenersEnabled={listenersEnabled}
        onToggleListeners={() => setListenersEnabled(v => !v)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isMac={isMacPlatform}
      />
      <AudioBar
        levelStore={levelStore}
        isRecording={isRecording}
        isPaused={isPaused}
        micDeviceId={settings.micDeviceId}
        onChangeMicDeviceId={handleChangeMic}
        devices={mic.devices}
        defaultLabel={mic.defaultLabel}
        hasLabels={mic.hasLabels}
        activeLabel={mic.activeLabel}
      />
      {micAlert && (
        <MicAlertBanner
          alert={micAlert}
          canSwitchBack={isRecording && !!micAlert.fromDeviceId && mic.devices.some(d => d.deviceId === micAlert.fromDeviceId)}
          onSwitchBack={() => { handleChangeMic(micAlert.fromDeviceId).then(ok => { if (ok) setMicAlert(null); }); }}
          onAcknowledge={() => setMicAlert(null)}
        />
      )}
      <SegmentGrid
        state={state}
        dispatch={applyAction}
        activeSegmentIdRef={activeSegmentIdRef}
        onRefreshOne={refreshOne}
        flushersRef={flushersRef}
        onSelectText={handleSelectText}
        onAddRow={handleEnterLastRow}
        pendingFocusRef={pendingFocusRef}
      />
      {selection && !glossarySelection && (
        <AddToGlossaryBubble
          selection={selection}
          onAdd={() => { setGlossarySelection(selection); setSelection(null); }}
          onDismiss={dismissBubble}
        />
      )}
      <AddToGlossaryDialog
        selection={glossarySelection}
        glossaryCsv={settings.sermonGlossaryCsv}
        onClose={() => setGlossarySelection(null)}
        onSaved={handleGlossarySaved}
      />
      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdate={handleSettingsUpdate}
        mode="sermon"
      />
    </div>
  );
}
