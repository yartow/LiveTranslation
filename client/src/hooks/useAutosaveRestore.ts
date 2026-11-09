import { useCallback, useEffect, useRef, useState } from 'react';
import { restoredState, mergeRestored, type SegmentAction, type SegmentStoreState } from '@/lib/sermon/segment-store';
import { saveAutosave, loadAutosave, clearAutosave, type AutosaveRecord } from '@/lib/session-db';
import { useToast } from '@/hooks/use-toast';

/**
 * Autosave: the segments live only in the page, so write them to IndexedDB at
 * most every 3 s while they change (a timer that is already pending is not
 * reset — continuous live updates must not postpone the save forever) and once
 * more when the page is hidden/closed. On load, an autosave from an earlier
 * page is offered (`restoreOffer`). Until the operator answers it nothing is
 * saved: the record is the one copy of the earlier session, and a new recording
 * would overwrite it. Restoring after rows have appeared puts the old rows in front.
 */
export function useAutosaveRestore(
  state: SegmentStoreState,
  stateRef: React.MutableRefObject<SegmentStoreState>,
  applyAction: (action: SegmentAction) => void,
) {
  const { toast } = useToast();

  // True from page load until the saved record has been read and, if there was one, answered.
  const offerOpenRef = useRef(true);
  // Re-renders (and so re-runs the save effect below) once the offer is settled.
  const [offerOpen, setOfferOpen] = useState(true);
  const settleOffer = useCallback(() => { offerOpenRef.current = false; setOfferOpen(false); }, []);

  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveNow = useCallback(() => {
    if (offerOpenRef.current) return;
    const s = stateRef.current;
    if (s.ids.length) saveAutosave(s, s.ids.length).catch(() => {});
  }, [stateRef]);
  useEffect(() => {
    if (state.ids.length === 0 || autosaveTimerRef.current) return;
    autosaveTimerRef.current = setTimeout(() => { autosaveTimerRef.current = null; saveNow(); }, 3000);
  }, [state, saveNow, offerOpen]);
  useEffect(() => {
    window.addEventListener('pagehide', saveNow);
    return () => { window.removeEventListener('pagehide', saveNow); if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current); };
  }, [saveNow]);

  const [restoreOffer, setRestoreOffer] = useState<AutosaveRecord | null>(null);
  useEffect(() => {
    loadAutosave()
      .then(rec => { if (rec && rec.rows > 0) setRestoreOffer(rec); else settleOffer(); })
      .catch(settleOffer);
  }, [settleOffer]);
  const handleRestore = useCallback(() => {
    const current = stateRef.current;
    const restored = restoredState(restoreOffer?.state, current.sessionId);
    setRestoreOffer(null);
    settleOffer();
    if (!restored || restored.ids.length === 0) {
      toast({ title: 'Could not restore', description: 'The saved session could not be read.', variant: 'destructive' });
      return;
    }
    applyAction({ type: 'RESTORE_STATE', state: current.ids.length ? mergeRestored(restored, current) : restored });
    toast({ title: 'Session restored', description: `${restored.ids.length} rows. Unfinished translations are done again.` });
  }, [restoreOffer, applyAction, toast, stateRef, settleOffer]);
  const handleDiscardRestore = useCallback(() => {
    setRestoreOffer(null);
    settleOffer();
    // Replace the old record at once with what is on the page now (or drop it when the page is empty).
    clearAutosave().catch(() => {}).finally(saveNow);
  }, [settleOffer, saveNow]);

  return { restoreOffer, handleRestore, handleDiscardRestore };
}
