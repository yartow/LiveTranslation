import { useRef, useState, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { selectOrdered, selectNextId, type SegmentStoreState, type SegmentAction } from '@/lib/sermon/segment-store';
import { focusSegmentCell, type CellKind } from '@/lib/sermon/focus-cell';
import type { ConfidenceStore } from '@/lib/sermon/confidence-store';
import SegmentRow from './SegmentRow';
import type { SourceSelection } from './AddToGlossaryBubble';

interface SegmentGridProps {
  state: SegmentStoreState;
  dispatch: React.Dispatch<SegmentAction>;
  activeSegmentIdRef: React.MutableRefObject<string | null>;
  onRefreshOne: (id: string) => void;
  flushersRef: React.MutableRefObject<Map<string, () => void>>;
  onSelectText: (selection: SourceSelection | null) => void;
  /** Adds a row after the last one (or focuses the last row if it is still blank) and puts the cursor in its `cell`. */
  onAddRow: (cell: CellKind) => void;
  /** A row SermonMode just added, to focus once it has rendered — see the ids.length effect below. */
  pendingFocusRef: React.MutableRefObject<{ id: string; cell: CellKind } | null>;
  confidenceStore: ConfidenceStore;
}

const NEAR_BOTTOM_PX = 80;

// Auto-scroll suppression (AC5): stick to the bottom only while the viewer
// is already near it AND nothing inside the grid is focused. Otherwise a
// "N nieuwe segmenten" pill appears instead of yanking the view out from
// under someone mid-edit or mid-read.
export default function SegmentGrid({ state, dispatch, activeSegmentIdRef, onRefreshOne, flushersRef, onSelectText, onAddRow, pendingFocusRef, confidenceStore }: SegmentGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pendingNew, setPendingNew] = useState(0);
  const prevCountRef = useRef(state.ids.length);
  const stickToBottomRef = useRef(true);

  const isNearBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    stickToBottomRef.current = isNearBottom() && !el.contains(document.activeElement);
    if (stickToBottomRef.current) setPendingNew(0);
  }, [isNearBottom]);

  useEffect(() => {
    const grew = state.ids.length - prevCountRef.current;
    prevCountRef.current = state.ids.length;
    // A row added by hand takes the cursor (and the view) with it; it is not a "new segment" pill.
    const pending = pendingFocusRef.current;
    if (pending && containerRef.current && focusSegmentCell(pending.id, pending.cell, containerRef.current)) {
      pendingFocusRef.current = null;
      return;
    }
    if (grew <= 0) return;
    const el = containerRef.current;
    const editingInside = !!el && el.contains(document.activeElement);
    if (stickToBottomRef.current && !editingInside) {
      requestAnimationFrame(() => { el?.scrollTo({ top: el.scrollHeight }); });
    } else {
      setPendingNew(n => n + grew);
    }
  }, [state.ids.length]);

  const jumpToBottom = useCallback(() => {
    const el = containerRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stickToBottomRef.current = true;
    setPendingNew(0);
  }, []);

  // Return in a cell: same cell of the next row, or a new row after the last. Stable (reads the
  // latest state through a ref) so the memoized rows don't re-render when segments change.
  const stateRef = useRef(state);
  stateRef.current = state;
  const handleEnterNext = useCallback((id: string, cell: CellKind) => {
    const next = selectNextId(stateRef.current, id);
    if (next) focusSegmentCell(next, cell, containerRef.current ?? document);
    else onAddRow(cell);
  }, [onAddRow]);

  const segments = selectOrdered(state);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-y-auto pb-14" data-testid="segment-grid">
        {segments.length === 0 && (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground px-6 text-center">
            No segments yet. Start recording, or use Add row to type one.
          </div>
        )}
        {segments.map(segment => (
          <SegmentRow
            key={segment.id}
            segment={segment}
            dispatch={dispatch}
            activeSegmentIdRef={activeSegmentIdRef}
            onRefreshOne={onRefreshOne}
            flushersRef={flushersRef}
            onSelectText={onSelectText}
            onEnterNext={handleEnterNext}
            confidenceStore={confidenceStore}
          />
        ))}
      </div>
      {pendingNew > 0 && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-primary text-primary-foreground text-xs font-medium px-3 py-1.5 shadow-md hover-elevate"
          data-testid="button-jump-to-new"
        >
          {pendingNew} new {pendingNew === 1 ? 'segment' : 'segments'} <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
