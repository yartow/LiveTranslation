import { useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { BookOpen, Lock } from 'lucide-react';
import type { Segment } from '@/lib/sermon/segment-model';
import type { SegmentAction } from '@/lib/sermon/segment-store';
import { isNextRowChord } from '@/lib/sermon/hotkeys';
import { shouldSyncCellDom } from '@/lib/sermon/cell-sync';
import type { CellKind } from '@/lib/sermon/focus-cell';

interface TargetCellProps {
  segment: Segment;
  dispatch: React.Dispatch<SegmentAction>;
  activeSegmentIdRef: React.MutableRefObject<string | null>;
  /** Return in this cell: the grid moves to the same cell of the next row (or adds a row after the last). Must be stable. */
  onEnterNext?: (id: string, cell: CellKind) => void;
}

const EDIT_DEBOUNCE_MS = 120;

// Always an editable textarea (no pencil, no read-only mode): click and type.
// Typing is committed to the store as it happens — debounced, and at once on
// Enter/blur — so what the translator writes reaches listener phones within a
// moment (useListenerBroadcast diffs every store change) instead of only after
// the field loses focus. A committed change that differs from the current
// translatedText sets manualOverride=true, which — per the reducer guards in
// segment-store.ts — makes this row immune to every future automatic write
// (refresh, provisional update, live re-translation). Emptying the field and
// leaving it hands the row back to the translator (CLEAR_TARGET_MANUAL).
//
// Uncontrolled, same as SourceCell: React never writes `value` back on a normal
// render, so a re-render can't move the caret. Machine text (a finished
// translation, a scripture substitution) is pushed into the DOM imperatively.
export default function TargetCell({ segment, dispatch, activeSegmentIdRef, onEnterNext }: TargetCellProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest typed value not yet dispatched into the store.
  const pendingRef = useRef<string | null>(null);
  // What this cell last dispatched. The store echoes it back; that echo must not be written over the
  // textarea (see cell-sync.ts). Null once the store holds anything else.
  const lastCommittedRef = useRef<string | null>(null);
  // Always the latest segment, so the commit callbacks stay stable (the unmount flush must not re-run per render).
  const segmentRef = useRef(segment);
  segmentRef.current = segment;

  const autoGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // Push store text into the DOM, unless the translator is mid-typing (their next
  // commit replaces it anyway) or the store text is just our own commit coming back
  // (shouldSyncCellDom). Layout effect: the DOM must be current before the
  // browser delivers the next keystroke.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const focused = document.activeElement === el;
    if (shouldSyncCellDom({
      domValue: el.value, storeValue: segment.translatedText, focused,
      hasPending: pendingRef.current !== null, lastCommitted: lastCommittedRef.current,
    })) {
      const { selectionStart, selectionEnd } = el;
      el.value = segment.translatedText;
      if (focused) el.setSelectionRange(selectionStart, selectionEnd);
    }
    if (segment.translatedText !== lastCommittedRef.current) lastCommittedRef.current = null;
    autoGrow();
  }, [segment.translatedText, autoGrow]);

  const commitPending = useCallback(() => {
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    const typed = pendingRef.current;
    pendingRef.current = null;
    // Read the textarea, not just the last `input` value: a text expander (Typinator) can put its
    // expansion in without an `input` event, and committing the stale value would then make the
    // store's echo overwrite it. After unmount there is no element, so the typed value is all there is.
    const el = ref.current;
    const value = el ? el.value : typed;
    if (value === null) return;
    if (typed !== null && value !== typed) {
      console.warn(`[TargetCell] ${segmentRef.current.id}: textarea changed without an input event (typed ${JSON.stringify(typed.slice(-40))}, now ${JSON.stringify(value.slice(-40))}) — text expander?`);
    }
    const seg = segmentRef.current;
    if (value === seg.translatedText) return;
    lastCommittedRef.current = value;
    dispatch({ type: 'SET_TARGET_MANUAL', id: seg.id, translatedText: value, now: Date.now() });
  }, [dispatch]);

  // Flush rather than discard on unmount — a row scrolled out of view mid-edit must not lose the last keystrokes.
  useEffect(() => () => commitPending(), [commitPending]);

  const handleInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    autoGrow();
    pendingRef.current = e.currentTarget.value;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(commitPending, EDIT_DEBOUNCE_MS);
  }, [autoGrow, commitPending]);

  const handleBlur = useCallback(() => {
    commitPending();
    // An emptied field gives the row back to the translator. Unconditional on purpose:
    // segmentRef may not have seen the SET_TARGET_MANUAL just dispatched above, and the
    // reducer ignores CLEAR_TARGET_MANUAL on a row that isn't a manual override.
    if (ref.current?.value === '') dispatch({ type: 'CLEAR_TARGET_MANUAL', id: segmentRef.current.id });
  }, [commitPending, dispatch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { e.currentTarget.blur(); return; }
    // Plain Enter = "send this now and go to the next row" (Shift+Enter still inserts a newline;
    // Cmd/Ctrl+Enter is the refresh hotkey).
    if (!e.nativeEvent.isComposing && isNextRowChord({ metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, code: e.code, key: e.key })) {
      e.preventDefault();
      commitPending();
      onEnterNext?.(segmentRef.current.id, 'target');
    }
  }, [commitPending, onEnterNext]);

  const isScripture = segment.status === 'SCRIPTURE';
  // A SCRIPTURE segment is exact quoted verse text, not a model translation —
  // it should never read as "stale" the way a not-yet-(re)translated row does.
  const isStale = segment.status !== 'TRANSLATED' && !isScripture && !segment.manualOverride;

  return (
    <div className="relative" data-testid={`target-${segment.id}`}>
      {isScripture && !segment.manualOverride && segment.scripture && (
        <div
          className="flex items-center gap-1 px-3 pt-1.5 text-[10px] font-medium text-indigo-500 dark:text-indigo-400"
          title={`${segment.scripture.reference} (${segment.scripture.version}) — exact verse text, not a model translation`}
          data-testid={`scripture-reference-${segment.id}`}
        >
          <BookOpen className="w-3 h-3" />
          {segment.scripture.reference} · {segment.scripture.version}
        </div>
      )}
      {segment.manualOverride && (
        <Lock className="absolute top-2.5 right-2 w-3 h-3 text-blue-500 pointer-events-none" aria-label="Manually edited" />
      )}
      <textarea
        ref={ref}
        defaultValue={segment.translatedText}
        onInput={handleInput}
        onFocus={() => { activeSegmentIdRef.current = segment.id; }}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        data-segment-id={segment.id}
        data-cell="target"
        data-testid={`target-edit-${segment.id}`}
        aria-label="Translation"
        placeholder={segment.status === 'TRANSLATING' ? '…' : 'Type translation…'}
        rows={1}
        className={
          'w-full resize-none overflow-hidden bg-transparent px-3 py-2 pr-7 text-sm leading-relaxed rounded-md border-l-2 min-h-[2.25rem] ' +
          'placeholder:italic placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
          (segment.manualOverride ? 'border-blue-400' : isScripture ? 'border-indigo-400' : 'border-transparent') +
          (isStale ? ' opacity-60 focus:opacity-100' : '')
        }
      />
    </div>
  );
}
