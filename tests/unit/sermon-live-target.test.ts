import { describe, it, expect } from 'vitest';
import { initState, segmentReducer, selectPublishableLines, selectDirtyIds, type SegmentStoreState } from '../../client/src/lib/sermon/segment-store.js';
import { hashText } from '../../client/src/lib/sermon/segment-model.js';
import { computeBatch, type PublishedEntry } from '../../client/src/hooks/useListenerBroadcast.js';

function withRow(sourceText = 'Genade zij u.'): { state: SegmentStoreState; id: string } {
  let state = initState('t');
  state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText, startTime: 0, endTime: 1, now: 0 });
  return { state, id: state.ids[0] };
}

describe('CLEAR_TARGET_MANUAL', () => {
  it('hands a hand-typed row back to the translator (dirty again, no manual override)', () => {
    let { state, id } = withRow();
    state = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id, translatedText: 'Grace be with you.', now: 1 });
    expect(state.byId[id].manualOverride).toBe(true);
    state = segmentReducer(state, { type: 'CLEAR_TARGET_MANUAL', id });
    const seg = state.byId[id];
    expect(seg).toMatchObject({ manualOverride: false, translatedText: '', translatedHash: null, status: 'PENDING' });
    expect(selectDirtyIds(state)).toEqual([id]);
    expect(selectPublishableLines(state)).toEqual([]);
  });

  it('is a no-op on a row that is not a manual override, and for an unknown id', () => {
    let { state, id } = withRow();
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id, translation: 'Grace.', requestHash: hashText('Genade zij u.') });
    expect(segmentReducer(state, { type: 'CLEAR_TARGET_MANUAL', id })).toBe(state);
    expect(segmentReducer(state, { type: 'CLEAR_TARGET_MANUAL', id: 'nope' })).toBe(state);
  });

  it('lets a later machine translation land again', () => {
    let { state, id } = withRow();
    state = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id, translatedText: 'mine', now: 1 });
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id, translation: 'ignored', requestHash: hashText('Genade zij u.') });
    expect(state.byId[id].translatedText).toBe('mine');
    state = segmentReducer(state, { type: 'CLEAR_TARGET_MANUAL', id });
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id, translation: 'Grace.', requestHash: hashText('Genade zij u.') });
    expect(state.byId[id]).toMatchObject({ translatedText: 'Grace.', status: 'TRANSLATED', manualOverride: false });
  });
});

describe('REPLACE_SOURCE', () => {
  it('edits the source, re-dirties the row and bumps sourceRevision so the textarea shows the new text', () => {
    let { state, id } = withRow('ik lees je logie');
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id, translation: 'I read you logy', requestHash: hashText('ik lees je logie') });
    const before = state.byId[id];
    state = segmentReducer(state, { type: 'REPLACE_SOURCE', id, sourceText: 'ecclesiologie', now: 5 });
    const seg = state.byId[id];
    expect(seg).toMatchObject({ sourceText: 'ecclesiologie', status: 'EDITED', lastSourceChangeAt: 5 });
    expect(seg.sourceRevision).toBe(before.sourceRevision + 1);
    expect(selectDirtyIds(state)).toEqual([id]);
  });

  it('EDIT_SOURCE still does not bump sourceRevision (the textarea already holds that text)', () => {
    let { state, id } = withRow();
    const rev = state.byId[id].sourceRevision;
    state = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'x', now: 1 });
    expect(state.byId[id].sourceRevision).toBe(rev);
  });
});

describe('computeBatch — which listener lines read as "edited"', () => {
  const typeManual = (state: SegmentStoreState, id: string, text: string) =>
    segmentReducer(state, { type: 'SET_TARGET_MANUAL', id, translatedText: text, now: 1 });

  it('a translation typed from scratch stays unedited while it is being written', () => {
    const published = new Map<string, PublishedEntry>();
    let { state, id } = withRow();
    state = typeManual(state, id, 'Gra');
    expect(computeBatch(state, published, false)).toEqual([{ id, index: 0, text: 'Gra', edited: false }]);
    state = typeManual(state, id, 'Grace be');
    expect(computeBatch(state, published, false)).toEqual([{ id, index: 0, text: 'Grace be', edited: false }]);
    state = typeManual(state, id, 'Grace be with you.');
    expect(computeBatch(state, published, false)).toEqual([{ id, index: 0, text: 'Grace be with you.', edited: false }]);
  });

  it('correcting a machine translation by hand is a revision (edited, and it stays edited)', () => {
    const published = new Map<string, PublishedEntry>();
    let { state, id } = withRow();
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id, translation: 'Mercy to you.', requestHash: hashText('Genade zij u.') });
    expect(computeBatch(state, published, false)[0].edited).toBe(false);
    state = typeManual(state, id, 'Grace be to you.');
    expect(computeBatch(state, published, false)).toEqual([{ id, index: 0, text: 'Grace be to you.', edited: true }]);
    state = typeManual(state, id, 'Grace be to you all.');
    expect(computeBatch(state, published, false)[0].edited).toBe(true);
  });

  it('adding markdown to a machine translation is sent but not italic; changing words still is', () => {
    const published = new Map<string, PublishedEntry>();
    let { state, id } = withRow();
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id, translation: 'Psalm 23:1. The Lord is my Shepherd.', requestHash: hashText('Genade zij u.') });
    computeBatch(state, published, false);
    state = typeManual(state, id, 'Psalm 23:1.\n> The Lord is my Shepherd.');
    expect(computeBatch(state, published, false)).toEqual([{ id, index: 0, text: 'Psalm 23:1.\n> The Lord is my Shepherd.', edited: false }]);
    state = typeManual(state, id, 'Psalm 23:1.\n> The LORD is my shepherd.');
    expect(computeBatch(state, published, false)[0].edited).toBe(true);
  });

  it('sends nothing when nothing changed, and everything on a forced resync', () => {
    const published = new Map<string, PublishedEntry>();
    let { state, id } = withRow();
    state = typeManual(state, id, 'Hi');
    computeBatch(state, published, false);
    expect(computeBatch(state, published, false)).toEqual([]);
    expect(computeBatch(state, published, true)).toEqual([{ id, index: 0, text: 'Hi', edited: false }]);
  });
});
