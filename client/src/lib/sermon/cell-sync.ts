// When may the store's text be written into an uncontrolled translation textarea? Pure and DOM-free so
// the rule is unit-testable (the tests run in node, without a DOM).
//
// The 28 Oct service lost Typinator expansions in the English cells: the expander deleted its `;h`
// (committed by the 120 ms debounce) and the expansion text then vanished. A commit dispatches the
// text it read, the store echoes it back, and the old rule ("DOM differs from the store and nothing
// is pending") then wrote the echo over text that reached the textarea after that read.

export interface CellSyncInput {
  /** What the textarea shows right now. */
  domValue: string;
  /** What the store holds for this row. */
  storeValue: string;
  /** The textarea has keyboard focus. */
  focused: boolean;
  /** The operator typed something that the debounce has not committed yet. */
  hasPending: boolean;
  /** The text this cell itself last committed to the store; null once the store has moved on to something else. */
  lastCommitted: string | null;
}

export function shouldSyncCellDom({ domValue, storeValue, focused, hasPending, lastCommitted }: CellSyncInput): boolean {
  if (domValue === storeValue) return false;
  // Not being edited: the store is the truth.
  if (!focused) return true;
  // Mid-typing: the next commit replaces the store text anyway.
  if (hasPending) return false;
  // Focused, nothing pending, and the store text is our own commit coming back: the textarea can only be
  // ahead of it (text inserted without an `input` event), never behind. Anything else is machine text.
  return storeValue !== lastCommitted;
}
