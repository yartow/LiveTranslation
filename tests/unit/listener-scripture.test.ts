import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { parseReference, listenerScriptureText } from '../../server/lib/listener-scripture.js';
import { _resetBibleStoreForTests } from '../../server/lib/bible-store.js';
import { _resetBibleBooksForTests } from '../../server/lib/bible-books.js';
import { ListenerRoom } from '../../server/lib/listener-room.js';
import type { TranslateRequest } from '../../server/lib/listener-translate.js';
import { initState, segmentReducer, selectPublishableLines } from '../../client/src/lib/sermon/segment-store.js';
import { hashText } from '../../client/src/lib/sermon/segment-model.js';
import { computeBatch, scriptureHints, type PublishedEntry } from '../../client/src/hooks/useListenerBroadcast.js';

type Msg = Record<string, any>;

let dir: string;
const gz = (o: unknown) => gzipSync(JSON.stringify(o));

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'listener-bible-'));
  writeFileSync(path.join(dir, 'books.json'), JSON.stringify([
    { n: 43, nl: 'Johannes', en: 'John', abbr: 'Joh' },
    { n: 46, nl: '1 Korinthe', en: '1 Corinthians', abbr: '1Kor' },
  ]));
  writeFileSync(path.join(dir, 'hi-ov.json.gz'), gz({ '43:3:16': 'क्योंकि परमेश्वर ने', '43:3:17': 'परमेश्वर ने अपने पुत्र को', '46:13:4': 'प्रेम धीरजवन्त है' }));
  writeFileSync(path.join(dir, 'listener-bible-mismatch.json'), JSON.stringify({ hi: ['46:13'] }));
  // Chinese folds verse 18 into 17 (empty), as the real sources do.
  writeFileSync(path.join(dir, 'zh-cuv.json.gz'), gz({ '43:3:16': '上帝爱世人', '43:3:17': '因为上帝差他', '43:3:18': '' }));
  process.env.BIBLE_DIR = dir;
});
afterAll(() => { delete process.env.BIBLE_DIR; rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { _resetBibleStoreForTests(); _resetBibleBooksForTests(); });

describe('parseReference', () => {
  it('reads a single verse, a range and a numbered book', () => {
    expect(parseReference('John 3:16')).toEqual({ bookNumber: 43, chapter: 3, verseStart: 16, verseEnd: 16 });
    expect(parseReference('John 3:16-17')).toEqual({ bookNumber: 43, chapter: 3, verseStart: 16, verseEnd: 17 });
    expect(parseReference('1 Corinthians 13:4-7')).toEqual({ bookNumber: 46, chapter: 13, verseStart: 4, verseEnd: 7 });
  });

  it('rejects what is not a reference (unknown book, junk, backwards or huge ranges)', () => {
    for (const bad of ['Nonsense 3:16', 'John', 'John 3', 'John 3:17-16', 'John 3:1-90', '', 'x'.repeat(100)]) {
      expect(parseReference(bad)).toBeNull();
    }
  });
});

describe('listenerScriptureText', () => {
  it('joins verses with a space, and Chinese without one, skipping verses the source folded away', () => {
    expect(listenerScriptureText('hi', 'John 3:16-17')).toBe('क्योंकि परमेश्वर ने परमेश्वर ने अपने पुत्र को');
    expect(listenerScriptureText('zh', 'John 3:16-18')).toBe('上帝爱世人因为上帝差他');
  });

  it('never substitutes from a chapter the build flagged as numbered differently from English', () => {
    expect(listenerScriptureText('hi', '1 Corinthians 13:4')).toBeUndefined(); // 46:13 is listed for hi, although the text exists
    expect(listenerScriptureText('hi', 'John 3:16')).toBeDefined(); // other chapters are unaffected
  });

  it('is undefined when the language\'s Bible is not built, the verse is missing or the reference is unusable', () => {
    expect(listenerScriptureText('ta', 'John 3:16')).toBeUndefined(); // no ta-ov.json.gz in this fixture
    expect(listenerScriptureText('hi', 'John 3:99')).toBeUndefined();
    expect(listenerScriptureText('zh', 'John 3:18')).toBeUndefined(); // only an empty (folded) verse
    expect(listenerScriptureText('hi', 'Bogus 1:1')).toBeUndefined();
  });
});

// ── the room: what a phone is shown ──

const line = (id: string, index: number, text: string, edited = false) => ({ id, index, text, edited });

function setup() {
  const calls: TranslateRequest[] = [];
  const logs: any[] = [];
  const room = new ListenerRoom({
    translate: async (req) => { calls.push(req); return req.texts.map(t => `[${req.lang}] ${t}`); },
    log: (e) => logs.push(e),
    scriptureText: listenerScriptureText,
  });
  room.setBroadcaster(() => {});
  const phone = (id: string, lang: string) => {
    const msgs: Msg[] = [];
    room.addListener(id, (m) => msgs.push(m as Msg));
    room.onListenerMessage(id, { type: 'setLanguage', lang });
    return msgs;
  };
  const operator = (m: unknown) => room.onBroadcasterMessage(m, { operator: true });
  operator({ type: 'config', enabled: ['hi', 'zh', 'ta'] });
  return { room, calls, logs, phone, operator };
}
const updates = (msgs: Msg[], lang: string) => msgs.filter(m => m.type === 'update' && m.lang === lang).flatMap(m => m.lines as Msg[]);
const verse = 'For God so loved the world';

describe('ListenerRoom — verbatim Bible readings in the phone language\'s own Bible', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('shows the Bible\'s verses instead of calling the model, and logs it as a Bible lookup', async () => {
    const { phone, operator, calls, logs } = setup();
    const hi = phone('p1', 'hi');
    operator({ type: 'publish', lines: [line('a', 0, verse)], scriptures: { a: 'John 3:16-17' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updates(hi, 'hi')).toEqual([line('a', 0, 'क्योंकि परमेश्वर ने परमेश्वर ने अपने पुत्र को')]);
    expect(calls).toHaveLength(0);
    expect(logs[0]).toMatchObject({ provider: 'bible', model: 'John 3:16-17', lang: 'hi' });
  });

  it('keeps a "> " quote and uses the Chinese Bible for Chinese phones', async () => {
    const { phone, operator } = setup();
    const zh = phone('p1', 'zh');
    operator({ type: 'publish', lines: [line('a', 0, `> ${verse}`)], scriptures: { a: 'John 3:16-18' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updates(zh, 'zh')[0].text).toBe('> 上帝爱世人因为上帝差他');
  });

  it('translates normally when there is no hint, when the language has no Bible built, or the verse is unknown', async () => {
    const { phone, operator, calls } = setup();
    const hi = phone('p1', 'hi');
    const ta = phone('p2', 'ta');
    operator({ type: 'publish', lines: [line('a', 0, 'Plain sentence.'), line('b', 1, verse)], scriptures: { b: 'John 3:16' } });
    await vi.advanceTimersByTimeAsync(0);
    const byId = (msgs: Msg[], lang: string) => Object.fromEntries(updates(msgs, lang).map(l => [l.id, l.text]));
    expect(byId(hi, 'hi')).toEqual({ a: '[hi] Plain sentence.', b: 'क्योंकि परमेश्वर ने' }); // the verse needs no model call
    expect(byId(ta, 'ta')).toEqual({ a: '[ta] Plain sentence.', b: `[ta] ${verse}` }); // Tamil Bible not built here
    operator({ type: 'publish', lines: [line('c', 2, 'Another one.')], scriptures: { c: 'John 3:99' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updates(hi, 'hi').pop()!.text).toBe('[hi] Another one.');
    expect(calls.filter(c => c.lang === 'hi').map(c => c.texts[0])).not.toContain(verse); // the verse itself never went to the model for Hindi
  });

  it('drops back to a model translation when the hint goes away (verse edited or dismissed)', async () => {
    const { phone, operator } = setup();
    const hi = phone('p1', 'hi');
    operator({ type: 'publish', lines: [line('a', 0, verse)], scriptures: { a: 'John 3:16' } });
    await vi.advanceTimersByTimeAsync(0);
    operator({ type: 'publish', lines: [line('a', 0, verse, true)] }); // same words, no hint any more
    await vi.advanceTimersByTimeAsync(0);
    expect(updates(hi, 'hi').pop()!.text).toBe(`[hi] ${verse}`);
  });

  it('gives a late joiner the verse in the snapshot, and never forwards the hint or the reference to a phone', async () => {
    const { phone, operator, calls } = setup();
    operator({ type: 'sync', lines: [line('a', 0, verse)], scriptures: { a: 'John 3:16' } });
    const en = phone('p0', 'en');
    const hi = phone('p1', 'hi');
    await vi.advanceTimersByTimeAsync(0);
    const snap = [...hi].reverse().find(m => m.type === 'snapshot')!;
    expect(snap.lines).toEqual([line('a', 0, 'क्योंकि परमेश्वर ने')]);
    expect(calls).toHaveLength(0);
    for (const msg of [...en, ...hi]) expect(JSON.stringify(msg)).not.toContain('John');
    for (const l of snap.lines) expect(Object.keys(l).sort()).toEqual(['edited', 'id', 'index', 'text']);
  });

  it('does not let a slow model translation replace a verse that arrived meanwhile', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const room = new ListenerRoom({
      translate: async (req) => { await gate; return req.texts.map(t => `[${req.lang}] ${t}`); },
      scriptureText: listenerScriptureText,
    });
    room.setBroadcaster(() => {});
    const msgs: Msg[] = [];
    room.addListener('p1', (m) => msgs.push(m as Msg));
    room.onBroadcasterMessage({ type: 'config', enabled: ['hi'] }, { operator: true });
    room.onListenerMessage('p1', { type: 'setLanguage', lang: 'hi' });
    // plain English first: a model call starts and waits on the gate ...
    room.onBroadcasterMessage({ type: 'publish', lines: [line('a', 0, verse)] }, { operator: true });
    await vi.advanceTimersByTimeAsync(0);
    // ... the same words are then re-published as a verbatim reading: the verse goes out at once ...
    room.onBroadcasterMessage({ type: 'publish', lines: [line('a', 0, verse)], scriptures: { a: 'John 3:16' } }, { operator: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(updates(msgs, 'hi').pop()!.text).toBe('क्योंकि परमेश्वर ने');
    // ... and the late model answer must not replace it.
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(updates(msgs, 'hi').map(l => l.text)).not.toContain(`[hi] ${verse}`);
    expect(updates(msgs, 'hi').pop()!.text).toBe('क्योंकि परमेश्वर ने');
  });

  it('ignores a malformed or oversized hint', async () => {
    const { phone, operator, calls } = setup();
    const hi = phone('p1', 'hi');
    operator({ type: 'publish', lines: [line('a', 0, verse), line('b', 1, 'Two.')], scriptures: { a: 12, b: 'x'.repeat(200) } });
    await vi.advanceTimersByTimeAsync(0);
    expect(updates(hi, 'hi').map(l => l.text).sort()).toEqual([`[hi] ${verse}`, '[hi] Two.'].sort());
    expect(calls.length).toBeGreaterThan(0);
  });
});

// ── the operator's page: which rows count as a verbatim reading ──

describe('operator page — scripture hint', () => {
  const verbatimState = () => {
    let state = initState('s1');
    state = segmentReducer(state, { type: 'APPEND_SEGMENT', id: 'v', sourceText: 'Want zo lief heeft God de wereld gehad.', startTime: 0, endTime: 1, now: 1 });
    state = segmentReducer(state, { type: 'MARK_TRANSLATING', ids: ['v'] });
    return segmentReducer(state, {
      type: 'APPLY_SCRIPTURE', id: 'v', text: verse, reference: 'John 3:16', version: 'ESV', requestHash: hashText('Want zo lief heeft God de wereld gehad.'),
    });
  };

  it('marks an untouched verbatim row, and keeps the mark when it is only formatted as a quote', () => {
    let state = verbatimState();
    expect(selectPublishableLines(state)[0].scripture).toBe('John 3:16');
    state = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id: 'v', translatedText: `> ${verse}`, now: 5 });
    expect(selectPublishableLines(state)[0].scripture).toBe('John 3:16');
    expect(scriptureHints([{ id: 'v' }], state)).toEqual({ v: 'John 3:16' });
  });

  it('drops the mark once the operator changes the words, and when the row is not verbatim', () => {
    let state = verbatimState();
    state = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id: 'v', translatedText: 'For God loved the world so much', now: 5 });
    expect(selectPublishableLines(state)[0].scripture).toBeUndefined();
    expect(scriptureHints([{ id: 'v' }], state)).toEqual({});
  });

  it('re-sends a line whose words did not change but whose hint did', () => {
    const state = verbatimState();
    const published = new Map<string, PublishedEntry>();
    expect(computeBatch(state, published, false)).toHaveLength(1);
    expect(published.get('v')!.scripture).toBe('John 3:16');
    expect(computeBatch(state, published, false)).toHaveLength(0); // nothing changed: quiet
    published.get('v')!.scripture = undefined; // as if the hub last heard this line without a hint
    expect(computeBatch(state, published, false)).toHaveLength(1);
    expect(published.get('v')!.scripture).toBe('John 3:16');
  });
});
