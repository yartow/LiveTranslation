import { describe, it, expect } from 'vitest';
import {
  initState, segmentReducer, selectDirtyIds, selectTranslatable, selectOrdered, selectContext, canWriteLive, READING_GRACE_SEGMENTS,
  selectPublishableLines, selectNextId, restoredState, mergeRestored, selectCorrectionExamples,
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

describe('segmentReducer — glossary warnings lifecycle', () => {
  it('APPLY_TRANSLATION carries warnings onto the segment, and omits the key when there are none', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Zin.', startTime: 0, endTime: 1, now: 0 });
    const id = state.ids[0];
    const requestHash = hashText('Zin.');

    const withWarnings = segmentReducer(state, {
      type: 'APPLY_TRANSLATION', id, translation: 'Sentence.', requestHash,
      warnings: [{ term: 'Heiland', expected: 'Savior' }],
    });
    expect(withWarnings.byId[id].glossaryWarnings).toEqual([{ term: 'Heiland', expected: 'Savior' }]);

    const withoutWarnings = segmentReducer(state, { type: 'APPLY_TRANSLATION', id, translation: 'Sentence.', requestHash });
    expect(withoutWarnings.byId[id].glossaryWarnings).toBeUndefined();
  });

  it('EDIT_SOURCE clears a stale warning from the previous translation', () => {
    let state = seedTranslated(1);
    const id = state.ids[0];
    state = segmentReducer(state, {
      type: 'APPLY_TRANSLATION', id, translation: 'EN Zin 0.', requestHash: hashText('Zin 0.'),
      warnings: [{ term: 'Heiland', expected: 'Savior' }],
    });
    expect(state.byId[id].glossaryWarnings).toHaveLength(1);

    const edited = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'Nieuwe zin.', now: 1000 });
    expect(edited.byId[id].glossaryWarnings).toBeUndefined();
  });

  it('SET_TARGET_MANUAL clears a stale warning — the human override is authoritative', () => {
    let state = seedTranslated(1);
    const id = state.ids[0];
    state = segmentReducer(state, {
      type: 'APPLY_TRANSLATION', id, translation: 'EN Zin 0.', requestHash: hashText('Zin 0.'),
      warnings: [{ term: 'Heiland', expected: 'Savior' }],
    });

    const overridden = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id, translatedText: 'Hand-fixed.', now: 1000 });
    expect(overridden.byId[id].glossaryWarnings).toBeUndefined();
  });

  it('SET_ERROR clears a stale warning', () => {
    let state = seedTranslated(1);
    const id = state.ids[0];
    state = segmentReducer(state, {
      type: 'APPLY_TRANSLATION', id, translation: 'EN Zin 0.', requestHash: hashText('Zin 0.'),
      warnings: [{ term: 'Heiland', expected: 'Savior' }],
    });
    // Re-dirty it and let a subsequent attempt fail, matching requestHash so SET_ERROR isn't discarded as stale.
    const edited = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'Zin 0.', now: 1000 });
    const errored = segmentReducer(edited, { type: 'SET_ERROR', id, error: 'boom', requestHash: hashText('Zin 0.') });
    expect(errored.byId[id].glossaryWarnings).toBeUndefined();
  });
});

describe('selectOrdered', () => {
  it('returns segments in append order', () => {
    const state = seedTranslated(3);
    expect(selectOrdered(state).map(s => s.sourceText)).toEqual(['Zin 0.', 'Zin 1.', 'Zin 2.']);
  });
});

// Regression: a stop/restart within one page load used to reset
// useSermonIngest's live-id counter to 0 without clearing the store, so the
// second session's `live-0` would silently overwrite the first session's
// already-translated row via APPEND_SEGMENT. useSermonIngest.ts now folds a
// per-session token into every live id (belt), and this guard refuses the
// collision outright (suspenders) — see segment-store.ts's APPEND_SEGMENT.
describe('segmentReducer — duplicate id is refused, not overwritten (regression: stop/restart data loss)', () => {
  it('APPEND_SEGMENT with an id that already exists is a no-op, preserving the original segment', () => {
    let state = initState('t');
    state = segmentReducer(state, {
      type: 'APPEND_SEGMENT', id: 'live-0-0', sourceText: 'Eerste sessie.', startTime: 0, endTime: 1, now: 0,
    });
    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: ['live-0-0'] });
    state = segmentReducer(state, {
      type: 'APPLY_TRANSLATION', id: 'live-0-0', translation: 'First session.', requestHash: hashText('Eerste sessie.'),
    });

    const before = state;
    const after = segmentReducer(state, {
      type: 'APPEND_SEGMENT', id: 'live-0-0', sourceText: 'Tweede sessie zou dit overschrijven.', startTime: 0, endTime: 1, now: 1000,
    });

    expect(after).toBe(before); // reducer returned the untouched state — same reference
    expect(after.byId['live-0-0'].sourceText).toBe('Eerste sessie.');
    expect(after.byId['live-0-0'].translatedText).toBe('First session.');
    expect(after.ids).toEqual(['live-0-0']); // no duplicate id pushed
  });
});

// Regression: MARK_TRANSLATING can fire (overwriting status to TRANSLATING)
// *after* a source edit that was already baked into a stale requestHash — a
// runBatch built from a snapshot taken just before the edit. When the reply
// then arrives, the hash mismatch used to just discard it with `return
// state`, leaving the row parked at TRANSLATING forever: selectTranslatable
// excludes that status, and the UI shows no per-row action for it.
describe('segmentReducer — a stale reply never leaves a row stuck at TRANSLATING', () => {
  it('APPLY_TRANSLATION with a stale requestHash recovers a TRANSLATING row to EDITED', () => {
    let state = seedTranslated(1);
    const id = state.ids[0];
    const staleHash = hashText(state.byId[id].sourceText); // hash of the pre-edit text

    state = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'Nieuwe tekst.', now: 100 });
    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: [id] });
    expect(state.byId[id].status).toBe('TRANSLATING');

    const after = segmentReducer(state, {
      type: 'APPLY_TRANSLATION', id, translation: 'Stale reply.', requestHash: staleHash,
    });
    expect(after.byId[id].status).toBe('EDITED'); // recovered, not stuck
    expect(after.byId[id].translatedText).toBe('EN Zin 0.'); // the stale reply itself is still discarded
    expect(selectDirtyIds(after)).toEqual([id]); // picked up again by the next refresh/auto-translate
  });

  it('SET_ERROR with a stale requestHash also recovers a TRANSLATING row to EDITED', () => {
    let state = seedTranslated(1);
    const id = state.ids[0];
    const staleHash = hashText(state.byId[id].sourceText);

    state = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'Nieuwe tekst.', now: 100 });
    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: [id] });

    const after = segmentReducer(state, { type: 'SET_ERROR', id, error: 'boom', requestHash: staleHash });
    expect(after.byId[id].status).toBe('EDITED');
  });

  it('a non-stale (matching-hash) reply is unaffected by the recovery path', () => {
    // Sanity check the fix doesn't change behavior for the common, non-racy case.
    const before = seedTranslated(20);
    const id12 = before.ids[12];
    let after = segmentReducer(before, { type: 'EDIT_SOURCE', id: id12, sourceText: 'Gewijzigde zin twaalf.', now: 2000 });
    after = segmentReducer(after, { type: 'MARK_TRANSLATING', ids: [id12] });
    after = segmentReducer(after, {
      type: 'APPLY_TRANSLATION', id: id12, translation: 'Changed sentence twelve.',
      requestHash: hashText('Gewijzigde zin twaalf.'),
    });
    expect(after.byId[id12].status).toBe('TRANSLATED');
    expect(after.byId[id12].translatedText).toBe('Changed sentence twelve.');
  });
});

// canWriteLive is the single predicate shared by the reducer's UPDATE_
// PROVISIONAL/COMPLETE_PROVISIONAL guard and useSermonIngest.ts's decision to
// fall back to opening a new segment instead of losing live ASR text to what
// would otherwise be a silent no-op (the "swallowed completed sentence" bug).
describe('canWriteLive', () => {
  it('is false for a missing segment (token-miss)', () => {
    expect(canWriteLive(undefined)).toBe(false);
  });

  it('is false for an EDITED segment', () => {
    let state = initState('t');
    state = segmentReducer(state, {
      type: 'APPEND_SEGMENT', sourceText: 'Half een zin', startTime: 0, endTime: 1, status: 'PROVISIONAL', now: 0,
    });
    const id = state.ids[0];
    state = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'Mens greep in.', now: 100 });
    expect(canWriteLive(state.byId[id])).toBe(false);
  });

  it('is false for a manualOverride segment', () => {
    let state = seedTranslated(1);
    const id = state.ids[0];
    state = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id, translatedText: 'Hand-fixed.', now: 0 });
    expect(canWriteLive(state.byId[id])).toBe(false);
  });

  it('is true for an ordinary PROVISIONAL segment', () => {
    let state = initState('t');
    state = segmentReducer(state, {
      type: 'APPEND_SEGMENT', sourceText: 'Half een zin', startTime: 0, endTime: 1, status: 'PROVISIONAL', now: 0,
    });
    expect(canWriteLive(state.byId[state.ids[0]])).toBe(true);
  });

  it('is false once a row has moved past PROVISIONAL (PENDING, TRANSLATING, TRANSLATED)', () => {
    let state = initState('t');
    state = segmentReducer(state, {
      type: 'APPEND_SEGMENT', id: 'a', sourceText: 'Een zin.', startTime: 0, endTime: 1, status: 'PROVISIONAL', now: 0,
    });
    state = segmentReducer(state, { type: 'COMPLETE_PROVISIONAL', id: 'a', sourceText: 'Een zin.', endTime: 1, now: 1 });
    expect(canWriteLive(state.byId.a)).toBe(false); // PENDING
    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: ['a'] });
    expect(canWriteLive(state.byId.a)).toBe(false);
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id: 'a', translation: 'A sentence.', requestHash: hashText('Een zin.') });
    expect(state.byId.a.status).toBe('TRANSLATED');
    expect(canWriteLive(state.byId.a)).toBe(false);
  });

  it('an idle-translated row is not reopened by a late live update', () => {
    let state = initState('t');
    state = segmentReducer(state, {
      type: 'APPEND_SEGMENT', id: 'a', sourceText: 'Een halve zin', startTime: 0, endTime: 1, status: 'PROVISIONAL', now: 0,
    });
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id: 'a', translation: 'A half sentence', requestHash: hashText('Een halve zin') });
    const after = segmentReducer(state, { type: 'UPDATE_PROVISIONAL', id: 'a', sourceText: 'Een halve zin die doorgaat', endTime: 2, now: 40_000 });
    expect(after).toBe(state);
  });
});

// Bijbelcitaten (scripture) — AC11/AC12. See segment-store.ts's APPLY_
// SCRIPTURE/CLEAR_SCRIPTURE/SET_ACTIVE_READING/CLEAR_ACTIVE_READING.
describe('segmentReducer — scripture (Bijbelcitaten)', () => {
  it('APPLY_SCRIPTURE sets status SCRIPTURE, records the verse info, and makes the segment non-dirty (AC11)', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Johannes 3:16.', startTime: 0, endTime: 1, now: 0 });
    const id = state.ids[0];
    const requestHash = hashText('Johannes 3:16.');

    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: [id] });
    state = segmentReducer(state, {
      type: 'APPLY_SCRIPTURE', id, text: 'For God so loved the world...', reference: 'John 3:16', version: 'ESV', requestHash,
    });

    expect(state.byId[id].status).toBe('SCRIPTURE');
    expect(state.byId[id].translatedText).toBe('For God so loved the world...');
    expect(state.byId[id].scripture).toEqual({ reference: 'John 3:16', version: 'ESV', verses: 'For God so loved the world...' });
    expect(selectDirtyIds(state)).toEqual([]); // not auto-retranslated
  });

  it('editing the source of a SCRIPTURE segment re-dirties it and clears the stale scripture info (a corrected reference gets a fresh lookup)', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Johannes 3:16.', startTime: 0, endTime: 1, now: 0 });
    const id = state.ids[0];
    state = segmentReducer(state, {
      type: 'APPLY_SCRIPTURE', id, text: 'For God so loved...', reference: 'John 3:16', version: 'ESV', requestHash: hashText('Johannes 3:16.'),
    });

    const edited = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'Johannes 3:17.', now: 100 });
    expect(edited.byId[id].status).toBe('EDITED');
    expect(edited.byId[id].scripture).toBeUndefined();
    expect(selectDirtyIds(edited)).toEqual([id]);
  });

  it('CLEAR_SCRIPTURE re-dirties the row, clears scripture info, and sets scriptureOverride so it is translated normally next time', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Johannes 3:16.', startTime: 0, endTime: 1, now: 0 });
    const id = state.ids[0];
    state = segmentReducer(state, {
      type: 'APPLY_SCRIPTURE', id, text: 'For God so loved...', reference: 'John 3:16', version: 'ESV', requestHash: hashText('Johannes 3:16.'),
    });

    const cleared = segmentReducer(state, { type: 'CLEAR_SCRIPTURE', id, now: 200 });
    expect(cleared.byId[id].status).toBe('EDITED');
    expect(cleared.byId[id].scripture).toBeUndefined();
    expect(cleared.byId[id].scriptureOverride).toBe(true);
    expect(selectDirtyIds(cleared)).toEqual([id]);
  });

  it('a later edit resets scriptureOverride, re-enabling scripture detection', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Johannes 3:16.', startTime: 0, endTime: 1, now: 0 });
    const id = state.ids[0];
    state = segmentReducer(state, { type: 'CLEAR_SCRIPTURE', id, now: 0 });
    expect(state.byId[id].scriptureOverride).toBe(true);

    const edited = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'Johannes 3:17.', now: 100 });
    expect(edited.byId[id].scriptureOverride).toBe(false);
  });

  it('SET_ACTIVE_READING / CLEAR_ACTIVE_READING track the store-level reading state', () => {
    let state = initState('t');
    expect(state.activeReading).toBeNull();

    state = segmentReducer(state, { type: 'SET_ACTIVE_READING', bookNumber: 43, chapter: 3, verse: 16 });
    expect(state.activeReading).toEqual({ bookNumber: 43, chapter: 3, nextVerse: 16, matched: false, misses: 0 });

    // A fresh reference replaces (doesn't merge with) the previous one.
    state = segmentReducer(state, { type: 'SET_ACTIVE_READING', bookNumber: 45, chapter: 8, verse: 28 });
    expect(state.activeReading).toEqual({ bookNumber: 45, chapter: 8, nextVerse: 28, matched: false, misses: 0 });

    state = segmentReducer(state, { type: 'CLEAR_ACTIVE_READING' });
    expect(state.activeReading).toBeNull();
  });

  it('an announced reading survives READING_GRACE_SEGMENTS misses before it matches', () => {
    let state = segmentReducer(initState('t'), { type: 'SET_ACTIVE_READING', bookNumber: 58, chapter: 12, verse: 1 });
    for (let i = 1; i < READING_GRACE_SEGMENTS; i++) {
      state = segmentReducer(state, { type: 'NOTE_READING_MISS' });
      expect(state.activeReading).toMatchObject({ nextVerse: 1, matched: false, misses: i });
    }
    state = segmentReducer(state, { type: 'NOTE_READING_MISS' });
    expect(state.activeReading).toBeNull();
  });

  it('a matched reading ends on its first miss', () => {
    let state = segmentReducer(initState('t'), { type: 'SET_ACTIVE_READING', bookNumber: 58, chapter: 12, verse: 1 });
    state = segmentReducer(state, { type: 'NOTE_READING_MISS' });
    state = segmentReducer(state, { type: 'SET_ACTIVE_READING', bookNumber: 58, chapter: 12, verse: 1, matched: true });
    expect(state.activeReading).toMatchObject({ matched: true, misses: 0 });
    state = segmentReducer(state, { type: 'NOTE_READING_MISS' });
    expect(state.activeReading).toBeNull();
  });

  it('SET_ACTIVE_READING with matched: true (a verbatim advance) starts matched', () => {
    const state = segmentReducer(initState('t'), { type: 'SET_ACTIVE_READING', bookNumber: 58, chapter: 12, verse: 4, matched: true });
    expect(state.activeReading).toMatchObject({ nextVerse: 4, matched: true });
  });

  it('NOTE_READING_MISS with no reading is a no-op', () => {
    const state = initState('t');
    expect(segmentReducer(state, { type: 'NOTE_READING_MISS' })).toBe(state);
  });

  it('a stale APPLY_SCRIPTURE reply recovers a TRANSLATING row to EDITED, same as APPLY_TRANSLATION', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Johannes 3:16.', startTime: 0, endTime: 1, now: 0 });
    const id = state.ids[0];
    const staleHash = hashText(state.byId[id].sourceText);

    state = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'Johannes 3:17.', now: 100 });
    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: [id] });

    const after = segmentReducer(state, {
      type: 'APPLY_SCRIPTURE', id, text: 'Stale verse text.', reference: 'John 3:16', version: 'KJV', requestHash: staleHash,
    });
    expect(after.byId[id].status).toBe('EDITED'); // recovered, not stuck at TRANSLATING
    expect(after.byId[id].scripture).toBeUndefined(); // the stale reply was discarded
  });
});

// Listener mode (CLAUDE.md "Listener mode") — see useListenerBroadcast.ts,
// which diffs this selector's output against what it last sent over
// /ws/sermon-broadcast.
describe('selectPublishableLines', () => {
  it('includes only TRANSLATED segments with non-empty text, ordered by index', () => {
    const state = seedTranslated(3);
    expect(selectPublishableLines(state)).toEqual([
      { id: state.ids[0], index: 0, text: 'EN Zin 0.', manual: false },
      { id: state.ids[1], index: 1, text: 'EN Zin 1.', manual: false },
      { id: state.ids[2], index: 2, text: 'EN Zin 2.', manual: false },
    ]);
  });

  it('excludes PENDING, PROVISIONAL, TRANSLATING, EDITED, and ERROR', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Pending.', startTime: 0, endTime: 1, now: 0 }); // PENDING
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Provisional.', startTime: 1, endTime: 2, status: 'PROVISIONAL', now: 0 });
    const translatingId = (() => {
      state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'In flight.', startTime: 2, endTime: 3, now: 0 });
      const id = state.ids[state.ids.length - 1];
      state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: [id] });
      return id;
    })();
    const editedId = (() => {
      state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Was translated.', startTime: 3, endTime: 4, now: 0 });
      const id = state.ids[state.ids.length - 1];
      state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: [id] });
      state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id, translation: 'Was translated (EN).', requestHash: hashText('Was translated.') });
      state = segmentReducer(state, { type: 'EDIT_SOURCE', id, sourceText: 'Was translated, edited.', now: 10 });
      return id;
    })();
    const erroredId = (() => {
      state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Will fail.', startTime: 4, endTime: 5, now: 0 });
      const id = state.ids[state.ids.length - 1];
      state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: [id] });
      state = segmentReducer(state, { type: 'SET_ERROR', id, error: 'boom', requestHash: hashText('Will fail.') });
      return id;
    })();

    expect(selectPublishableLines(state)).toEqual([]);
    expect(state.byId[translatingId].status).toBe('TRANSLATING');
    expect(state.byId[editedId].status).toBe('EDITED');
    expect(state.byId[erroredId].status).toBe('ERROR');
  });

  it('includes SCRIPTURE segments and manualOverride segments', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Johannes 3:16.', startTime: 0, endTime: 1, now: 0 });
    const scriptureId = state.ids[0];
    state = segmentReducer(state, {
      type: 'APPLY_SCRIPTURE', id: scriptureId, text: 'For God so loved the world...', reference: 'John 3:16', version: 'ESV', requestHash: hashText('Johannes 3:16.'),
    });

    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Hand-written.', startTime: 1, endTime: 2, now: 0 });
    const manualId = state.ids[1];
    state = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id: manualId, translatedText: 'By hand.', now: 0 });

    const lines = selectPublishableLines(state);
    expect(lines).toEqual([
      { id: scriptureId, index: 0, text: 'For God so loved the world...', manual: false },
      { id: manualId, index: 1, text: 'By hand.', manual: true },
    ]);
  });

  it('excludes a TRANSLATED segment whose translatedText is empty', () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', sourceText: 'Zin.', startTime: 0, endTime: 1, now: 0 });
    const id = state.ids[0];
    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: [id] });
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id, translation: '', requestHash: hashText('Zin.') });
    expect(state.byId[id].status).toBe('TRANSLATED');
    expect(selectPublishableLines(state)).toEqual([]);
  });
});

describe('selectTranslatable — live (PROVISIONAL) rows', () => {
  const cfg = { stabilityMs: 1200 };

  function withProvisional(): SegmentStoreState {
    return segmentReducer(initState('t'), {
      type: 'APPEND_SEGMENT', id: 'a', sourceText: 'Een halve zin', startTime: 0, endTime: 5000, status: 'PROVISIONAL', now: 0,
    });
  }

  it('does not translate a row that is still growing, even once it is stable', () => {
    expect(selectTranslatable(withProvisional(), cfg, 10_000)).toEqual([]);
  });

  it('translates it once it is finalized (PENDING)', () => {
    const state = segmentReducer(withProvisional(), { type: 'COMPLETE_PROVISIONAL', id: 'a', sourceText: 'Een hele zin.', endTime: 5000, now: 10_000 });
    expect(selectTranslatable(state, cfg, 12_000)).toEqual(['a']);
  });

  it('treats a row that has not grown for 30 s as abandoned (recording stopped mid-block) and translates it', () => {
    expect(selectTranslatable(withProvisional(), cfg, 29_999)).toEqual([]);
    expect(selectTranslatable(withProvisional(), cfg, 30_000)).toEqual(['a']);
  });
});

// "Add row": an empty row typed into by hand (no microphone needed).
describe('rows added by hand (empty source)', () => {
  const withBlankRow = () => segmentReducer(initState('t'), {
    type: 'APPEND_SEGMENT', id: 'blank', sourceText: '', startTime: 0, endTime: 0, approximateTiming: true, now: 0,
  });

  it('is never offered to the translator, automatically or by Refresh all', () => {
    const state = withBlankRow();
    expect(selectTranslatable(state, { stabilityMs: 0 }, 999_999)).toEqual([]);
    expect(selectDirtyIds(state)).toEqual([]);
  });

  it('whitespace-only source counts as empty', () => {
    const state = segmentReducer(withBlankRow(), { type: 'EDIT_SOURCE', id: 'blank', sourceText: '  \n ', now: 5 });
    expect(selectTranslatable(state, { stabilityMs: 0 }, 999_999)).toEqual([]);
    expect(selectDirtyIds(state)).toEqual([]);
  });

  it('is translated as usual once Dutch is typed into it', () => {
    const state = segmentReducer(withBlankRow(), { type: 'EDIT_SOURCE', id: 'blank', sourceText: 'Goedemorgen.', now: 5 });
    expect(selectDirtyIds(state)).toEqual(['blank']);
    expect(selectTranslatable(state, { stabilityMs: 0 }, 10)).toEqual(['blank']);
  });

  it('reaches the listeners as soon as English is typed into it', () => {
    const state = segmentReducer(withBlankRow(), { type: 'SET_TARGET_MANUAL', id: 'blank', translatedText: 'Good morning.', now: 5 });
    expect(selectPublishableLines(state)).toEqual([{ id: 'blank', index: 0, text: 'Good morning.', manual: true }]);
    expect(selectDirtyIds(state)).toEqual([]);
  });

  it('a live write never lands in it (it is not PROVISIONAL)', () => {
    const state = segmentReducer(withBlankRow(), { type: 'UPDATE_PROVISIONAL', id: 'blank', sourceText: 'Live tekst', endTime: 3, now: 1 });
    expect(state.byId.blank.sourceText).toBe('');
  });
});

describe('selectNextId', () => {
  it('returns the following row, and null for the last row or an unknown id', () => {
    const state = seedTranslated(3);
    const [a, b, c] = state.ids;
    expect(selectNextId(state, a)).toBe(b);
    expect(selectNextId(state, b)).toBe(c);
    expect(selectNextId(state, c)).toBeNull();
    expect(selectNextId(state, 'nope')).toBeNull();
  });
});

describe('asrText / machineText (what the human changed)', () => {
  const seed = () => {
    let state = initState('t');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', id: 'a', sourceText: 'Kik is geboren', startTime: 0, endTime: 1, status: 'PROVISIONAL', now: 0 });
    return state;
  };

  it('asrText follows live ASR updates but never a human edit', () => {
    let state = seed();
    expect(state.byId.a.asrText).toBe('Kik is geboren');
    state = segmentReducer(state, { type: 'UPDATE_PROVISIONAL', id: 'a', sourceText: 'Kik is geboren in Betlehem', endTime: 2, now: 1 });
    expect(state.byId.a.asrText).toBe('Kik is geboren in Betlehem');
    state = segmentReducer(state, { type: 'COMPLETE_PROVISIONAL', id: 'a', sourceText: 'Kik is geboren in Betlehem.', endTime: 3, now: 2 });
    expect(state.byId.a.asrText).toBe('Kik is geboren in Betlehem.');
    state = segmentReducer(state, { type: 'EDIT_SOURCE', id: 'a', sourceText: 'Kind is geboren in Betlehem.', now: 3 });
    expect(state.byId.a.sourceText).toBe('Kind is geboren in Betlehem.');
    expect(state.byId.a.asrText).toBe('Kik is geboren in Betlehem.');
    state = segmentReducer(state, { type: 'REPLACE_SOURCE', id: 'a', sourceText: 'Het Kind is geboren.', now: 4 });
    expect(state.byId.a.asrText).toBe('Kik is geboren in Betlehem.');
  });

  it('machineText is the last machine translation and survives a hand edit', () => {
    let state = segmentReducer(seed(), { type: 'COMPLETE_PROVISIONAL', id: 'a', sourceText: 'Het Kind is geboren.', endTime: 3, now: 2 });
    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: ['a'] });
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id: 'a', translation: 'The Child is born.', requestHash: hashText('Het Kind is geboren.') });
    expect(state.byId.a.machineText).toBe('The Child is born.');
    state = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id: 'a', translatedText: 'The Child was born.', now: 5 });
    expect(state.byId.a.translatedText).toBe('The Child was born.');
    expect(state.byId.a.machineText).toBe('The Child is born.');
  });

  it('handing the row back to the translator forgets the old machine text', () => {
    let state = segmentReducer(seed(), { type: 'COMPLETE_PROVISIONAL', id: 'a', sourceText: 'Amen.', endTime: 3, now: 2 });
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id: 'a', translation: 'Amen.', requestHash: hashText('Amen.') });
    state = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id: 'a', translatedText: 'So be it.', now: 5 });
    state = segmentReducer(state, { type: 'CLEAR_TARGET_MANUAL', id: 'a' });
    expect(state.byId.a.machineText).toBeUndefined();
  });

  it('a verbatim scripture reading is also remembered as machine text', () => {
    let state = segmentReducer(seed(), { type: 'COMPLETE_PROVISIONAL', id: 'a', sourceText: 'Want alzo lief heeft God de wereld gehad.', endTime: 3, now: 2 });
    state = segmentReducer(state, { type: 'APPLY_SCRIPTURE', id: 'a', text: 'For God so loved the world', reference: 'John 3:16', version: 'ESV', requestHash: hashText('Want alzo lief heeft God de wereld gehad.') });
    expect(state.byId.a.machineText).toBe('For God so loved the world');
  });
});

describe('restoredState (autosave restore)', () => {
  const saved = (): SegmentStoreState => {
    let state = initState('old');
    const add = (id: string, status: 'PROVISIONAL' | 'PENDING', text: string) =>
      segmentReducer(state, { type: 'APPEND_SEGMENT', id, sourceText: text, startTime: 0, endTime: 1, status, now: 0 });
    state = add('p', 'PROVISIONAL', 'Half een zin');
    state = add('t', 'PENDING', 'Een hele zin.');
    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: ['t'] });
    state = segmentReducer(state, { type: 'SET_ACTIVE_READING', bookNumber: 43, chapter: 3, verse: 16 });
    return state;
  };

  it('puts in-flight rows back to PENDING, drops the active reading and keeps the new session id', () => {
    const restored = restoredState(JSON.parse(JSON.stringify(saved())), 'new')!;
    expect(restored.ids).toEqual(['p', 't']);
    expect(restored.byId.p.status).toBe('PENDING');
    expect(restored.byId.t.status).toBe('PENDING');
    expect(restored.activeReading).toBeNull();
    expect(restored.sessionId).toBe('new');
    expect(restored.nextSeq).toBeGreaterThanOrEqual(2);
  });

  it('rows come back dirty, so auto-translate picks them up', () => {
    const restored = restoredState(saved(), 'new')!;
    expect(selectDirtyIds(restored).sort()).toEqual(['p', 't']);
  });

  it('keeps finished rows and hand edits as they were', () => {
    let state = initState('old');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', id: 'h', sourceText: 'Goed.', startTime: 0, endTime: 1, now: 0 });
    state = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id: 'h', translatedText: 'Good.', now: 1 });
    const restored = restoredState(JSON.parse(JSON.stringify(state)), 'new')!;
    expect(restored.byId.h).toMatchObject({ translatedText: 'Good.', manualOverride: true, status: 'TRANSLATED' });
  });

  it('fills asrText for rows saved before it existed, and renumbers index', () => {
    const old = JSON.parse(JSON.stringify(saved()));
    delete old.byId.t.asrText;
    old.byId.t.index = 99;
    const restored = restoredState(old, 'new')!;
    expect(restored.byId.t.asrText).toBe('Een hele zin.');
    expect(restored.byId.t.index).toBe(1);
  });

  it('skips unreadable rows and rejects something that is not a store', () => {
    const broken = JSON.parse(JSON.stringify(saved()));
    broken.byId.p = { nonsense: true };
    expect(restoredState(broken, 'new')!.ids).toEqual(['t']);
    expect(restoredState(null, 'new')).toBeNull();
    expect(restoredState({ ids: 'x' }, 'new')).toBeNull();
    expect(restoredState('garbage', 'new')).toBeNull();
  });

  it('a new live row id from a later page never collides with a restored one', () => {
    // Restored ids look like live-<nonceA>-1-0; a fresh page uses another nonce, so APPEND_SEGMENT accepts it.
    let state = initState('old');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', id: 'live-aaa-1-0', sourceText: 'Oud.', startTime: 0, endTime: 1, now: 0 });
    const restored = restoredState(JSON.parse(JSON.stringify(state)), 'new')!;
    const next = segmentReducer(restored, { type: 'APPEND_SEGMENT', id: 'live-bbb-1-0', sourceText: 'Nieuw.', startTime: 1, endTime: 2, now: 1 });
    expect(next.ids).toEqual(['live-aaa-1-0', 'live-bbb-1-0']);
  });
});

describe('fidelity (back-translation check) lifecycle', () => {
  const translated = () => {
    let s = initState('t');
    s = segmentReducer(s, { type: 'APPEND_SEGMENT', id: 'a', sourceText: 'Een zin.', startTime: 0, endTime: 1, now: 0 });
    s = segmentReducer(s, { type: 'APPLY_TRANSLATION', id: 'a', translation: 'A sentence.', requestHash: hashText('Een zin.'), fidelity: 0.12, lowFidelity: true });
    return s;
  };

  it('is kept with the translation it was computed for', () => {
    expect(translated().byId.a).toMatchObject({ fidelity: 0.12, lowFidelity: true });
  });

  it('goes away with a source edit, a hand edit and an error — it describes only the machine text', () => {
    expect(segmentReducer(translated(), { type: 'EDIT_SOURCE', id: 'a', sourceText: 'Andere zin.', now: 1 }).byId.a.lowFidelity).toBeUndefined();
    expect(segmentReducer(translated(), { type: 'REPLACE_SOURCE', id: 'a', sourceText: 'Andere zin.', now: 1 }).byId.a.fidelity).toBeUndefined();
    expect(segmentReducer(translated(), { type: 'SET_TARGET_MANUAL', id: 'a', translatedText: 'My own.', now: 1 }).byId.a.lowFidelity).toBeUndefined();
    expect(segmentReducer(translated(), { type: 'SET_ERROR', id: 'a', error: 'x', requestHash: hashText('Een zin.') }).byId.a.fidelity).toBeUndefined();
  });

  it('a newer translation replaces the old verdict (also when it has none)', () => {
    let s = segmentReducer(translated(), { type: 'EDIT_SOURCE', id: 'a', sourceText: 'Nieuwe zin.', now: 1 });
    s = segmentReducer(s, { type: 'APPLY_TRANSLATION', id: 'a', translation: 'New sentence.', requestHash: hashText('Nieuwe zin.') });
    expect(s.byId.a.fidelity).toBeUndefined();
    expect(s.byId.a.lowFidelity).toBeUndefined();
  });
});

describe('selectCorrectionExamples', () => {
  const build = (rows: Array<{ id: string; src: string; machine?: string; human?: string }>) => {
    let s = initState('t');
    for (const r of rows) {
      s = segmentReducer(s, { type: 'APPEND_SEGMENT', id: r.id, sourceText: r.src, startTime: 0, endTime: 1, now: 0 });
      if (r.machine) s = segmentReducer(s, { type: 'APPLY_TRANSLATION', id: r.id, translation: r.machine, requestHash: hashText(r.src) });
      if (r.human !== undefined) s = segmentReducer(s, { type: 'SET_TARGET_MANUAL', id: r.id, translatedText: r.human, now: 1 });
    }
    return s;
  };

  it('returns the hand-written lines, oldest first, with the machine version they replaced', () => {
    const s = build([
      { id: 'a', src: 'Een.', machine: 'One.', human: 'First.' },
      { id: 'b', src: 'Twee.', machine: 'Two.' },                 // never edited
      { id: 'c', src: 'Drie.', human: 'Three.' },                 // typed from scratch
    ]);
    expect(selectCorrectionExamples(s)).toEqual([
      { source: 'Een.', machine: 'One.', human: 'First.' },
      { source: 'Drie.', human: 'Three.' },
    ]);
  });

  it('skips an edit that changed nothing and an empty result', () => {
    const s = build([
      { id: 'a', src: 'Een.', machine: 'One.', human: 'One.' },
      { id: 'b', src: 'Twee.', machine: 'Two.', human: '   ' },
    ]);
    expect(selectCorrectionExamples(s)).toEqual([]);
  });

  it('keeps only the most recent ones, and caps long text', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, src: `Bron ${i}.`, machine: `M${i}`, human: `H${i}` }));
    const picked = selectCorrectionExamples(build(rows), 3);
    expect(picked.map(p => p.human)).toEqual(['H5', 'H6', 'H7']);
    const long = selectCorrectionExamples(build([{ id: 'x', src: 'b'.repeat(900), machine: 'm'.repeat(900), human: 'h'.repeat(900) }]))[0];
    expect(long.source).toHaveLength(400);
    expect(long.machine).toHaveLength(400);
    expect(long.human).toHaveLength(400);
  });
});

describe('mergeRestored (restore after recording already started)', () => {
  it('puts the restored rows first, keeps the current rows and session, and renumbers', () => {
    const restored = restoredState(seedTranslated(2), 'ignored')!;
    let current = initState('now');
    current = segmentReducer(current, { type: 'APPEND_SEGMENT', id: 'live-a', sourceText: 'Nieuw.', startTime: 0, endTime: 1, now: 5 });
    const merged = mergeRestored(restored, current);
    expect(merged.ids).toEqual([...restored.ids, 'live-a']);
    expect(merged.ids.map(id => merged.byId[id].index)).toEqual([0, 1, 2]);
    expect(merged.sessionId).toBe('now');
    expect(merged.byId['live-a'].sourceText).toBe('Nieuw.');
    expect(merged.nextSeq).toBeGreaterThanOrEqual(3);
  });
  it('keeps the current row when an id exists on both sides', () => {
    const restored = restoredState(seedTranslated(1), 'x')!;
    const id = restored.ids[0];
    let current = initState('now');
    current = segmentReducer(current, { type: 'APPEND_SEGMENT', id, sourceText: 'Huidig.', startTime: 0, endTime: 1, now: 5 });
    const merged = mergeRestored(restored, current);
    expect(merged.ids).toEqual([id]);
    expect(merged.byId[id].sourceText).toBe('Huidig.');
  });
});
