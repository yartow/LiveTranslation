// Moves the cursor to a segment's Dutch ("source") or English ("target") textarea.
// The cells tag themselves with data-segment-id + data-cell (SourceCell/TargetCell).

export type CellKind = 'source' | 'target';

/** Focuses the cell with the cursor at the end of its text; false if that row isn't in the DOM (yet). */
export function focusSegmentCell(id: string, cell: CellKind, root: ParentNode = document): boolean {
  const el = root.querySelector<HTMLTextAreaElement>(`[data-segment-id="${id}"][data-cell="${cell}"]`);
  if (!el) return false;
  el.focus({ preventScroll: true });
  el.setSelectionRange(el.value.length, el.value.length);
  el.scrollIntoView({ block: 'nearest' });
  return true;
}
