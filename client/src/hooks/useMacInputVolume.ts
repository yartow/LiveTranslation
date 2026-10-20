import { useCallback, useEffect, useRef, useState } from 'react';

// GET/PUT /api/mac/input-volume (server/lib/mac-input-volume.ts) — the macOS
// system input volume, i.e. the real microphone gain of the default input.
export type MacInputVolumeState =
  | { status: 'loading' }
  | { status: 'unsupported'; reason: string }
  | { status: 'ready'; volume: number };

const POLL_MS = 5000;
const WRITE_DEBOUNCE_MS = 150;
/** After the operator moves the slider, ignore polled values this long so the thumb doesn't jump back. */
const LOCAL_CHANGE_GRACE_MS = 2000;

interface ServerResult { supported: boolean; volume?: number; reason?: string }

function toState(r: ServerResult): MacInputVolumeState {
  return r.supported && typeof r.volume === 'number'
    ? { status: 'ready', volume: r.volume }
    : { status: 'unsupported', reason: r.reason ?? 'Not available' };
}

export function useMacInputVolume() {
  const [state, setState] = useState<MacInputVolumeState>({ status: 'loading' });
  const lastLocalChangeRef = useRef(0);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback(async () => {
    try {
      const res = await fetch('/api/mac/input-volume');
      if (!res.ok) throw new Error(String(res.status));
      const next = toState(await res.json());
      // Don't fight the slider while it's being dragged.
      if (Date.now() - lastLocalChangeRef.current < LOCAL_CHANGE_GRACE_MS) return;
      setState(next);
    } catch {
      setState({ status: 'unsupported', reason: 'Could not reach the server' });
    }
  }, []);

  useEffect(() => {
    read();
    const timer = setInterval(read, POLL_MS);
    return () => clearInterval(timer);
  }, [read]);

  useEffect(() => () => { if (writeTimerRef.current) clearTimeout(writeTimerRef.current); }, []);

  const setVolume = useCallback((volume: number) => {
    const v = Math.max(0, Math.min(100, Math.round(volume)));
    lastLocalChangeRef.current = Date.now();
    setState({ status: 'ready', volume: v });
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/mac/input-volume', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: v }),
        });
        if (!res.ok) throw new Error(String(res.status));
        lastLocalChangeRef.current = Date.now();
        setState(toState(await res.json()));
      } catch {
        lastLocalChangeRef.current = 0;
        read();
      }
    }, WRITE_DEBOUNCE_MS);
  }, [read]);

  return { state, setVolume };
}
