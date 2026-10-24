import { useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import type { Segment } from '@/lib/sermon/segment-model';
import type { SegmentAction } from '@/lib/sermon/segment-store';
import { isNextRowChord } from '@/lib/sermon/hotkeys';
import type { CellKind } from '@/lib/sermon/focus-cell';
import type { SourceSelection } from './AddToGlossaryBubble';

interface SourceCellProps {
  segment: Segment;
  dispatch: React.Dispatch<SegmentAction>;
  activeSegmentIdRef: React.MutableRefObject<string | null>;
  /** Registry of per-segment "flush the pending debounced edit now" callbacks
   *  — a manual Refresh calls these before reading segment text, so it never
   *  translates what was on screen a moment ago instead of what the human
   *  just typed. See useTranslationQueue.ts's runBatch. */
  flushersRef: React.MutableRefObject<Map<string, () => void>>;
  /** Reports the highlighted words (or null once the selection is gone) — drives the "Add to glossary" bubble. Must be a stable callback. */
  onSelectText?: (selection: SourceSelection | null) => void;
  /** Return in this cell: the grid moves to the same cell of the next row (or adds a row after the last). Must be stable. */
  onEnterNext?: (id: string, cell: CellKind) => void;
}

const EDIT_DEBOUNCE_MS = 150;
/** A glossary entry is a word or short phrase; a longer highlight is a copy/paste, not a term. */
const MAX_SELECTION_CHARS = 80;

// Uncontrolled textarea, keyed on segment.id (never on text) — plan §6.
// React never writes `value` back on a normal render, so even a re-render
// that slips through the reference-stability guarantees cannot reset the
// caret. Text only gets pushed into the DOM element imperatively, and only
// when sourceRevision changes (a non-user write — see segment-store.ts) AND
// the field isn't the one currently focused.
export default function SourceCell({ segment, dispatch, activeSegmentIdRef, flushersRef, onSelectText, onEnterNext }: SourceCellProps) {
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
  // Layout effect: the DOM must be current before the browser can deliver the
  // operator's next keystroke, which would otherwise be applied to stale text.
  useLayoutEffect(() => {
    if (segment.sourceRevision === revisionRef.current) return;
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) {
      // Focused but not yet typed in: keep showing what the store has, so the
      // operator's first keystroke edits the current text rather than
      // overwriting words that arrived after focus (or resurrecting text a
      // finalized row no longer holds — completing a live row can cut it back
      // to its complete sentences). Only a write landing on a row the operator
      // has typed into is held back; handleBlur catches that one up. The
      // selection is restored; the browser clamps it if the text got shorter.
      if (pendingRef.current !== null) return;
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

  // Plain Return = "done with this row, on to the next" (Shift+Return still inserts a newline;
  // Cmd/Ctrl+Return is the refresh hotkey). A live row only changes focus here — nothing is typed.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (isNextRowChord({ metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, code: e.code, key: e.key })) {
      e.preventDefault();
      commitPending();
      onEnterNext?.(segment.id, 'source');
    }
  }, [commitPending, onEnterNext, segment.id]);

  // A textarea's selection is not in window.getSelection() — read it from the element.
  // Mouse selections anchor the bubble at the pointer, keyboard ones at the cell.
  const reportSelection = useCallback((pointer?: { x: number; y: number }) => {
    const el = ref.current;
    if (!el || !onSelectText) return;
    let { selectionStart: start, selectionEnd: end } = el;
    const raw = el.value.slice(start, end);
    const text = raw.trim();
    if (start === end || !text || text.length > MAX_SELECTION_CHARS) { onSelectText(null); return; }
    start += raw.length - raw.trimStart().length;
    end = start + text.length;
    const rect = el.getBoundingClientRect();
    onSelectText({
      segmentId: segment.id, start, end, text,
      x: pointer?.x ?? rect.left + 16,
      y: pointer?.y ?? rect.top,
    });
  }, [onSelectText, segment.id]);

  const isDirtyVisual = segment.status === 'EDITED';
  const isProvisional = segment.status === 'PROVISIONAL';

  return (
    <div className="relative">
      {isDirtyVisual && (
        <span
          className="absolute top-1.5 right-2 text-[10px] font-medium text-amber-600 dark:text-amber-400 pointer-events-none select-none"
          data-testid={`dirty-badge-${segment.id}`}
        >
          edited
        </span>
      )}
      {isProvisional && (
        <span
          className="absolute top-1.5 right-2 text-[10px] font-medium text-muted-foreground pointer-events-none select-none italic"
          data-testid={`provisional-badge-${segment.id}`}
        >
          provisional
        </span>
      )}
      <textarea
        ref={ref}
        defaultValue={segment.sourceText}
        onInput={handleInput}
        onFocus={() => { activeSegmentIdRef.current = segment.id; }}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onMouseUp={(e) => reportSelection({ x: e.clientX, y: e.clientY })}
        // Escape dismisses the bubble but leaves the highlight in place, so it must not re-report it.
        onKeyUp={(e) => { if (e.key !== 'Escape') reportSelection(); }}
        data-segment-id={segment.id}
        data-cell="source"
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
