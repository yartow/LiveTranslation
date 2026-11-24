import { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { ChevronDown, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { TEXT_SIZE_EVENT } from '@/hooks/useAutoGrowOnResize';
import { visibleCell, type CollapsedColumn } from '@/lib/sermon/layout';
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
  /** A song link pasted into an "Add lyrics" row — see useLyricsInsert.ts. Must be stable. */
  onLyricsLink: (id: string, cell: CellKind, link: string) => void;
  /** Text size (px) of the Dutch/English cells, handed down as a CSS variable so no row re-renders. */
  textSize: number;
  /** Which column is hidden (display:none: the cells stay mounted, so focus, pending commits and DOM syncs survive). */
  collapsed: CollapsedColumn;
  onToggleColumn: (which: 'source' | 'target') => void;
}

// Ctrl, not Cmd, on macOS too (Chrome owns Cmd+1..8); Ctrl+Alt+1/2 also works — see hotkeys.ts.
const COLUMN_HINT = 'Ctrl+';

const NEAR_BOTTOM_PX = 80;

// Auto-scroll suppression (AC5): stick to the bottom only while the viewer
// is already near it AND nothing inside the grid is focused. Otherwise a
// "N nieuwe segmenten" pill appears instead of yanking the view out from
// under someone mid-edit or mid-read.
export default function SegmentGrid({ state, dispatch, activeSegmentIdRef, onRefreshOne, flushersRef, onSelectText, onAddRow, pendingFocusRef, confidenceStore, onLyricsLink, textSize, collapsed, onToggleColumn }: SegmentGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pendingNew, setPendingNew] = useState(0);
  const prevCountRef = useRef(state.ids.length);
  const stickToBottomRef = useRef(true);
  // Read by the stable callbacks / effects below without re-creating them.
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

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
    if (pending && containerRef.current && focusSegmentCell(pending.id, visibleCell(pending.cell, collapsedRef.current), containerRef.current)) {
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

  // Text size: the cells' heights are fixed in px, so tell them to re-measure (a font-size change alters
  // neither text nor width), and keep a view that was at the bottom at the bottom.
  const firstSizeRef = useRef(true);
  useLayoutEffect(() => {
    if (firstSizeRef.current) { firstSizeRef.current = false; return; }
    const el = containerRef.current;
    const wasAtBottom = stickToBottomRef.current;
    window.dispatchEvent(new Event(TEXT_SIZE_EVENT));
    if (wasAtBottom && el) el.scrollTo({ top: el.scrollHeight });
  }, [textSize]);

  // Hiding a column that holds the cursor: leave the cell first (blur commits any pending edit).
  useEffect(() => {
    if (collapsed === 'none') return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && containerRef.current?.contains(active) && active.dataset.cell === collapsed) active.blur();
  }, [collapsed]);

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
    // The cell in a hidden column cannot be focused: use the visible one.
    const target = visibleCell(cell, collapsedRef.current);
    if (next) focusSegmentCell(next, target, containerRef.current ?? document);
    else onAddRow(target);
  }, [onAddRow]);

  const segments = selectOrdered(state);

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="group/grid h-full overflow-y-auto pb-14"
        style={{ '--sermon-text-size': `${textSize}px` } as React.CSSProperties}
        data-collapsed={collapsed}
        data-testid="segment-grid"
      >
        {/* Column headers — same flex layout as a row (equal columns + the w-7 status column), so they line up. */}
        <div className="sticky top-0 z-10 flex items-center bg-background/95 backdrop-blur border-b border-border/60 text-xs text-muted-foreground" data-testid="column-headers">
          <div className="flex-1 min-w-0 flex items-center justify-between px-3 py-1 group-data-[collapsed=source]/grid:hidden">
            <span className="font-medium">Dutch</span>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onToggleColumn('source')}
              className="p-1 rounded hover:bg-accent hover:text-foreground"
              aria-label="Hide the Dutch column"
              title={`Hide the Dutch column (${COLUMN_HINT}1)`}
              data-testid="button-hide-source"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
          <div className="w-7 shrink-0 flex items-center justify-center">
            {collapsed === 'source' && (
              <button
                type="button"
                tabIndex={-1}
                onClick={() => onToggleColumn('source')}
                className="p-1 rounded text-foreground hover:bg-accent"
                aria-label="Show the Dutch column"
                title={`Show the Dutch column (${COLUMN_HINT}1)`}
                data-testid="button-show-source"
              >
                <PanelLeftOpen className="w-4 h-4" />
              </button>
            )}
            {collapsed === 'target' && (
              <button
                type="button"
                tabIndex={-1}
                onClick={() => onToggleColumn('target')}
                className="p-1 rounded text-foreground hover:bg-accent"
                aria-label="Show the English column"
                title={`Show the English column (${COLUMN_HINT}2)`}
                data-testid="button-show-target"
              >
                <PanelRightOpen className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="flex-1 min-w-0 flex items-center justify-between px-3 py-1 group-data-[collapsed=target]/grid:hidden">
            <span className="font-medium">English</span>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onToggleColumn('target')}
              className="p-1 rounded hover:bg-accent hover:text-foreground"
              aria-label="Hide the English column"
              title={`Hide the English column (${COLUMN_HINT}2)`}
              data-testid="button-hide-target"
            >
              <PanelRightClose className="w-4 h-4" />
            </button>
          </div>
        </div>
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
            onLyricsLink={onLyricsLink}
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
