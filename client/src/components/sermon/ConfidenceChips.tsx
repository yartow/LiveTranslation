import { useMemo, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { findWordIndex, type ConfidenceStore } from '@/lib/sermon/confidence-store';
import { selectWordInCell } from '@/lib/sermon/focus-cell';

interface ConfidenceChipsProps {
  segmentId: string;
  /** The row's current Dutch text. */
  text: string;
  store: ConfidenceStore;
}

// "check: Kik, evengeven" under a Dutch cell: words Whisper was unsure about. Renders nothing for most
// rows (no layout shift). Clicking a chip selects the word in the cell; × says it is fine.
export default function ConfidenceChips({ segmentId, text, store }: ConfidenceChipsProps) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  // `version` is the cache key: the store changed, so look again.
  const words = useMemo(() => store.flaggedIn(text), [store, text, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (words.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 px-3 pb-1.5 -mt-0.5" data-testid={`confidence-${segmentId}`}>
      <span className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">check</span>
      {words.map(word => (
        <span key={word} className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-300">
          <button
            type="button"
            onClick={() => selectWordInCell(segmentId, word, findWordIndex)}
            className="pl-2 pr-1 py-0.5 hover:underline"
            title="Whisper was unsure about this word — click to select it"
            data-testid="confidence-chip"
          >
            {word}
          </button>
          <button
            type="button"
            onClick={() => store.dismiss(word)}
            className="pr-1.5 pl-0.5 py-0.5 text-amber-700/70 hover:text-foreground dark:text-amber-300/70"
            aria-label={`“${word}” is fine`}
            title="This word is fine — stop flagging it"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
