import { useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import type { Segment } from '@/lib/sermon/segment-model';
import type { SegmentAction } from '@/lib/sermon/segment-store';

interface SourceCellProps {
  segment: Segment;
  dispatch: React.Dispatch<SegmentAction>;
  activeSegmentIdRef: React.MutableRefObject<string | null>;
}

const EDIT_DEBOUNCE_MS = 150;

// Uncontrolled textarea, keyed on segment.id (never on text) — plan §6.
// React never writes `value` back on a normal render, so even a re-render
// that slips through the reference-stability guarantees cannot reset the
// caret. Text only gets pushed into the DOM element imperatively, and only
// when sourceRevision changes (a non-user write — see segment-store.ts) AND
// the field isn't the one currently focused.
export default function SourceCell({ segment, dispatch, activeSegmentIdRef }: SourceCellProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const revisionRef = useRef(segment.sourceRevision);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const autoGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => { autoGrow(); }, [autoGrow]);

  useEffect(() => {
    if (segment.sourceRevision === revisionRef.current) return;
    revisionRef.current = segment.sourceRevision;
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    el.value = segment.sourceText;
    autoGrow();
  }, [segment.sourceRevision, segment.sourceText, autoGrow]);

  const handleInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    autoGrow();
    const value = e.currentTarget.value;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      dispatch({ type: 'EDIT_SOURCE', id: segment.id, sourceText: value, now: Date.now() });
    }, EDIT_DEBOUNCE_MS);
  }, [autoGrow, dispatch, segment.id]);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

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
