import { memo } from 'react';
import { AlertCircle, AlertTriangle, BookOpen, Clock, Loader2, RefreshCw } from 'lucide-react';
import type { Segment } from '@/lib/sermon/segment-model';
import type { SegmentAction } from '@/lib/sermon/segment-store';
import { isMacPlatform } from '@/lib/platform';
import SourceCell from './SourceCell';
import TargetCell from './TargetCell';

const REFRESH_ONE_HINT = isMacPlatform ? '⌘⏎' : 'Ctrl+⏎';

interface SegmentRowProps {
  segment: Segment;
  dispatch: React.Dispatch<SegmentAction>;
  activeSegmentIdRef: React.MutableRefObject<string | null>;
  onRefreshOne: (id: string) => void;
  flushersRef: React.MutableRefObject<Map<string, () => void>>;
}

// Single scroll-container row: source and target are two flex children of
// ONE row, not two independently-scrolled panes (plan §6) — that is what
// makes left/right alignment exact by construction, with no scroll-sync
// logic to get wrong.
//
// Memoized on the segment object reference. Because segment-store.ts only
// ever replaces the touched id's object, appending a new segment or
// translating a different one re-renders zero unrelated rows — that's the
// primary mechanism (ahead of the uncontrolled-input trick in SourceCell)
// behind "editing survives new segments streaming in".
function SegmentRowImpl({ segment, dispatch, activeSegmentIdRef, onRefreshOne, flushersRef }: SegmentRowProps) {
  return (
    <div
      className="flex items-stretch flex-col md:flex-row border-b border-border/60 last:border-b-0"
      data-testid={`row-${segment.id}`}
    >
      <div className="flex-1 min-w-0 md:border-r border-border/60">
        <SourceCell segment={segment} dispatch={dispatch} activeSegmentIdRef={activeSegmentIdRef} flushersRef={flushersRef} />
      </div>

      <div className="flex md:flex-col items-center justify-center md:w-7 shrink-0 py-1 md:py-2.5">
        {segment.status === 'TRANSLATING' && (
          <button
            type="button"
            onClick={() => onRefreshOne(segment.id)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Opnieuw proberen als dit blijft hangen"
            title="Wordt vertaald — klik om opnieuw te proberen als dit blijft hangen"
            data-testid={`refresh-${segment.id}`}
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          </button>
        )}
        {segment.status === 'PROVISIONAL' && (
          <button
            type="button"
            onClick={() => onRefreshOne(segment.id)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Voorlopige tekst nu al vertalen"
            title={`Voorlopig — nu al vertalen (${REFRESH_ONE_HINT})`}
            data-testid={`refresh-${segment.id}`}
          >
            <Clock className="w-3.5 h-3.5" />
          </button>
        )}
        {segment.status === 'ERROR' && (
          <button
            type="button"
            onClick={() => onRefreshOne(segment.id)}
            className="text-destructive hover:opacity-70"
            aria-label={`Opnieuw proberen — ${segment.error ?? 'fout'}`}
            title={segment.error}
            data-testid={`retry-${segment.id}`}
          >
            <AlertCircle className="w-3.5 h-3.5" />
          </button>
        )}
        {(segment.status === 'EDITED' || segment.status === 'PENDING') && (
          <button
            type="button"
            onClick={() => onRefreshOne(segment.id)}
            className="text-muted-foreground/50 hover:text-foreground transition-colors"
            aria-label="Dit segment opnieuw vertalen"
            title={`Alleen dit segment vertalen (${REFRESH_ONE_HINT})`}
            data-testid={`refresh-${segment.id}`}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}
        {segment.status === 'SCRIPTURE' && (
          <button
            type="button"
            onClick={() => dispatch({ type: 'CLEAR_SCRIPTURE', id: segment.id, now: Date.now() })}
            className="text-blue-500/70 hover:text-foreground transition-colors"
            aria-label={`Schriftcitaat (${segment.scripture?.reference ?? ''}, ${segment.scripture?.version ?? ''}) — klik om als gewone vertaling te behandelen`}
            title={`${segment.scripture?.reference ?? 'Schriftcitaat'} (${segment.scripture?.version ?? ''}) — exacte verstekst, geen model-vertaling. Klik om als gewone zin te vertalen.`}
            data-testid={`scripture-badge-${segment.id}`}
          >
            <BookOpen className="w-3.5 h-3.5" />
          </button>
        )}
        {segment.status === 'TRANSLATED' && segment.glossaryWarnings && segment.glossaryWarnings.length > 0 && (
          <span
            role="img"
            aria-label={`Woordenlijst-controle: ${segment.glossaryWarnings.map(w => `${w.term} → ${w.expected}`).join(', ')}`}
            title={segment.glossaryWarnings.map(w => `Verwacht "${w.expected}" voor "${w.term}"`).join('\n')}
          >
            <AlertTriangle
              className="w-3.5 h-3.5 text-amber-500/70"
              data-testid={`glossary-warn-${segment.id}`}
            />
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <TargetCell segment={segment} dispatch={dispatch} activeSegmentIdRef={activeSegmentIdRef} />
      </div>
    </div>
  );
}

export default memo(SegmentRowImpl, (prev, next) =>
  prev.segment === next.segment && prev.dispatch === next.dispatch &&
  prev.onRefreshOne === next.onRefreshOne && prev.flushersRef === next.flushersRef,
);
