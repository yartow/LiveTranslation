import { useCallback, useEffect } from 'react';
import {
  type SegmentStoreState, type SegmentAction, selectDirtyIds, selectTranslatable, selectContext,
} from '@/lib/sermon/segment-store';
import { hashText } from '@/lib/sermon/segment-model';
import { findBibleRef } from '@/lib/sermon/bible-ref';
import { translateItems, type TranslateRequestOptions, type ReadingCandidate } from '@/lib/sermon/translate-client';

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
 *
 * `stateRef` is owned by the caller (SermonMode.tsx) and kept in sync with
 * `state` during render rather than in an effect, so it can never lag a
 * commit behind — see the header comment there for why that used to matter.
 */
export function useTranslationQueue(
  stateRef: React.MutableRefObject<SegmentStoreState>,
  dispatch: React.Dispatch<SegmentAction>,
  configRef: React.MutableRefObject<TranslationRuntimeConfig>,
  autoTranslateRef: React.MutableRefObject<boolean>,
  flushersRef: React.MutableRefObject<Map<string, () => void>>,
) {
  const runBatch = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    // Flush any edit still sitting in a SourceCell's debounce window before
    // reading segment text — otherwise a Refresh triggered right after a
    // keystroke (e.g. Cmd+Enter) would translate the pre-edit text. See
    // SourceCell.tsx's commitPending/flushersRef registration.
    for (const id of ids) flushersRef.current.get(id)?.();
    const cfg = configRef.current;
    const snapshot = stateRef.current;

    // Scripture (spec "Bijbelcitaten"): a segment whose own text resolves a
    // Bible reference (bible-ref.ts) starts a new reading; a segment with no
    // reference of its own inherits the store's ongoing activeReading, if
    // any, as its check candidate — see server/lib/scripture.ts for the
    // verbatim/paraphrase/ended adjudication this feeds into.
    // scriptureOverride (CLEAR_SCRIPTURE) skips detection entirely.
    const items = ids
      .filter(id => snapshot.byId[id])
      .map(id => {
        const seg = snapshot.byId[id];
        const ctx = selectContext(snapshot, id, cfg.contextBefore, cfg.contextAfter);

        let readingCandidate: ReadingCandidate | undefined;
        let referenceHint: string | undefined;
        let ownRef = false;

        if (!seg.scriptureOverride) {
          const ref = findBibleRef(seg.sourceText);
          if (ref) {
            referenceHint = ref.canonicalEn;
            if (ref.verseStart !== null) {
              readingCandidate = { bookNumber: ref.bookNumber, chapter: ref.chapter, verse: ref.verseStart };
              ownRef = true;
            }
          } else if (snapshot.activeReading) {
            readingCandidate = {
              bookNumber: snapshot.activeReading.bookNumber,
              chapter: snapshot.activeReading.chapter,
              verse: snapshot.activeReading.nextVerse,
            };
          }
        }

        return {
          id, text: seg.sourceText, before: ctx.before, after: ctx.after,
          requestHash: hashText(seg.sourceText), readingCandidate, referenceHint, ownRef,
        };
      });
    if (items.length === 0) return;

    // A freshly recognized reference starts (or replaces) the active
    // reading immediately — this doesn't wait on the translate call below,
    // since the reading exists in the sermon regardless of whether that
    // call succeeds. If a batch somehow contains more than one new
    // reference, the last one dispatched wins, matching "a fresh reference
    // replaces the previous one" (segment-store.ts's SET_ACTIVE_READING).
    for (const item of items) {
      if (item.ownRef && item.readingCandidate) {
        dispatch({
          type: 'SET_ACTIVE_READING', bookNumber: item.readingCandidate.bookNumber,
          chapter: item.readingCandidate.chapter, verse: item.readingCandidate.verse,
        });
      }
    }

    dispatch({ type: 'MARK_TRANSLATING', ids: items.map(i => i.id) });

    try {
      const results = await translateItems(
        items.map(({ id, text, before, after, readingCandidate, referenceHint }) => ({ id, text, before, after, readingCandidate, referenceHint })),
        cfg,
      );
      const byId = new Map(results.map(r => [r.id, r]));
      for (const item of items) {
        const result = byId.get(item.id);
        if (!result) {
          dispatch({ type: 'SET_ERROR', id: item.id, error: 'No response for this segment', requestHash: item.requestHash });
          continue;
        }
        if (result.status === 'error') {
          dispatch({ type: 'SET_ERROR', id: item.id, error: result.error, requestHash: item.requestHash });
          continue;
        }

        // isThisStillTheActiveReading guards against a stale-order response
        // clobbering a reading that started later, in a different segment,
        // while this call was in flight — only advance/clear the store's
        // activeReading if it still matches what THIS item was checked
        // against (or this item is the one that started it).
        const current = stateRef.current.activeReading;
        const isThisStillTheActiveReading = !!item.readingCandidate && (
          item.ownRef ||
          (!!current && current.bookNumber === item.readingCandidate.bookNumber && current.chapter === item.readingCandidate.chapter)
        );

        if (result.scripture?.verbatim && result.scripture.text && result.scripture.reference && result.scripture.version) {
          dispatch({
            type: 'APPLY_SCRIPTURE', id: item.id, text: result.scripture.text,
            reference: result.scripture.reference, version: result.scripture.version, requestHash: item.requestHash,
          });
          if (isThisStillTheActiveReading && item.readingCandidate && typeof result.scripture.verseEnd === 'number') {
            dispatch({
              type: 'SET_ACTIVE_READING', bookNumber: item.readingCandidate.bookNumber,
              chapter: item.readingCandidate.chapter, verse: result.scripture.verseEnd + 1,
            });
          }
        } else {
          dispatch({ type: 'APPLY_TRANSLATION', id: item.id, translation: result.translation, requestHash: item.requestHash, warnings: result.warnings });
          if (isThisStillTheActiveReading && result.scripture?.readingEnded) {
            dispatch({ type: 'CLEAR_ACTIVE_READING' });
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Translation request failed';
      for (const item of items) {
        dispatch({ type: 'SET_ERROR', id: item.id, error: message, requestHash: item.requestHash });
      }
    }
  }, [dispatch, configRef, stateRef, flushersRef]);

  const refreshAll = useCallback(() => {
    const dirty = selectDirtyIds(stateRef.current);
    if (dirty.length === 0) return;
    if (dirty.length > CONFIRM_ABOVE_DIRTY_COUNT) {
      const ok = window.confirm(`Refresh hervertaalt ${dirty.length} segmenten — doorgaan?`);
      if (!ok) return;
    }
    runBatch(dirty);
  }, [runBatch, stateRef]);

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
  }, [runBatch, autoTranslateRef, configRef, stateRef]);

  return { refreshAll, refreshOne };
}
