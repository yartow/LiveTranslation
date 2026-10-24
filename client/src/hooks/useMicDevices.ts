import { useCallback, useEffect, useRef, useState } from 'react';

export interface MicDevice {
  deviceId: string;
  label: string;
}

// Chrome lists two virtual entries that duplicate a real device.
const VIRTUAL_IDS = new Set(['default', 'communications']);

/** True for the MacBook's own microphone — everything else (USB, Bluetooth, interface) is "external". */
export function isBuiltInMic(label: string): boolean {
  return /macbook|built-in|ingebouwd|internal/i.test(label);
}

/** Chrome prefixes the virtual default entry: "Default - MacBook Pro Microphone (Built-in)". */
export function stripDefaultPrefix(label: string): string {
  return label.replace(/^(default|standaard)\s*[-–]\s*/i, '');
}

/**
 * Lists the audio inputs and tracks which one the current recording really uses.
 * Device labels are empty until the page has had microphone permission once, so
 * `hasLabels` lets the UI say so instead of showing blank names.
 */
export function useMicDevices() {
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [defaultLabel, setDefaultLabel] = useState('');
  const [hasLabels, setHasLabels] = useState(false);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      // Without microphone permission Chrome lists devices with empty ids and labels — nothing to pick yet.
      const inputs = all.filter(d => d.kind === 'audioinput' && d.deviceId);
      setHasLabels(inputs.some(d => d.label));
      const def = inputs.find(d => d.deviceId === 'default');
      setDefaultLabel(def?.label ? stripDefaultPrefix(def.label) : '');
      setDevices(
        inputs
          .filter(d => !VIRTUAL_IDS.has(d.deviceId))
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
      );
    } catch {
      // No mediaDevices (insecure context) or blocked: leave the lists empty.
    }
  }, []);

  useEffect(() => {
    refresh();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refresh);
    return () => md?.removeEventListener?.('devicechange', refresh);
  }, [refresh]);

  // The track the recording is on now. A recording can move to another microphone, and the
  // old track's 'ended' must not be reported as a failure of the new one. Deliberately NOT cleared
  // by clearActive(): the page's `isRecording` can go false (a server error) while the capture
  // keeps running, and an unplugged microphone must still be reported then.
  const currentTrackRef = useRef<MediaStreamTrack | null>(null);

  /** Call with the stream the recording opened (or switched to); `onEnded` fires if that device disappears mid-recording (unplugged). */
  const attachStream = useCallback((stream: MediaStream, onEnded?: () => void) => {
    const track = stream.getAudioTracks()[0];
    currentTrackRef.current = track ?? null;
    setActiveLabel(track?.label || null);
    track?.addEventListener('ended', () => {
      if (currentTrackRef.current !== track) return;
      setActiveLabel(null);
      onEnded?.();
    }, { once: true });
    refresh(); // labels become available once permission was granted
  }, [refresh]);

  const clearActive = useCallback(() => setActiveLabel(null), []);

  return { devices, defaultLabel, hasLabels, activeLabel, attachStream, clearActive, refresh };
}
