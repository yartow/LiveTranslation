import { useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import type { Segment } from '@/lib/sermon/segment-model';
import type { SegmentAction } from '@/lib/sermon/segment-store';

interface SourceCellProps {
  segment: Segment;
  dispatch: React.Dispatch<SegmentAction>;
  activeSegmentIdRef: React.MutableRefObject<string | null>;
  /** Registry of per-segment "flush the pending debounced edit now" callbacks
   *  — a manual Refresh calls these before reading segment text, so it never
   *  translates what was on screen a moment ago instead of what the human
   *  just typed. See useTranslationQueue.ts's runBatch. */
  flushersRef: React.MutableRefObject<Map<string, () => void>>;
}

const EDIT_DEBOUNCE_MS = 150;

// Uncontrolled textarea, keyed on segment.id (never on text) — plan §6.
// React never writes `value` back on a normal render, so even a re-render
// that slips through the reference-stability guarantees cannot reset the
// caret. Text only gets pushed into the DOM element imperatively, and only
// when sourceRevision changes (a non-user write — see segment-store.ts) AND
// the field isn't the one currently focused.
export default function SourceCell({ segment, dispatch, activeSegmentIdRef, flushersRef }: SourceCellProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const revisionRef = useRef(segment.sourceRevision);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest typed value not yet dispatched into the store — read by
  // commitPending() so a flush can dispatch it immediately instead of
  // waiting out the debounce.
  const pendingRef = useRef<string | null>(null);

  const autoGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => { autoGrow(); }, [autoGrow]);

  // Only advance revisionRef when the DOM write actually happens. Advancing
  // it unconditionally (even on the early-return-because-focused branch)
  // used to mark a skipped write as "consumed" — the store's sourceText would
  // move on but the focused textarea would keep stale text with no future
  // effect run able to reconcile them, since the effect's deps wouldn't
  // change again on their own. handleBlur below catches up once focus moves
  // away.
  useEffect(() => {
    if (segment.sourceRevision === revisionRef.current) return;
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) {
      // Focused but not yet typed in, on a still-live row: keep showing what
      // the store has, so the operator's first keystroke edits the current
      // text rather than overwriting words that arrived after focus. Live
      // provisional text only grows at the end, so the caret offsets stay valid.
      if (segment.status !== 'PROVISIONAL' || pendingRef.current !== null) return;
      const { selectionStart, selectionEnd } = el;
      revisionRef.current = segment.sourceRevision;
      el.value = segment.sourceText;
      el.setSelectionRange(selectionStart, selectionEnd);
      autoGrow();
      return;
    }
    revisionRef.current = segment.sourceRevision;
    el.value = segment.sourceText;
    autoGrow();
  }, [segment.sourceRevision, segment.sourceText, segment.status, autoGrow]);

  const commitPending = useCallback(() => {
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    const value = pendingRef.current;
    pendingRef.current = null;
    if (value !== null) dispatch({ type: 'EDIT_SOURCE', id: segment.id, sourceText: value, now: Date.now() });
  }, [dispatch, segment.id]);

  // Register so refreshOne/refreshAll can flush this row before building a
  // translation batch. On unmount, flush rather than discard — a segment
  // scrolled out of view (e.g. by APPEND_SEGMENT unmounting/remounting rows)
  // must never silently lose an edit still sitting in the debounce window.
  useEffect(() => {
    flushersRef.current.set(segment.id, commitPending);
    return () => {
      flushersRef.current.delete(segment.id);
      commitPending();
    };
  }, [segment.id, commitPending, flushersRef]);

  const handleInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    autoGrow();
    pendingRef.current = e.currentTarget.value;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // First keystroke on a live row: commit synchronously so the row flips to
    // EDITED (and the ingest buffer hands it over) before any further live
    // update can land inside the debounce window and be overwritten.
    if (segment.status === 'PROVISIONAL') { commitPending(); return; }
    debounceRef.current = setTimeout(commitPending, EDIT_DEBOUNCE_MS);
  }, [autoGrow, commitPending, segment.status]);

  const handleBlur = useCallback(() => {
    commitPending();
    // If a provisional/ASR update arrived while this field was focused, the
    // sync effect above skipped writing it into the DOM (see its guard) —
    // catch up now that we're not fighting the user's cursor anymore.
    if (ref.current && segment.sourceRevision !== revisionRef.current) {
      revisionRef.current = segment.sourceRevision;
      ref.current.value = segment.sourceText;
      autoGrow();
    }
  }, [commitPending, segment.sourceRevision, segment.sourceText, autoGrow]);

  const isDirtyVisual = segment.status === 'EDITED';
  const isProvisional = segment.status === 'PROVISIONAL';

  return (
    <div className="relative">
      {isDirtyVisual && (
        <span
          className="absolute top-1.5 right-2 text-[10px] font-medium text-amber-600 dark:text-amber-400 pointer-events-none select-none"
          data-testid={`dirty-badge-${segment.id}`}
        >
          gewijzigd
        </span>
      )}
      {isProvisional && (
        <span
          className="absolute top-1.5 right-2 text-[10px] font-medium text-muted-foreground pointer-events-none select-none italic"
          data-testid={`provisional-badge-${segment.id}`}
        >
          voorlopig
        </span>
      )}
      <textarea
        ref={ref}
        defaultValue={segment.sourceText}
        onInput={handleInput}
        onFocus={() => { activeSegmentIdRef.current = segment.id; }}
        onBlur={handleBlur}
        data-segment-id={segment.id}
        data-testid={`source-${segment.id}`}
        rows={1}
        className={
          'w-full resize-none overflow-hidden bg-transparent px-3 py-2 pr-16 text-sm leading-relaxed rounded-md ' +
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
          (isDirtyVisual ? 'border-l-2 border-amber-400'
            : isProvisional ? 'border-l-2 border-dashed border-muted-foreground/40 italic'
            : 'border-l-2 border-transparent')
        }
      />
    </div>
  );
}
