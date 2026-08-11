// Pure keyboard-chord predicates for sermon mode (plan §7). Kept dependency-
// and DOM-free (no `window`/`document` reference) so they're testable with
// plain object literals shaped like KeyboardEvent, and so the actual
// preventDefault/capture-phase wiring in SermonMode.tsx stays a thin shim
// around logic that's fully covered by tests/unit/sermon-hotkeys.test.ts.

export interface KeyChord {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  code: string;
}

const isEnterCode = (chord: KeyChord): boolean => chord.code === 'Enter' || chord.code === 'NumpadEnter';

/** Cmd/Ctrl+Shift+Enter — re-translate every dirty segment. */
export function isRefreshAllChord(chord: KeyChord): boolean {
  return (chord.metaKey || chord.ctrlKey) && chord.shiftKey && isEnterCode(chord);
}

/** Cmd/Ctrl+Enter (no Shift) — re-translate only the segment under the cursor. */
export function isRefreshOneChord(chord: KeyChord): boolean {
  return (chord.metaKey || chord.ctrlKey) && !chord.shiftKey && isEnterCode(chord);
}
