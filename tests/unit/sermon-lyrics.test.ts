import { describe, it, expect } from 'vitest';
import { lyricsRows, looksLikeSongLink, type SongLyrics } from '../../client/src/lib/sermon/lyrics.js';
import {
  initState, segmentReducer, selectPublishableLines, selectTranslatable, selectDirtyIds, selectCorrectionExamples, hasNoSource,
  type SegmentStoreState,
} from '../../client/src/lib/sermon/segment-store.js';
import { ensureHeading, sameWords } from '../../client/src/lib/sermon/markdown.js';
import { computeBatch, type PublishedEntry } from '../../client/src/hooks/useListenerBroadcast.js';
import { editSuggestions } from '../../client/src/lib/sermon/edit-suggestions.js';

const sec = (id: string, type: string, text: string) => ({ id, type, label: id, text });
const NL: SongLyrics = {
  id: 'nl-1', song_id: '1-1', title: 'O hoofd vol bloed en wonden', language: 'nl', alternates: [],
  sections: [sec('v1', 'verse', 'O hoofd, bedekt met wonden,\nbelaan met smart en hoon'), sec('v2', 'verse', 'Van al de last dier plagen')],
};
const EN: SongLyrics = {
  id: 'en-1', song_id: '1-2', title: 'O sacred Head, now wounded', language: 'en', alternates: [],
  sections: [sec('v1', 'verse', 'O sacred Head, now wounded,\nwith grief and shame weighed down'), sec('v2', 'verse', 'What Thou, my Lord, hast suffered')],
};

describe('lyricsRows', () => {
  it('an English song: title + verses on the right, nothing to translate', () => {
    const plan = lyricsRows(EN, undefined, 'target');
    expect(plan.english).toBe('as-is');
    expect(plan.warnings).toEqual([]);
    expect(plan.rows.map(r => [r.sourceText, r.translatedText, r.lyrics.part])).toEqual([
      ['', '# O sacred Head, now wounded', 'title'],
      ['', EN.sections[0].text, 'verse'],
      ['', EN.sections[1].text, 'verse'],
    ]);
  });

  it('a Dutch song with its English version: paired verse by verse', () => {
    const plan = lyricsRows(NL, EN, 'source');
    expect(plan.english).toBe('from-allsongs');
    expect(plan.warnings).toEqual([]);
    expect(plan.rows.map(r => [r.sourceText, r.translatedText])).toEqual([
      [NL.title, `# ${EN.title}`], [NL.sections[0].text, EN.sections[0].text], [NL.sections[1].text, EN.sections[1].text],
    ]);
  });

  it('versions that don\'t line up are still paired by position, with a warning', () => {
    const plan = lyricsRows(NL, { ...EN, sections: [EN.sections[0], sec('c', 'chorus', 'Chorus'), EN.sections[1]] }, 'source');
    expect(plan.rows).toHaveLength(4);
    expect(plan.rows[3]).toMatchObject({ sourceText: '', translatedText: EN.sections[1].text });
    expect(plan.warnings[0]).toMatch(/don't line up/);
  });

  it('a Dutch song without English is translated; the language wins over the side it was pasted on', () => {
    const plan = lyricsRows(NL, undefined, 'target');
    expect(plan.english).toBe('translate');
    expect(plan.rows.every(r => r.translatedText === undefined)).toBe(true);
    expect(plan.warnings[0]).toMatch(/translated/);
    expect(lyricsRows(EN, undefined, 'source').warnings[0]).toMatch(/shown as is/);
    // Unknown language: the side decides.
    expect(lyricsRows({ ...EN, language: null }, undefined, 'source').english).toBe('translate');
    expect(lyricsRows({ ...EN, language: null }, undefined, 'target').english).toBe('as-is');
  });

  it('accepts a link or a display code on paste, nothing else', () => {
    expect(looksLikeSongLink(' https://allsongs.pages.dev/#x ')).toBe(true);
    expect(looksLikeSongLink('15017-1')).toBe(true);
    expect(looksLikeSongLink('Psalm 23')).toBe(false);
    expect(looksLikeSongLink('https://a.b/ x')).toBe(false);
  });
});

describe('REPLACE_WITH_LYRICS and lyrics rows in the store', () => {
  const setup = () => {
    let s = initState('t');
    s = segmentReducer(s, { type: 'APPEND_SEGMENT', id: 'a', sourceText: 'Eerst.', startTime: 0, endTime: 1, now: 0 });
    s = segmentReducer(s, { type: 'APPEND_SEGMENT', id: 'p', sourceText: '', startTime: 1, endTime: 1, lyrics: { part: 'pending' }, now: 0 });
    s = segmentReducer(s, { type: 'APPEND_SEGMENT', id: 'b', sourceText: 'Daarna.', startTime: 2, endTime: 3, now: 0 });
    return s;
  };

  it('a pending row is never translated or published', () => {
    let s = setup();
    s = segmentReducer(s, { type: 'EDIT_SOURCE', id: 'p', sourceText: '15017-1', now: 1 });
    expect(hasNoSource(s.byId.p)).toBe(true);
    expect(selectDirtyIds(s)).not.toContain('p');
    expect(selectTranslatable(s, { stabilityMs: 0 }, 1e9)).not.toContain('p');
    s = segmentReducer(s, { type: 'SET_TARGET_MANUAL', id: 'p', translatedText: '15017-1', now: 1 });
    expect(selectPublishableLines(s).map(l => l.id)).not.toContain('p');
  });

  it('puts the song where the pending row was, renumbers, and keeps AllSongs English as is', () => {
    const s = segmentReducer(setup(), { type: 'REPLACE_WITH_LYRICS', id: 'p', rows: lyricsRows(NL, EN, 'source').rows, now: 5 });
    expect(s.ids).toHaveLength(5);
    expect(s.ids[0]).toBe('a');
    expect(s.ids[4]).toBe('b');
    expect(s.ids.map(id => s.byId[id].index)).toEqual([0, 1, 2, 3, 4]);
    expect(s.byId.p).toBeUndefined();
    const title = s.byId[s.ids[1]], verse = s.byId[s.ids[2]];
    expect(title.lyrics).toEqual({ part: 'title', songId: 'nl-1', title: NL.title });
    expect(verse).toMatchObject({ sourceText: NL.sections[0].text, asrText: NL.sections[0].text, translatedText: EN.sections[0].text, manualOverride: true, status: 'TRANSLATED' });
    expect(selectDirtyIds(s).filter(id => s.byId[id].lyrics)).toEqual([]);
    // The title is a heading on the phones.
    expect(selectPublishableLines(s).find(l => l.id === s.ids[1])?.text).toBe('# O sacred Head, now wounded');
    // Ids continue the session's sequence, so a later Add row can't collide.
    expect(s.nextSeq).toBe(setup().nextSeq + 3);
  });

  it('Dutch lyrics without English are translated, and stay out of the learning data', () => {
    let s = segmentReducer(setup(), { type: 'REPLACE_WITH_LYRICS', id: 'p', rows: lyricsRows(NL, undefined, 'source').rows, now: 5 });
    const verseId = s.ids[2];
    expect(selectDirtyIds(s)).toContain(verseId);
    s = segmentReducer(s, { type: 'SET_TARGET_MANUAL', id: verseId, translatedText: 'O head, covered with wounds', now: 6 });
    expect(selectCorrectionExamples(s)).toEqual([]);
    s = segmentReducer(s, { type: 'EDIT_SOURCE', id: verseId, sourceText: 'O hoofd, bedekt met wonden en bloed', now: 7 });
    expect(editSuggestions(s.ids.map(id => s.byId[id]))).toEqual([]);
  });

  it('only a pending row can be replaced', () => {
    const s = setup();
    expect(segmentReducer(s, { type: 'REPLACE_WITH_LYRICS', id: 'a', rows: lyricsRows(EN, undefined, 'target').rows, now: 1 })).toBe(s);
    expect(segmentReducer(s, { type: 'REPLACE_WITH_LYRICS', id: 'p', rows: [], now: 1 })).toBe(s);
  });

  it('phones get the moved rows again with their new position', () => {
    let s: SegmentStoreState = setup();
    s = segmentReducer(s, { type: 'SET_TARGET_MANUAL', id: 'b', translatedText: 'Afterwards.', now: 1 });
    const published = new Map<string, PublishedEntry>();
    computeBatch(s, published, false);
    s = segmentReducer(s, { type: 'REPLACE_WITH_LYRICS', id: 'p', rows: lyricsRows(EN, undefined, 'target').rows, now: 2 });
    const batch = computeBatch(s, published, false);
    expect(batch.find(l => l.id === 'b')).toEqual({ id: 'b', index: 4, text: 'Afterwards.', edited: false });
    expect(batch.filter(l => l.id !== 'b')).toHaveLength(3);
    expect(computeBatch(s, published, false)).toEqual([]);
  });
});

describe('song titles are level-1 headings', () => {
  it('only the English side carries the marker; the Dutch title stays plain (it is the translator\'s input)', () => {
    const withTwin = lyricsRows(NL, EN, 'source').rows[0];
    expect(withTwin.sourceText).toBe(NL.title);
    expect(withTwin.translatedText).toBe(`# ${EN.title}`);
    const noTwin = lyricsRows(NL, undefined, 'source').rows[0];
    expect(noTwin.sourceText).toBe(NL.title);
    expect(noTwin.translatedText).toBeUndefined(); // translated later; made a heading when published
    expect(lyricsRows(EN, undefined, 'target').rows[0].sourceText).toBe('');
  });

  it('is never doubled, whatever the song title or the operator typed', () => {
    expect(ensureHeading('Amazing Grace')).toBe('# Amazing Grace');
    expect(ensureHeading('# Amazing Grace')).toBe('# Amazing Grace');
    expect(ensureHeading('## Amazing Grace')).toBe('## Amazing Grace');
    expect(ensureHeading('#1 hit')).toBe('# #1 hit');
    expect(ensureHeading('')).toBe('');
    expect(ensureHeading(ensureHeading('Grace'))).toBe('# Grace');
    expect(lyricsRows({ ...EN, title: '# Already a heading' }, undefined, 'target').rows[0].translatedText).toBe('# Already a heading');
  });

  it('a machine-translated title is a heading on the phones, once, and a heading is not an edit', () => {
    let s = segmentReducer(initState('t'), { type: 'APPEND_SEGMENT', id: 'p', sourceText: '', startTime: 0, endTime: 0, lyrics: { part: 'pending' }, now: 0 });
    s = segmentReducer(s, { type: 'REPLACE_WITH_LYRICS', id: 'p', rows: lyricsRows(NL, undefined, 'source').rows, now: 5 });
    const titleId = s.ids[0];
    s = segmentReducer(s, { type: 'SET_TARGET_MANUAL', id: titleId, translatedText: 'O sacred Head', now: 6 });
    expect(selectPublishableLines(s).find(l => l.id === titleId)?.text).toBe('# O sacred Head');
    s = segmentReducer(s, { type: 'SET_TARGET_MANUAL', id: titleId, translatedText: '# O sacred Head', now: 7 });
    expect(selectPublishableLines(s).find(l => l.id === titleId)?.text).toBe('# O sacred Head');
    expect(sameWords('# O sacred Head', 'O sacred Head')).toBe(true);
  });
});
