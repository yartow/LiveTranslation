import { useState, useRef, useCallback, useLayoutEffect } from 'react';
import { Lock, Pencil } from 'lucide-react';
import type { Segment } from '@/lib/sermon/segment-model';
import type { SegmentAction } from '@/lib/sermon/segment-store';

interface TargetCellProps {
  segment: Segment;
  dispatch: React.Dispatch<SegmentAction>;
  activeSegmentIdRef: React.MutableRefObject<string | null>;
}

// Read-only by default; a click on the pencil (or Enter/Space on the focused
// cell) switches to an editable textarea. Committing a change that differs
// from the current translatedText sets manualOverride=true, which — per the
// reducer guards in segment-store.ts — makes this row immune to every future
// automatic write (refresh, provisional update, live re-translation).
export default function TargetCell({ segment, dispatch, activeSegmentIdRef }: TargetCellProps) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const autoGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => { if (editing) autoGrow(); }, [editing, autoGrow]);

  const commit = useCallback(() => {
    const value = ref.current?.value ?? segment.translatedText;
    setEditing(false);
    if (value !== segment.translatedText) {
      dispatch({ type: 'SET_TARGET_MANUAL', id: segment.id, translatedText: value, now: Date.now() });
    }
  }, [dispatch, segment.id, segment.translatedText]);

  if (editing) {
    return (
      <textarea
        ref={ref}
        autoFocus
        defaultValue={segment.translatedText}
        onInput={autoGrow}
        onFocus={() => { activeSegmentIdRef.current = segment.id; }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
        data-segment-id={segment.id}
        data-testid={`target-edit-${segment.id}`}
        rows={1}
        className="w-full resize-none overflow-hidden bg-transparent px-3 py-2 text-sm leading-relaxed rounded-md border-l-2 border-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    );
  }

  const isStale = segment.status !== 'TRANSLATED' && !segment.manualOverride;

  return (
    <div
      className={
        'group relative w-full px-3 py-2 pr-7 text-sm leading-relaxed rounded-md border-l-2 min-h-[2.25rem] ' +
        (segment.manualOverride ? 'border-blue-400' : 'border-transparent') +
        (isStale ? ' opacity-60' : '')
      }
      data-segment-id={segment.id}
      data-testid={`target-${segment.id}`}
      tabIndex={0}
      onFocus={() => { activeSegmentIdRef.current = segment.id; }}
    >
      {segment.manualOverride && (
        <Lock className="inline-block w-3 h-3 mr-1 mb-0.5 text-blue-500" aria-label="Handmatig aangepast" />
      )}
      {segment.translatedText || <span className="text-muted-foreground italic">…</span>}
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="absolute top-1.5 right-1.5 text-muted-foreground/60 hover:text-foreground p-0.5 rounded transition-colors"
        aria-label="Vertaling handmatig bewerken"
        data-testid={`target-edit-button-${segment.id}`}
      >
        <Pencil className="w-3 h-3" />
      </button>
    </div>
  );
}
