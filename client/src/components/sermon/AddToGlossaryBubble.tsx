import { useEffect, useRef } from 'react';
import { BookA } from 'lucide-react';

/** The words highlighted in a source cell. x/y are viewport coordinates of the pointer (or of the cell, for a keyboard selection). */
export interface SourceSelection {
  segmentId: string;
  start: number;
  end: number;
  text: string;
  x: number;
  y: number;
}

interface AddToGlossaryBubbleProps {
  selection: SourceSelection;
  onAdd: () => void;
  onDismiss: () => void;
}

const BUBBLE_WIDTH = 150;

// The small "Add to glossary" button that floats over highlighted words. Esc or a
// click anywhere else dismisses it.
export default function AddToGlossaryBubble({ selection, onAdd, onDismiss }: AddToGlossaryBubbleProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Capture phase, so Esc closes the bubble before anything underneath reacts to it.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [onDismiss]);

  const left = Math.max(8, Math.min(selection.x - BUBBLE_WIDTH / 2, window.innerWidth - BUBBLE_WIDTH - 8));
  const top = Math.max(8, selection.y - 44);

  return (
    <div ref={ref} className="fixed z-40" style={{ left, top }} data-testid="glossary-bubble">
      <button
        type="button"
        // Keep the focus (and the highlight) in the cell: a click on the bubble must not blur the textarea.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onAdd}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg hover:opacity-90"
        data-testid="button-add-to-glossary"
      >
        <BookA className="h-3.5 w-3.5" />
        Add to glossary
      </button>
    </div>
  );
}
