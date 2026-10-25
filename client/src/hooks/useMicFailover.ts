import { useCallback, useEffect, useRef, useState } from 'react';
import type { MicAlert } from '@/components/sermon/MicAlertBanner';
import type { AppSettings } from '@/hooks/useSettings';
import { useLatest } from '@/hooks/useLatest';
import { useMicDevices } from '@/hooks/useMicDevices';
import { useToast } from '@/hooks/use-toast';
import { RecordingStoppedError, realDeviceId } from '@/lib/chunk-based-transcription';

/** What the page learns from useSermonIngest, which is called after this hook (it needs `onStreamReady` from here). */
export interface IngestControls {
  isRecording: boolean;
  switchMic: (deviceId: string) => Promise<{ label: string; fellBack: boolean }>;
}

interface Args {
  /** The SAVED choice (settings.micDeviceId) — not necessarily what is recording: after a fallback
   *  or a failover the recording is on another device and the saved one is kept for next time. */
  savedMicDeviceId: string;
  updateSettings: (updates: Partial<AppSettings>) => void;
  mic: ReturnType<typeof useMicDevices>;
  /** Kept current by the page once useSermonIngest has returned (see SermonMode.tsx). */
  ingestRef: React.MutableRefObject<IngestControls>;
}

/**
 * The microphone the recording runs on can stop mid-service (unplugged, a wireless transmitter out
 * of battery). The recording then moves to the system default (the built-in mic once the receiver
 * is gone) and `micAlert` stays set — the page shows it red and flickering — until acknowledged.
 * See CLAUDE.md "Microphone failover & the red alert".
 */
export function useMicFailover({ savedMicDeviceId, updateSettings, mic, ingestRef }: Args) {
  const { toast } = useToast();
  const [micAlert, setMicAlert] = useState<MicAlert | null>(null);
  const micDeviceIdRef = useLatest(savedMicDeviceId);
  // The deviceId the recording really runs on ('' = system default), set whenever a stream is
  // (re)opened. The failover alert and the default-input watcher go by this, not by the setting.
  const recordingDeviceIdRef = useRef('');
  // An automatic switch (track ended / macOS changed the default) in flight. Both events arrive
  // when a device is unplugged, in either order, and must produce one switch, not two.
  const autoSwitchRef = useRef<Promise<void> | null>(null);
  // When the recording last moved microphone — the default-input watcher ignores the macOS event
  // that trails a switch we just made.
  const lastMicSwitchAtRef = useRef(0);

  // Moves the recording to the system default and raises the alert. Only one at a time. '' = the
  // system default; the saved choice (settings.micDeviceId) is kept on purpose, so the next
  // recording tries the original microphone again.
  const autoSwitchToDefault = useCallback((alert: Omit<MicAlert, 'to'>) => {
    if (autoSwitchRef.current) return;
    lastMicSwitchAtRef.current = Date.now();
    autoSwitchRef.current = ingestRef.current.switchMic('')
      .then(({ label }) => setMicAlert({ ...alert, to: label }))
      .catch((err) => {
        // Stop pressed meanwhile: there is no recording left to warn about.
        if (!(err instanceof RecordingStoppedError)) setMicAlert({ ...alert, to: null });
      })
      .finally(() => { autoSwitchRef.current = null; });
  }, [ingestRef]);

  // For useSermonIngest: remember which device the recording really opened and watch its track.
  const { attachStream } = mic;
  const onStreamReady = useCallback((stream: MediaStream) => {
    const label = stream.getAudioTracks()[0]?.label || 'Microphone';
    const deviceId = realDeviceId(stream);
    recordingDeviceIdRef.current = deviceId;
    attachStream(stream, () => autoSwitchToDefault({ reason: 'stopped', from: label, fromDeviceId: deviceId }));
  }, [attachStream, autoSwitchToDefault]);

  // macOS moved its default input (a USB device was plugged in or removed) while recording on
  // "System default". Chrome may or may not have followed, so reopen the default to be certain.
  const prevDefaultLabelRef = useRef('');
  useEffect(() => {
    const prev = prevDefaultLabelRef.current;
    prevDefaultLabelRef.current = mic.defaultLabel;
    // Only when the recording really is on the system default (not merely when the setting says so).
    if (!ingestRef.current.isRecording || recordingDeviceIdRef.current !== '' || !prev || !mic.defaultLabel || prev === mic.defaultLabel) return;
    if (Date.now() - lastMicSwitchAtRef.current < 3000) return;
    autoSwitchToDefault({ reason: 'default-changed', from: prev, fromDeviceId: '' });
  }, [mic.defaultLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Resolves true when the choice is saved and, if recording, the recording really moved to it. */
  const handleChangeMic = useCallback(async (deviceId: string): Promise<boolean> => {
    const previous = micDeviceIdRef.current;
    updateSettings({ micDeviceId: deviceId });
    if (!ingestRef.current.isRecording) return true;
    lastMicSwitchAtRef.current = Date.now();
    try {
      const { label, fellBack } = await ingestRef.current.switchMic(deviceId);
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
  }, [ingestRef, micDeviceIdRef, updateSettings, toast]);

  // Settings → Microphone also writes micDeviceId; during a recording that must move the
  // recording too (not just the saved choice), like the audio-bar picker does.
  const handleSettingsUpdate = useCallback((updates: Partial<AppSettings>) => {
    const { micDeviceId, ...rest } = updates;
    if (micDeviceId === undefined || !ingestRef.current.isRecording || micDeviceId === micDeviceIdRef.current) {
      updateSettings(updates);
      return;
    }
    if (Object.keys(rest).length) updateSettings(rest);
    handleChangeMic(micDeviceId);
  }, [ingestRef, micDeviceIdRef, updateSettings, handleChangeMic]);

  const clearMicAlert = useCallback(() => setMicAlert(null), []);

  return { micAlert, clearMicAlert, onStreamReady, handleChangeMic, handleSettingsUpdate };
}
