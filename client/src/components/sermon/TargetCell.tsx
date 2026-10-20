import { useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { BookOpen, Lock } from 'lucide-react';
import type { Segment } from '@/lib/sermon/segment-model';
import type { SegmentAction } from '@/lib/sermon/segment-store';

interface TargetCellProps {
  segment: Segment;
  dispatch: React.Dispatch<SegmentAction>;
  activeSegmentIdRef: React.MutableRefObject<string | null>;
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
export default function TargetCell({ segment, dispatch, activeSegmentIdRef }: TargetCellProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest typed value not yet dispatched into the store.
  const pendingRef = useRef<string | null>(null);
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
  // commit replaces it anyway). Layout effect: the DOM must be current before the
  // browser delivers the next keystroke.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.value !== segment.translatedText && !(document.activeElement === el && pendingRef.current !== null)) {
      const { selectionStart, selectionEnd } = el;
      el.value = segment.translatedText;
      if (document.activeElement === el) el.setSelectionRange(selectionStart, selectionEnd);
    }
    autoGrow();
  }, [segment.translatedText, autoGrow]);

  const commitPending = useCallback(() => {
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    const value = pendingRef.current;
    pendingRef.current = null;
    if (value === null) return;
    const seg = segmentRef.current;
    if (value === seg.translatedText) return;
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
    // Plain Enter = "send this now" (Shift+Enter still inserts a newline; Cmd/Ctrl+Enter is the refresh hotkey).
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commitPending();
    }
  }, [commitPending]);

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
