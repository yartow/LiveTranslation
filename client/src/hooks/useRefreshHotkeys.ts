import { useEffect } from 'react';
import { isRefreshAllChord, isRefreshOneChord, type KeyChord } from '@/lib/sermon/hotkeys';

/**
 * Cmd/Ctrl+Shift+Enter (refresh all) and Cmd/Ctrl+Enter (refresh the segment
 * under the cursor) — capture phase on window so preventDefault wins even
 * while the cursor is inside a source textarea (AC10). See hotkeys.ts for the
 * chord predicates and the plan §7 for why capture.
 */
export function useRefreshHotkeys(
  refreshAll: () => void,
  refreshOne: (id: string | null) => void,
  activeSegmentIdRef: React.MutableRefObject<string | null>,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      const chord: KeyChord = { metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, code: e.code };
      if (isRefreshAllChord(chord)) {
        e.preventDefault(); e.stopPropagation();
        refreshAll();
      } else if (isRefreshOneChord(chord)) {
        e.preventDefault(); e.stopPropagation();
        refreshOne(activeSegmentIdRef.current);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [refreshAll, refreshOne, activeSegmentIdRef]);
}
