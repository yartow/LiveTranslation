import { useCallback, useEffect, useRef } from 'react';
import {
  type SegmentStoreState, type SegmentAction, selectDirtyIds, selectTranslatable, selectContext,
} from '@/lib/sermon/segment-store';
import { hashText } from '@/lib/sermon/segment-model';
import { translateItems, type TranslateRequestOptions } from '@/lib/sermon/translate-client';

export interface TranslationRuntimeConfig extends TranslateRequestOptions {
  stabilityMs: number;
  contextBefore: number;
  contextAfter: number;
}

// Above this many dirty segments, a manual "Refresh all" asks for
// confirmation first — a bulk source edit followed by one Refresh could
// otherwise queue hundreds of translation calls at once (plan §"Risico's",
// point 3). Auto-translate never hits this path since it only ever
// dispatches segments that have individually cleared the stability debounce.
const CONFIRM_ABOVE_DIRTY_COUNT = 50;

/**
 * Owns the translation call lifecycle: batching, the in-flight staleness
 * guard (via requestHash captured at dispatch time), automatic
 * stability-debounced translation, and manual refresh (all / one).
 *
 * Deliberately reducer-external — this hook only ever dispatches actions
 * into the segment reducer, it never holds segment data of its own, so the
 * reference-stability guarantees in segment-store.ts are untouched by
 * anything in here.
 */
export function useTranslationQueue(
  state: SegmentStoreState,
  dispatch: React.Dispatch<SegmentAction>,
  configRef: React.MutableRefObject<TranslationRuntimeConfig>,
  autoTranslateRef: React.MutableRefObject<boolean>,
) {
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const runBatch = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const cfg = configRef.current;
    const snapshot = stateRef.current;

    const items = ids
      .filter(id => snapshot.byId[id])
      .map(id => {
        const seg = snapshot.byId[id];
        const ctx = selectContext(snapshot, id, cfg.contextBefore, cfg.contextAfter);
        return {
          id,
          text: seg.sourceText,
          before: ctx.before,
          after: ctx.after,
          requestHash: hashText(seg.sourceText),
        };
      });
    if (items.length === 0) return;

    dispatch({ type: 'MARK_TRANSLATING', ids: items.map(i => i.id) });

    try {
      const results = await translateItems(
        items.map(({ id, text, before, after }) => ({ id, text, before, after })),
        cfg,
      );
      const byId = new Map(results.map(r => [r.id, r]));
      for (const item of items) {
        const result = byId.get(item.id);
        if (!result) {
          dispatch({ type: 'SET_ERROR', id: item.id, error: 'No response for this segment', requestHash: item.requestHash });
        } else if (result.status === 'ok') {
          dispatch({ type: 'APPLY_TRANSLATION', id: item.id, translation: result.translation, requestHash: item.requestHash });
        } else {
          dispatch({ type: 'SET_ERROR', id: item.id, error: result.error, requestHash: item.requestHash });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Translation request failed';
      for (const item of items) {
        dispatch({ type: 'SET_ERROR', id: item.id, error: message, requestHash: item.requestHash });
      }
    }
  }, [dispatch, configRef]);

  const refreshAll = useCallback(() => {
    const dirty = selectDirtyIds(stateRef.current);
    if (dirty.length === 0) return;
    if (dirty.length > CONFIRM_ABOVE_DIRTY_COUNT) {
      const ok = window.confirm(`Refresh hervertaalt ${dirty.length} segmenten — doorgaan?`);
      if (!ok) return;
    }
    runBatch(dirty);
  }, [runBatch]);

  const refreshOne = useCallback((id: string | null) => {
    if (id) runBatch([id]);
  }, [runBatch]);

  // Auto-translate: polls at a fixed cadence, well under the stability
  // debounce (default 1200ms), so a segment is picked up promptly once it
  // clears the debounce. Segments already TRANSLATING are excluded by
  // selectTranslatable, so a slow in-flight batch is never double-queued.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!autoTranslateRef.current) return;
      const ids = selectTranslatable(stateRef.current, { stabilityMs: configRef.current.stabilityMs }, Date.now());
      if (ids.length > 0) runBatch(ids);
    }, 400);
    return () => clearInterval(interval);
  }, [runBatch, autoTranslateRef, configRef]);

  return { refreshAll, refreshOne };
}
