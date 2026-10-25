import { useCallback, useEffect, useRef, useState } from 'react';
import { restoredState, type SegmentAction, type SegmentStoreState } from '@/lib/sermon/segment-store';
import { saveAutosave, loadAutosave, clearAutosave, type AutosaveRecord } from '@/lib/session-db';
import { useToast } from '@/hooks/use-toast';

/**
 * Autosave: the segments live only in the page, so write them to IndexedDB at
 * most every 3 s while they change (a timer that is already pending is not
 * reset — continuous live updates must not postpone the save forever) and once
 * more when the page is hidden/closed. On load, an autosave from an earlier
 * page is offered while the grid is still empty (`restoreOffer`).
 */
export function useAutosaveRestore(
  state: SegmentStoreState,
  stateRef: React.MutableRefObject<SegmentStoreState>,
  applyAction: (action: SegmentAction) => void,
) {
  const { toast } = useToast();

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveNow = useCallback(() => {
    const s = stateRef.current;
    if (s.ids.length) saveAutosave(s, s.ids.length).catch(() => {});
  }, [stateRef]);
  useEffect(() => {
    if (state.ids.length === 0 || autosaveTimerRef.current) return;
    autosaveTimerRef.current = setTimeout(() => { autosaveTimerRef.current = null; saveNow(); }, 3000);
  }, [state, saveNow]);
  useEffect(() => {
    window.addEventListener('pagehide', saveNow);
    return () => { window.removeEventListener('pagehide', saveNow); if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current); };
  }, [saveNow]);

  const [restoreOffer, setRestoreOffer] = useState<AutosaveRecord | null>(null);
  useEffect(() => {
    loadAutosave().then(rec => { if (rec && rec.rows > 0) setRestoreOffer(rec); }).catch(() => {});
  }, []);
  const handleRestore = useCallback(() => {
    const restored = restoredState(restoreOffer?.state, stateRef.current.sessionId);
    setRestoreOffer(null);
    if (!restored || restored.ids.length === 0) {
      toast({ title: 'Could not restore', description: 'The saved session could not be read.', variant: 'destructive' });
      return;
    }
    applyAction({ type: 'RESTORE_STATE', state: restored });
    toast({ title: 'Session restored', description: `${restored.ids.length} rows. Unfinished translations are done again.` });
  }, [restoreOffer, applyAction, toast, stateRef]);
  const handleDiscardRestore = useCallback(() => {
    setRestoreOffer(null);
    clearAutosave().catch(() => {});
  }, []);

  return { restoreOffer, handleRestore, handleDiscardRestore };
}
