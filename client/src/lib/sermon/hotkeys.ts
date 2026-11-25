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
  altKey?: boolean;
  /** KeyboardEvent.key. Soft keyboards (iOS, Android) send key 'Enter' with an empty `code`, so Enter is matched on either. */
  key?: string;
  /** KeyboardEvent.isComposing — an IME is mid-composition; never treat the key as a shortcut. */
  isComposing?: boolean;
}

const isEnterCode = (chord: KeyChord): boolean => chord.code === 'Enter' || chord.code === 'NumpadEnter' || chord.key === 'Enter';

/** Cmd/Ctrl+Shift+Enter — re-translate every dirty segment. */
export function isRefreshAllChord(chord: KeyChord): boolean {
  return (chord.metaKey || chord.ctrlKey) && chord.shiftKey && isEnterCode(chord);
}

/** Cmd/Ctrl+Enter (no Shift) — re-translate only the segment under the cursor. */
export function isRefreshOneChord(chord: KeyChord): boolean {
  return (chord.metaKey || chord.ctrlKey) && !chord.shiftKey && isEnterCode(chord);
}

/** Plain Enter (no Shift/Cmd/Ctrl/Alt) in a segment cell — save it and move to the same cell in the next row. */
export function isNextRowChord(chord: KeyChord): boolean {
  return !chord.metaKey && !chord.ctrlKey && !chord.shiftKey && !chord.altKey && isEnterCode(chord);
}

// ── Layout chords (text size, hidden column, collapsed header) ──────────────────────────────────
// Ctrl, not Cmd, on macOS too: Chrome uses Cmd+1..8 for tabs and Cmd+= / Cmd+- for browser zoom.
// Ctrl+1..3 can be swallowed before the page sees it (macOS "Switch to Desktop N" when enabled,
// Chrome's tab switching on Windows/Linux), so Ctrl+Alt+1..3 works as well. Matched on `code` and
// `key` (Alt changes `key` on macOS, soft keyboards send an empty `code`).

const isDigitKey = (chord: KeyChord, n: 1 | 2 | 3): boolean =>
  chord.code === `Digit${n}` || chord.code === `Numpad${n}` || chord.key === String(n);

const isDigitChord = (chord: KeyChord, n: 1 | 2 | 3): boolean =>
  !chord.isComposing && chord.ctrlKey && !chord.metaKey && !chord.shiftKey && isDigitKey(chord, n);

/** Ctrl+1 / Ctrl+Alt+1 — hide or show the Dutch column. */
export function isToggleSourceChord(chord: KeyChord): boolean { return isDigitChord(chord, 1); }
/** Ctrl+2 / Ctrl+Alt+2 — hide or show the English column. */
export function isToggleTargetChord(chord: KeyChord): boolean { return isDigitChord(chord, 2); }
/** Ctrl+3 / Ctrl+Alt+3 — collapse or expand the header block. */
export function isToggleHeaderChord(chord: KeyChord): boolean { return isDigitChord(chord, 3); }

const isTextSizeChord = (chord: KeyChord, codes: string[], keys: string[]): boolean =>
  !chord.isComposing && chord.ctrlKey && !chord.metaKey && !chord.altKey
  && (codes.includes(chord.code) || (chord.key !== undefined && keys.includes(chord.key)));

/** Ctrl+= / Ctrl++ (Shift irrelevant) — bigger transcript/translation text. */
export function isTextBiggerChord(chord: KeyChord): boolean {
  return isTextSizeChord(chord, ['Equal', 'NumpadAdd'], ['=', '+']);
}
/** Ctrl+- — smaller transcript/translation text. */
export function isTextSmallerChord(chord: KeyChord): boolean {
  return isTextSizeChord(chord, ['Minus', 'NumpadSubtract'], ['-', '_']);
}
