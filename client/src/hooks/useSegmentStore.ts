import { useCallback, useReducer, useRef } from 'react';
import { segmentReducer, initState, type SegmentAction } from '@/lib/sermon/segment-store';
import { editLogEntry } from '@/lib/sermon/edit-log';
import type { EditArchive } from '@/hooks/useSessionArchive';

/**
 * The sermon page's segment store: the reducer state, a ref mirror of it, and
 * `applyAction`, the one way actions should be dispatched.
 *
 * The ref mirror is kept authoritative two ways: (1) every action dispatched
 * through applyAction applies the same pure reducer to it synchronously, so
 * code that flushes a pending edit and immediately reads segment text in the
 * same synchronous tick (see useTranslationQueue.ts's runBatch) sees the edit
 * right away — a plain `useReducer` dispatch alone only takes effect on the
 * next render, one tick later. (2) it's also reassigned from `state` on every
 * render as a fallback, so it can never drift even if some future code path
 * dispatches through the raw reducer dispatch instead of applyAction.
 */
export function useSegmentStore({ archiveActiveRef, editLog }: EditArchive) {
  const sessionIdRef = useRef(`s${Date.now().toString(36)}`);
  const [state, dispatch] = useReducer(segmentReducer, sessionIdRef.current, initState);

  const stateRef = useRef(state);
  stateRef.current = state;

  const applyAction = useCallback((action: SegmentAction) => {
    if (archiveActiveRef.current) {
      const entry = editLogEntry(action, stateRef.current, Date.now());
      if (entry) editLog.record(entry);
    }
    stateRef.current = segmentReducer(stateRef.current, action);
    dispatch(action);
  }, [dispatch, editLog, archiveActiveRef]);

  return { state, stateRef, applyAction };
}
