import { describe, it, expect } from 'vitest';
import {
  initState, segmentReducer, selectDirtyIds, selectTranslatable, selectOrdered, selectContext,
  type SegmentStoreState,
} from '../../client/src/lib/sermon/segment-store.js';
import { hashText } from '../../client/src/lib/sermon/segment-model.js';

// Builds a store with `count` TRANSLATED segments ("Zin 0", "Zin 1", ...),
// each already translated so translatedHash matches its current sourceText.
function seedTranslated(count: number, now = 1000): SegmentStoreState {
  let state = initState('t');
  for (let i = 0; i < count; i++) {
    state = segmentReducer(state, {
      type: 'APPEND_SEGMENT', sourceText: `Zin ${i}.`, startTime: i, endTime: i + 1, now,
    });
  }
  for (const id of state.ids) {
    const seg = state.byId[id];
    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: [id] });
    state = segmentReducer(state, {
      type: 'APPLY_TRANSLATION', id, translation: `EN ${seg.sourceText}`, requestHash: hashText(seg.sourceText),
    });
  }
  return state;
}

describe('segmentReducer — reference stability (AC1/AC2)', () => {
  it('AC1: editing one segment and applying its translation leaves every other segment object untouched', () => {
    const before = seedTranslated(20);
    const id12 = before.ids[12];

    let after = segmentReducer(before, { type: 'EDIT_SOURCE', id: id12, sourceText: 'Gewijzigde zin twaalf.', now: 2000 });
    expect(selectDirtyIds(after)).toEqual([id12]);

    after = segmentReducer(after, { type: 'MARK_TRANSLATING', ids: [id12] });
    after = segmentReducer(after, {
      type: 'APPLY_TRANSLATION', id: id12, translation: 'Changed sentence twelve.',
      requestHash: hashText('Gewijzigde zin twaalf.'),
    });

    expect(after.byId[id12].translatedText).toBe('Changed sentence twelve.');
    expect(selectDirtyIds(after)).toEqual([]);

    for (const id of before.ids) {
      if (id === id12) continue;
      expect(Object.is(before.byId[id], after.byId[id])).toBe(true);
    }
  });

  it('AC2: editing two segments and refreshing re-translates exactly those two', () => {
    const before = seedTranslated(40);
    const id4 = before.ids[4];
    const id30 = before.ids[30];

    let after = segmentReducer(before, { type: 'EDIT_SOURCE', id: id4, sourceText: 'Nieuwe zin vier.', now: 2000 });
    after = segmentReducer(after, { type: 'EDIT_SOURCE', id: id30, sourceText: 'Nieuwe zin dertig.', now: 2000 });

    const dirty = selectDirtyIds(after);
    expect(dirty).toEqual([id4, id30]); // index order

    after = segmentReducer(after, { type: 'MARK_TRANSLATING', ids: dirty });
    after = segmentReducer(after, {
      type: 'APPLY_TRANSLATION', id: id4, translation: 'New sentence four.', requestHash: hashText('Nieuwe zin vier.'),
    });
    after = segmentReducer(after, {
      type: 'APPLY_TRANSLATION', id: id30, translation: 'New sentence thirty.', requestHash: hashText('Nieuwe zin dertig.'),
    });

    expect(selectDirtyIds(after)).toEqual([]);
    for (const id of before.ids) {
      if (id === id4 || id === id30) continue;
      expect(Object.is(before.byId[id], after.byId[id])).toBe(true);
    }
  });
});

describe('segmentReducer — manual override (AC4)', () => {
  it('a manually corrected translation is excluded from dirty even after a further source edit, and survives a stale APPLY_TRANSLATION', () => {
    let state = seedTranslated(10);
    const id7 = state.ids[7];

    state = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id: id7, translatedText: 'Hand-fixed translation.', now: 2000 });
    expect(state.byId[id7].manualOverride).toBe(true);
    expect(selectDirtyIds(state)).toEqual([]);

    // Human tweaks the Dutch source afterwards — still must not become dirty,
    // and must not requeue for auto-translation.
    state = segmentReducer(state, { type: 'EDIT_SOURCE', id: id7, sourceText: 'Bewerkte bronzin zeven.', now: 2500 });
    expect(selectDirtyIds(state)).toEqual([]);
    expect(selectTranslatable(state, { stabilityMs: 0 }, 999999)).toEqual([]);

    // A translation response that started before the override lands late —
    // must be rejected, not overwrite the hand-written text.
    const stale = segmentReducer(state, {
      type: 'APPLY_TRANSLATION', id: id7, translation: 'Stale auto-translation.',
      requestHash: hashText('Zin 7.'),
    });
    expect(stale.byId[id7].translatedText).toBe('Hand-fixed translation.');
  });
});

describe('segmentReducer — in-flight staleness guard', () => {
  it('discards a translation result whose requestHash no longer matches the current source (human edited mid-flight)', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Originele zin.', startTime: 0, endTime: 1, now: 0 });
    const id = state.ids[0];
    const requestHash = hashText('Originele zin.');

    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: [id] });
    // Human edits again before the response comes back.
    state = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'Andere zin inmiddels.', now: 10 });

    const after = segmentReducer(state, { type: 'APPLY_TRANSLATION', id, translation: 'Original sentence.', requestHash });
    expect(after.byId[id].translatedText).toBe(''); // stale result discarded
    expect(selectDirtyIds(after)).toEqual([id]); // still dirty — will be picked up again
  });
});

describe('segmentReducer — live arrival never clobbers an edited row (AC5)', () => {
  it('APPEND_SEGMENT while an earlier segment is EDITED leaves its reference untouched', () => {
    let state = seedTranslated(5);
    const idEdited = state.ids[2];
    const editedAfter = segmentReducer(state, { type: 'EDIT_SOURCE', id: idEdited, sourceText: 'Bewerkt.', now: 500 });

    const appended = segmentReducer(editedAfter, {
      type: 'APPEND_SEGMENT', sourceText: 'Nieuw live segment.', startTime: 10, endTime: 11, now: 600,
    });

    expect(Object.is(editedAfter.byId[idEdited], appended.byId[idEdited])).toBe(true);
    expect(appended.byId[idEdited].status).toBe('EDITED');
    expect(appended.ids.length).toBe(6);
  });

  it('UPDATE_PROVISIONAL and COMPLETE_PROVISIONAL are no-ops against an EDITED or manualOverride segment', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Half een zin', startTime: 0, endTime: 1, status: 'PROVISIONAL', now: 0 });
    const id = state.ids[0];

    const edited = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'Mens greep in.', now: 100 });
    const untouched1 = segmentReducer(edited, { type: 'UPDATE_PROVISIONAL', id, sourceText: 'Half een zin nu langer', endTime: 2, now: 200 });
    expect(Object.is(edited.byId[id], untouched1.byId[id])).toBe(true);

    const untouched2 = segmentReducer(edited, { type: 'COMPLETE_PROVISIONAL', id, sourceText: 'Half een zin nu langer.', endTime: 2, now: 200 });
    expect(Object.is(edited.byId[id], untouched2.byId[id])).toBe(true);
  });
});

describe('selectTranslatable — stability debounce (AC7)', () => {
  it('excludes a dirty segment until it has been unchanged for stabilityMs', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Een zin.', startTime: 0, endTime: 1, now: 1000 });
    const id = state.ids[0];

    expect(selectTranslatable(state, { stabilityMs: 1200 }, 1000)).toEqual([]);
    expect(selectTranslatable(state, { stabilityMs: 1200 }, 2199)).toEqual([]);
    expect(selectTranslatable(state, { stabilityMs: 1200 }, 2200)).toEqual([id]);
  });

  it('a growing PROVISIONAL segment never becomes translatable while it keeps changing', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Een lange', startTime: 0, endTime: 1, status: 'PROVISIONAL', now: 0 });
    const id = state.ids[0];

    for (let t = 0; t < 5000; t += 500) {
      state = segmentReducer(state, { type: 'UPDATE_PROVISIONAL', id, sourceText: `Een lange zin tot t=${t}`, endTime: t, now: t });
      expect(selectTranslatable(state, { stabilityMs: 1200 }, t + 100)).toEqual([]);
    }
  });
});

describe('selectContext', () => {
  it('returns the configured number of neighbouring sentences in order', () => {
    const state = seedTranslated(10);
    const ctx = selectContext(state, state.ids[5], 2, 1);
    expect(ctx.before).toEqual(['Zin 3.', 'Zin 4.']);
    expect(ctx.after).toEqual(['Zin 6.']);
  });

  it('clamps at the start and end of the sermon', () => {
    const state = seedTranslated(3);
    expect(selectContext(state, state.ids[0], 2, 1).before).toEqual([]);
    expect(selectContext(state, state.ids[2], 2, 1).after).toEqual([]);
  });
});

describe('selectOrdered', () => {
  it('returns segments in append order', () => {
    const state = seedTranslated(3);
    expect(selectOrdered(state).map(s => s.sourceText)).toEqual(['Zin 0.', 'Zin 1.', 'Zin 2.']);
  });
});
