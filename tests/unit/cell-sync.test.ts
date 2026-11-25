import { describe, it, expect } from 'vitest';
import { shouldSyncCellDom, type CellSyncInput } from '../../client/src/lib/sermon/cell-sync.js';

const base: CellSyncInput = { domValue: 'a', storeValue: 'b', focused: true, hasPending: false, lastCommitted: null };

describe('shouldSyncCellDom', () => {
  it('does nothing when the textarea already shows the store text', () => {
    expect(shouldSyncCellDom({ ...base, domValue: 'same', storeValue: 'same' })).toBe(false);
    expect(shouldSyncCellDom({ ...base, domValue: 'same', storeValue: 'same', focused: false })).toBe(false);
  });

  it('always follows the store while the cell is not being edited', () => {
    expect(shouldSyncCellDom({ ...base, focused: false })).toBe(true);
    // even with an old pending value (blur commits it, so this only means a late render)
    expect(shouldSyncCellDom({ ...base, focused: false, hasPending: true, lastCommitted: 'b' })).toBe(true);
  });

  it('leaves the textarea alone while the operator is mid-typing', () => {
    expect(shouldSyncCellDom({ ...base, hasPending: true })).toBe(false);
  });

  it('pushes machine text into a focused cell that has nothing pending', () => {
    expect(shouldSyncCellDom({ ...base, storeValue: 'A new translation', lastCommitted: 'something typed earlier' })).toBe(true);
    expect(shouldSyncCellDom({ ...base, storeValue: 'A new translation', lastCommitted: null })).toBe(true);
  });

  it('does not write the echo of its own commit over text that arrived after the commit was read', () => {
    // 28 Oct: "…the ;h" -> expander deletes ";h" -> the debounce commits "…the " -> the expander's text lands
    // in the textarea without an input event -> the store echoes "…the " back.
    const typedThenExpanded = {
      ...base,
      domValue: 'The congregation is also a place for the Holy Spirit',
      storeValue: 'The congregation is also a place for the ',
      lastCommitted: 'The congregation is also a place for the ',
    };
    expect(shouldSyncCellDom(typedThenExpanded)).toBe(false);
    // …but once the store has moved on to different text, that is not our echo any more.
    expect(shouldSyncCellDom({ ...typedThenExpanded, lastCommitted: null })).toBe(true);
  });
});
