import { describe, it, expect } from 'vitest';
import {
  createHubState, toListenerLine, applyPublish, applyClear, applySync, snapshot,
} from '../../server/lib/listener-hub.js';

describe('toListenerLine — trust-boundary narrowing', () => {
  it('accepts a well-formed line', () => {
    expect(toListenerLine({ id: 'seg_1', index: 0, text: 'Hello', edited: false }))
      .toEqual({ id: 'seg_1', index: 0, text: 'Hello', edited: false });
  });

  it('drops any extra fields instead of passing them through — this is what keeps Dutch off the wire even if a caller accidentally sent it', () => {
    const raw = { id: 'seg_1', index: 0, text: 'Hello', edited: false, sourceText: 'Hallo (Dutch, must never reach a listener)' };
    const line = toListenerLine(raw);
    expect(line).toEqual({ id: 'seg_1', index: 0, text: 'Hello', edited: false });
    expect(line).not.toHaveProperty('sourceText');
  });

  it.each([
    ['missing id', { index: 0, text: 'Hello', edited: false }],
    ['non-string id', { id: 5, index: 0, text: 'Hello', edited: false }],
    ['empty id', { id: '', index: 0, text: 'Hello', edited: false }],
    ['non-number index', { id: 'seg_1', index: '0', text: 'Hello', edited: false }],
    ['NaN index', { id: 'seg_1', index: NaN, text: 'Hello', edited: false }],
    ['non-string text', { id: 'seg_1', index: 0, text: 42, edited: false }],
    ['non-boolean edited', { id: 'seg_1', index: 0, text: 'Hello', edited: 'no' }],
    ['null', null],
    ['array', ['not', 'an', 'object']],
  ])('rejects %s', (_label, raw) => {
    expect(toListenerLine(raw)).toBeNull();
  });
});

describe('applyPublish', () => {
  it('merges valid lines into state and returns only what was accepted, in input order', () => {
    const state = createHubState();
    const accepted = applyPublish(state, [
      { id: 'a', index: 0, text: 'First', edited: false },
      { id: 'not-a-line' }, // dropped
      { id: 'b', index: 1, text: 'Second', edited: false },
    ]);
    expect(accepted).toEqual([
      { id: 'a', index: 0, text: 'First', edited: false },
      { id: 'b', index: 1, text: 'Second', edited: false },
    ]);
    expect(state.lines.size).toBe(2);
  });

  it('overwrites an existing line by id (an edit republish)', () => {
    const state = createHubState();
    applyPublish(state, [{ id: 'a', index: 0, text: 'First', edited: false }]);
    applyPublish(state, [{ id: 'a', index: 0, text: 'First, corrected', edited: true }]);
    expect(state.lines.get('a')).toEqual({ id: 'a', index: 0, text: 'First, corrected', edited: true });
    expect(state.lines.size).toBe(1);
  });
});

describe('applyClear', () => {
  it('wipes the backlog', () => {
    const state = createHubState();
    applyPublish(state, [{ id: 'a', index: 0, text: 'First', edited: false }]);
    applyClear(state);
    expect(state.lines.size).toBe(0);
  });
});

describe('snapshot', () => {
  it('orders lines by index regardless of insertion/publish order', () => {
    const state = createHubState();
    applyPublish(state, [
      { id: 'c', index: 2, text: 'Third', edited: false },
      { id: 'a', index: 0, text: 'First', edited: false },
      { id: 'b', index: 1, text: 'Second', edited: false },
    ]);
    expect(snapshot(state).map(l => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('contains only id/index/text/edited — no other fields can leak in even via a malformed publish', () => {
    const state = createHubState();
    applyPublish(state, [{ id: 'a', index: 0, text: 'First', edited: false, sourceText: 'Eerste' }]);
    expect(Object.keys(snapshot(state)[0]).sort()).toEqual(['edited', 'id', 'index', 'text']);
  });
});

describe('applySync', () => {
  it('replaces the whole backlog — a reloaded operator page must not leave the previous page\'s lines behind', () => {
    const state = createHubState();
    applyPublish(state, [
      { id: 'seg_old_0', index: 0, text: 'Old line one', edited: false },
      { id: 'seg_old_1', index: 1, text: 'Old line two', edited: false },
    ]);
    const accepted = applySync(state, [{ id: 'seg_new_0', index: 0, text: 'New line', edited: false }]);
    expect(accepted).toHaveLength(1);
    expect(snapshot(state).map(l => l.text)).toEqual(['New line']);
  });

  it('an empty sync empties the hub (the operator has nothing)', () => {
    const state = createHubState();
    applyPublish(state, [{ id: 'seg_old_0', index: 0, text: 'Old', edited: false }]);
    applySync(state, []);
    expect(snapshot(state)).toEqual([]);
  });

  it('still drops malformed lines and extra fields', () => {
    const state = createHubState();
    applySync(state, [
      { id: 'a', index: 0, text: 'ok', edited: false, sourceText: 'Nederlands' },
      { id: '', index: 1, text: 'bad', edited: false },
    ]);
    expect(snapshot(state)).toEqual([{ id: 'a', index: 0, text: 'ok', edited: false }]);
  });
});
