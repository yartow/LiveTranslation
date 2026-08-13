import { useRef, useState, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { selectOrdered, type SegmentStoreState, type SegmentAction } from '@/lib/sermon/segment-store';
import SegmentRow from './SegmentRow';

interface SegmentGridProps {
  state: SegmentStoreState;
  dispatch: React.Dispatch<SegmentAction>;
  activeSegmentIdRef: React.MutableRefObject<string | null>;
  onRefreshOne: (id: string) => void;
  flushersRef: React.MutableRefObject<Map<string, () => void>>;
}

const NEAR_BOTTOM_PX = 80;

// Auto-scroll suppression (AC5): stick to the bottom only while the viewer
// is already near it AND nothing inside the grid is focused. Otherwise a
// "N nieuwe segmenten" pill appears instead of yanking the view out from
// under someone mid-edit or mid-read.
export default function SegmentGrid({ state, dispatch, activeSegmentIdRef, onRefreshOne, flushersRef }: SegmentGridProps) {
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

  const segments = selectOrdered(state);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-y-auto pb-14" data-testid="segment-grid">
        {segments.length === 0 && (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground px-6 text-center">
            Nog geen segmenten. Start de opname om te beginnen.
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
          {pendingNew} nieuwe segmenten <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
