import { describe, it, expect, vi } from 'vitest';
import { createEditLog, editLogEntry } from '../../client/src/lib/sermon/edit-log.js';
import { initState, segmentReducer } from '../../client/src/lib/sermon/segment-store.js';

const withRow = () => {
  let s = initState('t');
  s = segmentReducer(s, { type: 'APPEND_SEGMENT', id: 'a', sourceText: 'Kik is geboren.', startTime: 0, endTime: 1, now: 0 });
  return s;
};

describe('editLogEntry', () => {
  it('records a source edit with what it replaced', () => {
    expect(editLogEntry({ type: 'EDIT_SOURCE', id: 'a', sourceText: 'Kind is geboren.', now: 5 }, withRow(), 99))
      .toEqual({ t: 99, id: 'a', type: 'EDIT_SOURCE', field: 'source', prev: 'Kik is geboren.', next: 'Kind is geboren.' });
  });

  it('records a glossary row fix (REPLACE_SOURCE) like any other source change', () => {
    const e = editLogEntry({ type: 'REPLACE_SOURCE', id: 'a', sourceText: 'Kind is geboren.', now: 5 }, withRow(), 1);
    expect(e).toMatchObject({ type: 'REPLACE_SOURCE', field: 'source', next: 'Kind is geboren.' });
  });

  it('records a hand-typed translation and its removal', () => {
    let s = withRow();
    expect(editLogEntry({ type: 'SET_TARGET_MANUAL', id: 'a', translatedText: 'The Child.', now: 1 }, s, 2))
      .toEqual({ t: 2, id: 'a', type: 'SET_TARGET_MANUAL', field: 'target', prev: '', next: 'The Child.' });
    s = segmentReducer(s, { type: 'SET_TARGET_MANUAL', id: 'a', translatedText: 'The Child.', now: 1 });
    expect(editLogEntry({ type: 'CLEAR_TARGET_MANUAL', id: 'a' }, s, 3))
      .toEqual({ t: 3, id: 'a', type: 'CLEAR_TARGET_MANUAL', field: 'target', prev: 'The Child.', next: '' });
  });

  it('ignores no-op edits, unknown rows and machine-driven actions', () => {
    const s = withRow();
    expect(editLogEntry({ type: 'EDIT_SOURCE', id: 'a', sourceText: 'Kik is geboren.', now: 1 }, s, 1)).toBeNull();
    expect(editLogEntry({ type: 'EDIT_SOURCE', id: 'nope', sourceText: 'x', now: 1 }, s, 1)).toBeNull();
    expect(editLogEntry({ type: 'CLEAR_TARGET_MANUAL', id: 'a' }, s, 1)).toBeNull(); // not a manual override
    expect(editLogEntry({ type: 'APPLY_TRANSLATION', id: 'a', translation: 'x', requestHash: 'h' }, s, 1)).toBeNull();
  });
});

describe('createEditLog', () => {
  it('sends buffered entries as JSON lines on flush, then starts empty', () => {
    const send = vi.fn();
    const log = createEditLog(send);
    log.record({ t: 1, id: 'a', type: 'EDIT_SOURCE', field: 'source', prev: 'x', next: 'y' });
    log.record({ t: 2, id: 'b', type: 'EDIT_SOURCE', field: 'source', prev: 'p', next: 'q' });
    expect(log.size).toBe(2);
    log.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const lines = (send.mock.calls[0][0] as string).split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.id)).toEqual(['a', 'b']);
    expect(log.size).toBe(0);
    log.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a failing send never throws', () => {
    const log = createEditLog(() => { throw new Error('offline'); });
    log.record({ t: 1, id: 'a', type: 'EDIT_SOURCE', field: 'source', prev: 'x', next: 'y' });
    expect(() => log.flush()).not.toThrow();
  });
});
