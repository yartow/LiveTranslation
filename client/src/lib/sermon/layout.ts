// Pure helpers for the sermon page's layout switches (text size, hidden column).
// DOM-free so tests/unit/sermon-layout.test.ts can cover them with plain values.

export const TEXT_SIZE_MIN = 12;
export const TEXT_SIZE_MAX = 120;
export const TEXT_SIZE_DEFAULT = 14; // = Tailwind text-sm, what the cells used before this setting existed
export const TEXT_SIZE_STEP = 2;

export function clampTextSize(px: number): number {
  if (typeof px !== 'number' || Number.isNaN(px)) return TEXT_SIZE_DEFAULT;
  return Math.max(TEXT_SIZE_MIN, Math.min(TEXT_SIZE_MAX, Math.round(px)));
}

/** One A-/A+ step. Below 40 px the steps are 2 px; above, they grow (about 10%) so 14 -> 120 does not take 53 clicks. */
export function stepTextSize(px: number, direction: 1 | -1): number {
  const cur = clampTextSize(px);
  const step = cur >= 40 ? Math.max(TEXT_SIZE_STEP, Math.round(cur * 0.1 / 2) * 2) : TEXT_SIZE_STEP;
  return clampTextSize(cur + direction * step);
}

/**
 * Which column is hidden. One value, not two booleans: both columns can never
 * be hidden at once, by construction.
 */
export type CollapsedColumn = 'none' | 'source' | 'target';
export const COLLAPSED_COLUMNS: readonly CollapsedColumn[] = ['none', 'source', 'target'];

/**
 * Ctrl+1 / Ctrl+2: toggle one column. Pressing the key of the hidden column shows it again;
 * pressing the other column's key while one is hidden swaps (the hidden one is shown again, the
 * other hidden) — never both hidden.
 */
export function toggleColumn(current: CollapsedColumn, which: 'source' | 'target'): CollapsedColumn {
  return current === which ? 'none' : which;
}

/** The cell to focus when `wanted` is hidden: the other one. */
export function visibleCell(wanted: 'source' | 'target', collapsed: CollapsedColumn): 'source' | 'target' {
  if (collapsed !== wanted) return wanted;
  return wanted === 'source' ? 'target' : 'source';
}
