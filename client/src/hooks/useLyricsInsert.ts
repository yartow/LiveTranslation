// "Add lyrics" (CLAUDE.md "Song lyrics"): the toolbar button adds a pending lyrics row; a song link pasted
// into it is fetched through the server (GET /api/lyrics -> server/lib/allsongs.ts) and the row is replaced,
// in place, by the song's rows (lib/sermon/lyrics.ts's lyricsRows -> REPLACE_WITH_LYRICS).

import { useCallback, useRef } from 'react';
import { lyricsRows, type LyricsCell, type SongLyrics } from '@/lib/sermon/lyrics';
import { nextSegmentId, type SegmentAction, type SegmentStoreState } from '@/lib/sermon/segment-store';
import { focusSegmentCell, type CellKind } from '@/lib/sermon/focus-cell';
import type { useToast } from './use-toast';
import { useLatest } from './useLatest';

type Toast = ReturnType<typeof useToast>['toast'];

async function fetchLyrics(link: string): Promise<{ song: SongLyrics; english?: SongLyrics }> {
  const res = await fetch(`/api/lyrics?url=${encodeURIComponent(link)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.song) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

export function useLyricsInsert(opts: {
  stateRef: React.MutableRefObject<SegmentStoreState>;
  dispatch: (action: SegmentAction) => void;
  /** SegmentGrid focuses this row once it has rendered (same mechanism as Add row). */
  pendingFocusRef: React.MutableRefObject<{ id: string; cell: CellKind } | null>;
  toast: Toast;
}): { addLyricsRow: () => void; onLyricsLink: (id: string, cell: CellKind, link: string) => void } {
  const { stateRef, dispatch, pendingFocusRef } = opts;
  const toastRef = useLatest(opts.toast);
  // Rows whose song is being fetched: a second paste into the same row is ignored meanwhile.
  const loadingRef = useRef(new Set<string>());

  const addLyricsRow = useCallback(() => {
    const s = stateRef.current;
    const last = s.ids.length ? s.byId[s.ids[s.ids.length - 1]] : undefined;
    // An empty pending row is already waiting at the end: go there instead of stacking another.
    if (last?.lyrics?.part === 'pending') {
      focusSegmentCell(last.id, 'target');
      return;
    }
    const id = nextSegmentId(s);
    const t = last?.endTime ?? 0;
    pendingFocusRef.current = { id, cell: 'target' };
    dispatch({
      type: 'APPEND_SEGMENT', id, sourceText: '', startTime: t, endTime: t, approximateTiming: true,
      lyrics: { part: 'pending' }, now: Date.now(),
    });
  }, [dispatch, stateRef, pendingFocusRef]);

  const onLyricsLink = useCallback((id: string, cell: CellKind, link: string) => {
    if (loadingRef.current.has(id)) return;
    loadingRef.current.add(id);
    toastRef.current({ title: 'Loading song…', description: link });
    fetchLyrics(link)
      .then(({ song, english }) => {
        if (stateRef.current.byId[id]?.lyrics?.part !== 'pending') return; // the row was removed meanwhile
        const plan = lyricsRows(song, english, cell as LyricsCell);
        if (!plan.rows.length) {
          toastRef.current({ title: 'This song has no lyrics in AllSongs', variant: 'destructive' });
          return;
        }
        dispatch({ type: 'REPLACE_WITH_LYRICS', id, rows: plan.rows, now: Date.now() });
        const verses = plan.rows.filter(r => r.lyrics.part === 'verse').length;
        const how = plan.english === 'as-is' ? 'English'
          : plan.english === 'from-allsongs' ? 'English version from AllSongs'
          : 'being translated';
        toastRef.current({
          title: `Added “${song.title ?? 'song'}”`,
          description: [`${verses} ${verses === 1 ? 'part' : 'parts'}, ${how}.`, ...plan.warnings].join(' '),
        });
      })
      .catch(err => toastRef.current({
        title: 'Could not add the song',
        description: err instanceof Error ? err.message : 'AllSongs did not answer',
        variant: 'destructive',
      }))
      .finally(() => loadingRef.current.delete(id));
  }, [dispatch, stateRef, toastRef]);

  return { addLyricsRow, onLyricsLink };
}
