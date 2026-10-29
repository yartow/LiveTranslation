import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Header from '@/components/Header';
import SermonToolbar from '@/components/sermon/SermonToolbar';
import AudioBar from '@/components/sermon/AudioBar';
import MicAlertBanner from '@/components/sermon/MicAlertBanner';
import RestoreBanner from '@/components/sermon/RestoreBanner';
import AddToGlossaryBubble, { type SourceSelection } from '@/components/sermon/AddToGlossaryBubble';
import AddToGlossaryDialog, { type GlossarySaved } from '@/components/sermon/AddToGlossaryDialog';
import SegmentGrid from '@/components/sermon/SegmentGrid';
import SettingsDialog from '@/components/settings/SettingsDialog';
import { useToast } from '@/hooks/use-toast';
import { useSettings } from '@/hooks/useSettings';
import { useDevKeyAutofill } from '@/hooks/useDevKeyAutofill';
import { nextSegmentId, selectDirtyIds } from '@/lib/sermon/segment-store';
import { focusSegmentCell, type CellKind } from '@/lib/sermon/focus-cell';
import { glossaryWithServiceParts } from '@/lib/sermon/service-context';
import type { EditSuggestion } from '@/lib/sermon/edit-suggestions';
import { RecordingStoppedError } from '@/lib/chunk-based-transcription';
import { useTranslationQueue } from '@/hooks/useTranslationQueue';
import { useSermonIngest } from '@/hooks/useSermonIngest';
import { useListenerBroadcast } from '@/hooks/useListenerBroadcast';
import { useMicDevices } from '@/hooks/useMicDevices';
import { useEditArchive, useTranscriptSnapshots } from '@/hooks/useSessionArchive';
import { useSegmentStore } from '@/hooks/useSegmentStore';
import { useSermonRuntimeConfig } from '@/hooks/useSermonRuntimeConfig';
import { useMicFailover, type IngestControls } from '@/hooks/useMicFailover';
import { useAutosaveRestore } from '@/hooks/useAutosaveRestore';
import { useRefreshHotkeys } from '@/hooks/useRefreshHotkeys';
import { useEditSuggestions } from '@/hooks/useEditSuggestions';
import { LevelStore } from '@/lib/sermon/audio-level';
import { PipelineStats } from '@/lib/sermon/pipeline-stats';
import { ConfidenceStore } from '@/lib/sermon/confidence-store';
import { isMacPlatform } from '@/lib/platform';
import { replacePhrase } from '@/lib/sermon/glossary-fix';

// Sermon mode is its own page/route ("/", see App.tsx) rather than a mode of
// Home.tsx — Home's TranscriptionSegment model is chunk-level, id-less, and
// flattened to one element by every correction path, so it can't carry the
// per-sentence identity this feature depends on. See the plan doc for the
// full rationale. This does mean recording/audio-level plumbing is
// duplicated rather than shared with Home.tsx — accepted as known debt for v1.
//
// The page wires the pieces together; each concern lives in its own hook:
// useSegmentStore (state + applyAction), useSermonRuntimeConfig (settings ->
// refs), useSermonIngest (recording), useTranslationQueue, useMicFailover,
// useAutosaveRestore, useSessionArchive (edit log + transcript snapshots).

export default function SermonMode() {
  const { settings, updateSettings } = useSettings();
  useDevKeyAutofill(settings, updateSettings);
  const { toast } = useToast();

  const archive = useEditArchive();
  const { state, stateRef, applyAction } = useSegmentStore(archive);

  // Registry of per-segment "flush the pending debounced source edit now"
  // callbacks, populated by SourceCell. A manual Refresh (button or hotkey)
  // calls these before reading segment text — see useTranslationQueue.ts.
  const flushersRef = useRef(new Map<string, () => void>());

  const activeSegmentIdRef = useRef<string | null>(null);
  const [isDark, setIsDark] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const { autoTranslateRef, translationConfigRef, ingestConfigRef } = useSermonRuntimeConfig(settings);

  // Pipeline health (the audio bar's popover): chunk delays from the recorder, call times from the translator.
  const [pipelineStats] = useState(() => new PipelineStats());
  // Words Whisper was unsure about (MLX engine) -> "check" chips under the Dutch cells.
  const [confidenceStore] = useState(() => new ConfidenceStore());
  const { refreshAll, refreshOne } = useTranslationQueue({
    stateRef, dispatch: applyAction, configRef: translationConfigRef, autoTranslateRef, flushersRef, stats: pipelineStats,
  });

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

  // useMicFailover must come first (useSermonIngest needs its onStreamReady) yet needs what
  // useSermonIngest returns (isRecording, switchMic), hence this ref, filled in just below.
  const ingestRef = useRef<IngestControls>({
    isRecording: false,
    switchMic: () => Promise.reject(new RecordingStoppedError('Not recording')),
  });
  const { micAlert, clearMicAlert, onStreamReady, handleChangeMic, handleSettingsUpdate } = useMicFailover({
    savedMicDeviceId: settings.micDeviceId,
    updateSettings,
    mic,
    ingestRef,
  });

  const serviceGlossary = useMemo(
    () => glossaryWithServiceParts(settings.theologicalGlossary, settings.sermonServiceContext),
    [settings.theologicalGlossary, settings.sermonServiceContext],
  );
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
    glossary: serviceGlossary.glossary,
    glossaryPriorityLines: serviceGlossary.priorityLines,
    debugMode: settings.debugMode,
    normalizationGain: settings.audioNormalizationGain,
    rawAudioCapture: settings.rawAudioCapture,
    micDeviceId: settings.micDeviceId,
    onAudioLevel: (rms, peak) => levelStore.push(rms, peak),
    pipelineStats,
    confidenceStore,
    onStreamReady,
    onNotice: (message) => toast({ title: 'Microphone', description: message }),
    onError: (message, stillRecording) => toast({
      title: stillRecording ? 'Transcription problem, still recording' : 'Recording error',
      description: message,
      variant: 'destructive',
    }),
  });
  useLayoutEffect(() => { ingestRef.current = { isRecording, switchMic }; });

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
  }, [applyAction, stateRef]);

  // No signal while stopped or paused: clear the meter and the "recording from" label.
  useEffect(() => {
    if (!isRecording || isPaused) levelStore.reset();
    if (!isRecording) mic.clearActive();
  }, [isRecording, isPaused, levelStore, mic.clearActive]);

  // The recording applies the gain it started with (useSermonIngest reads it once), so the level verdict
  // and the gain chip follow that value and ignore edits made during the recording.
  const [gainInUse, setGainInUse] = useState(settings.audioNormalizationGain);
  useEffect(() => {
    if (isRecording) return;
    setGainInUse(settings.audioNormalizationGain);
    levelStore.setGain(settings.audioNormalizationGain);
  }, [isRecording, settings.audioNormalizationGain, levelStore]);

  // Session archive (server has ASR_DEBUG_DIR): a transcript snapshot every minute while recording.
  useTranscriptSnapshots(stateRef, isRecording, archive);

  // "Add to glossary": highlighted words in a source cell -> floating bubble -> dialog.
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [glossarySelection, setGlossarySelection] = useState<SourceSelection | null>(null);
  const handleSelectText = useCallback((sel: SourceSelection | null) => setSelection(sel), []);
  const dismissBubble = useCallback(() => setSelection(null), []);

  // Suggestions: words corrected by hand (asrText vs sourceText), never again once dismissed or added.
  const { suggestions, dismissSuggestion } = useEditSuggestions(state);
  const [suggestionBeingAdded, setSuggestionBeingAdded] = useState<EditSuggestion | null>(null);
  // The dialog takes a row selection; a suggestion has no row, so it gets an empty segmentId.
  // Memoized: the dialog resets its form whenever this object changes, and the page re-renders on every store update.
  const suggestionSelection = useMemo<SourceSelection | null>(() => (suggestionBeingAdded
    ? { segmentId: '', start: 0, end: 0, text: suggestionBeingAdded.heard, x: 0, y: 0 }
    : null), [suggestionBeingAdded]);

  const handleGlossarySaved = useCallback((r: GlossarySaved) => {
    setGlossarySelection(null);
    if (suggestionBeingAdded) { dismissSuggestion(suggestionBeingAdded.key); setSuggestionBeingAdded(null); }
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
  }, [applyAction, toast, suggestionBeingAdded, dismissSuggestion, stateRef]);

  const dirtyCount = useMemo(() => selectDirtyIds(state).length, [state]);

  const { restoreOffer, handleRestore, handleDiscardRestore } = useAutosaveRestore(state, stateRef, applyAction);

  useRefreshHotkeys(refreshAll, refreshOne, activeSegmentIdRef);

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
        serviceContext={settings.sermonServiceContext}
        onChangeServiceContext={(next) => updateSettings({ sermonServiceContext: next })}
        suggestions={suggestions}
        onAddSuggestion={setSuggestionBeingAdded}
        onDismissSuggestion={(s) => dismissSuggestion(s.key)}
        isMac={isMacPlatform}
      />
      <AudioBar
        levelStore={levelStore}
        pipelineStats={pipelineStats}
        isRecording={isRecording}
        isPaused={isPaused}
        micDeviceId={settings.micDeviceId}
        onChangeMicDeviceId={handleChangeMic}
        devices={mic.devices}
        defaultLabel={mic.defaultLabel}
        hasLabels={mic.hasLabels}
        activeLabel={mic.activeLabel}
        gain={gainInUse}
      />
      {restoreOffer && (
        <RestoreBanner rows={restoreOffer.rows} savedAt={restoreOffer.savedAt} hasCurrentRows={state.ids.length > 0} onRestore={handleRestore} onDiscard={handleDiscardRestore} />
      )}
      {micAlert && (
        <MicAlertBanner
          alert={micAlert}
          canSwitchBack={isRecording && !!micAlert.fromDeviceId && mic.devices.some(d => d.deviceId === micAlert.fromDeviceId)}
          onSwitchBack={() => { handleChangeMic(micAlert.fromDeviceId).then(ok => { if (ok) clearMicAlert(); }); }}
          onAcknowledge={clearMicAlert}
        />
      )}
      <SegmentGrid
        state={state}
        dispatch={applyAction}
        activeSegmentIdRef={activeSegmentIdRef}
        onRefreshOne={refreshOne}
        flushersRef={flushersRef}
        onSelectText={handleSelectText}
        onAddRow={handleAddRow}
        pendingFocusRef={pendingFocusRef}
        confidenceStore={confidenceStore}
      />
      {selection && !glossarySelection && (
        <AddToGlossaryBubble
          selection={selection}
          onAdd={() => { setGlossarySelection(selection); setSelection(null); }}
          onDismiss={dismissBubble}
        />
      )}
      <AddToGlossaryDialog
        selection={glossarySelection ?? suggestionSelection}
        glossaryCsv={settings.sermonGlossaryCsv}
        suggestedDutch={suggestionBeingAdded?.correct}
        onClose={() => { setGlossarySelection(null); setSuggestionBeingAdded(null); }}
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
