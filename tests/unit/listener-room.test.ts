import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ListenerRoom } from '../../server/lib/listener-room.js';
import type { TranslateRequest } from '../../server/lib/listener-translate.js';

type Msg = Record<string, any>;

const line = (id: string, index: number, text: string, edited = false) => ({ id, index, text, edited });

function setup() {
  const calls: TranslateRequest[] = [];
  const state = {
    impl: (async (req: TranslateRequest) => req.texts.map(t => `[${req.lang}] ${t}`)) as (req: TranslateRequest) => Promise<string[]>,
  };
  const logs: any[] = [];
  const room = new ListenerRoom({
    translate: async (req) => { calls.push(req); return state.impl(req); },
    log: (e) => logs.push(e),
  });
  const operatorMsgs: Msg[] = [];
  room.setBroadcaster((m) => operatorMsgs.push(m as Msg));

  const phones = new Map<string, Msg[]>();
  const addPhone = (id: string, lang?: string) => {
    const msgs: Msg[] = [];
    phones.set(id, msgs);
    room.addListener(id, (m) => msgs.push(m as Msg));
    if (lang) room.onListenerMessage(id, { type: 'setLanguage', lang });
    return msgs;
  };
  const operator = (m: unknown) => room.onBroadcasterMessage(m, { operator: true });
  const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  return { room, calls, state, logs, operatorMsgs, phones, addPhone, operator, flush };
}

const updates = (msgs: Msg[], lang: string) =>
  msgs.filter(m => m.type === 'update' && m.lang === lang).flatMap(m => m.lines as Msg[]);
const lastSnapshot = (msgs: Msg[]) => [...msgs].reverse().find(m => m.type === 'snapshot')!;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ListenerRoom — English phones (unchanged behaviour)', () => {
  it('sends a languages message and an English snapshot on connect', () => {
    const { room, operator, addPhone } = setup();
    operator({ type: 'sync', lines: [line('a', 0, 'Hello')] });
    const msgs = addPhone('p1');
    expect(msgs[0]).toEqual({ type: 'languages', enabled: [] });
    expect(msgs[1]).toEqual({ type: 'snapshot', lang: 'en', lines: [line('a', 0, 'Hello')] });
    expect(room.state.lines.size).toBe(1);
  });

  it('forwards published lines to English phones at once and tags them lang:en', () => {
    const { operator, addPhone } = setup();
    const msgs = addPhone('p1');
    operator({ type: 'publish', lines: [line('a', 0, 'Hello')] });
    expect(updates(msgs, 'en')).toEqual([line('a', 0, 'Hello')]);
  });

  it('clear and ping reach every phone', () => {
    const { room, operator, addPhone } = setup();
    const en = addPhone('p1');
    operator({ type: 'config', enabled: ['hi'] });
    const hi = addPhone('p2', 'hi');
    operator({ type: 'clear' });
    room.ping();
    expect(en.filter(m => m.type === 'clear')).toHaveLength(1);
    expect(hi.filter(m => m.type === 'clear')).toHaveLength(1);
    expect(hi.filter(m => m.type === 'ping')).toHaveLength(1);
  });
});

describe('ListenerRoom — config and the language allowlist', () => {
  it('tells every phone which extra languages are offered', () => {
    const { operator, addPhone } = setup();
    const msgs = addPhone('p1');
    operator({ type: 'config', enabled: ['hi', 'ta', 'fr'] });
    expect(msgs.filter(m => m.type === 'languages').pop()).toEqual({ type: 'languages', enabled: ['hi', 'ta'] });
  });

  it('answers a request for a language that is not offered with the English snapshot', () => {
    const { room, operator, addPhone } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    const msgs = addPhone('p1');
    for (const lang of ['ta', 'fr', 'xx', 42, null]) {
      room.onListenerMessage('p1', { type: 'setLanguage', lang });
      expect(lastSnapshot(msgs).lang).toBe('en');
    }
  });

  it('never translates into a language that was not switched on', async () => {
    const { room, operator, addPhone, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    operator({ type: 'sync', lines: [line('a', 0, 'Hello')] });
    const msgs = addPhone('p1');
    room.onListenerMessage('p1', { type: 'setLanguage', lang: 'ta' });
    await flush(100);
    expect(calls).toHaveLength(0);
    expect(lastSnapshot(msgs).lang).toBe('en');
  });

  it('ignores config from a connection that is not the operator machine (it spends API keys)', async () => {
    const { room, addPhone, calls, flush } = setup();
    room.onBroadcasterMessage({ type: 'config', enabled: ['hi'] }, { operator: false });
    room.onBroadcasterMessage({ type: 'sync', lines: [line('a', 0, 'Hello')] }, { operator: false });
    const msgs = addPhone('p1', 'hi');
    await flush(100);
    expect(calls).toHaveLength(0);
    expect(lastSnapshot(msgs).lang).toBe('en');
  });

  it('puts phones back on English, with a snapshot, when their language is switched off', () => {
    const { operator, addPhone } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    operator({ type: 'sync', lines: [line('a', 0, 'Hello')] });
    const msgs = addPhone('p1', 'hi');
    expect(lastSnapshot(msgs).lang).toBe('hi');
    operator({ type: 'config', enabled: [] });
    expect(lastSnapshot(msgs)).toEqual({ type: 'snapshot', lang: 'en', lines: [line('a', 0, 'Hello')] });
    expect(msgs.filter(m => m.type === 'languages').pop()).toEqual({ type: 'languages', enabled: [] });
  });

  it('reports how many phones read each language to the operator', () => {
    const { operator, operatorMsgs, addPhone } = setup();
    operator({ type: 'config', enabled: ['hi', 'ta'] });
    addPhone('p1');
    addPhone('p2', 'hi');
    addPhone('p3', 'hi');
    addPhone('p4', 'ta');
    const last = operatorMsgs.filter(m => m.type === 'listenerCount').pop()!;
    expect(last.count).toBe(4);
    expect(last.byLang).toEqual({ en: 1, hi: 2, ta: 1, zh: 0, 'zh-TW': 0 });
  });
});

describe('ListenerRoom — translating for the phones that read a language', () => {
  it('translates nothing while no phone reads the language', async () => {
    const { operator, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi', 'ta'] });
    operator({ type: 'sync', lines: [line('a', 0, 'One'), line('b', 1, 'Two')] });
    operator({ type: 'publish', lines: [line('c', 2, 'Three')] });
    await flush(5000);
    expect(calls).toHaveLength(0);
  });

  it('a phone that joins later gets the backlog: English at first, then its language, translated in one batch', async () => {
    const { operator, addPhone, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    operator({ type: 'sync', lines: [line('a', 0, 'One'), line('b', 1, 'Two')] });
    const msgs = addPhone('p1', 'hi');
    expect(lastSnapshot(msgs)).toEqual({ type: 'snapshot', lang: 'hi', lines: [line('a', 0, 'One'), line('b', 1, 'Two')] });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].texts).toEqual(['One', 'Two']);
    expect(updates(msgs, 'hi')).toEqual([line('a', 0, '[hi] One'), line('b', 1, '[hi] Two')]);
  });

  it('catches the backlog up newest first, ten lines per call', async () => {
    const { operator, addPhone, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    operator({ type: 'sync', lines: Array.from({ length: 25 }, (_, i) => line(`l${i}`, i, `line ${i}`)) });
    addPhone('p1', 'hi');
    await flush();
    expect(calls.map(c => c.texts.length)).toEqual([10, 10, 5]);
    expect(calls[0].texts[0]).toBe('line 15');
    expect(calls[0].texts[9]).toBe('line 24');
    expect(calls[2].texts[0]).toBe('line 0');
    // each batch carries the two lines before it as context
    expect(calls[0].before).toEqual(['line 13', 'line 14']);
    expect(calls[2].before).toEqual([]);
  });

  it('a live line goes out at once and reaches only the phones reading that language', async () => {
    const { operator, addPhone, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi', 'ta'] });
    operator({ type: 'sync', lines: [line('a', 0, 'One'), line('b', 1, 'Two')] });
    const en = addPhone('en1');
    const hi = addPhone('hi1', 'hi');
    const ta = addPhone('ta1');
    await flush();
    calls.length = 0;
    operator({ type: 'publish', lines: [line('c', 2, 'Three')] });
    // English: immediately, before any translation exists
    expect(updates(en, 'en')).toEqual([line('c', 2, 'Three')]);
    expect(updates(hi, 'hi').map(l => l.id)).not.toContain('c');
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ lang: 'hi', texts: ['Three'], before: ['One', 'Two'] });
    expect(updates(hi, 'hi').pop()).toEqual(line('c', 2, '[hi] Three'));
    expect(updates(ta, 'ta')).toEqual([]);
    expect(updates(en, 'hi')).toEqual([]);
  });

  it('English phones are never held up by translation, even a slow or failing one', async () => {
    const { operator, addPhone, state, flush } = setup();
    state.impl = () => new Promise(() => { /* never answers */ });
    operator({ type: 'config', enabled: ['hi'] });
    const en = addPhone('en1');
    addPhone('hi1', 'hi');
    operator({ type: 'publish', lines: [line('a', 0, 'Hello')] });
    expect(updates(en, 'en')).toEqual([line('a', 0, 'Hello')]);
    await flush(10);
  });

  it('waits for the operator to stop typing a line before translating it, and translates it once', async () => {
    const { operator, addPhone, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    const hi = addPhone('hi1', 'hi');
    for (const text of ['G', 'Gr', 'Gra', 'Grace']) {
      operator({ type: 'publish', lines: [line('a', 0, text)], drafting: ['a'] });
      await flush(300);
    }
    expect(calls).toHaveLength(0);
    await flush(1500);
    expect(calls).toHaveLength(1);
    expect(calls[0].texts).toEqual(['Grace']);
    expect(updates(hi, 'hi')).toEqual([line('a', 0, '[hi] Grace')]);
  });

  it('does not forward the drafting hint (or anything but four fields) to a phone', async () => {
    const { operator, addPhone, flush } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    const en = addPhone('en1');
    const hi = addPhone('hi1', 'hi');
    operator({ type: 'publish', lines: [line('a', 0, 'Hi')], drafting: ['a'] });
    await flush(2000);
    for (const m of [...en, ...hi]) expect(JSON.stringify(m)).not.toContain('drafting');
    for (const l of [...updates(en, 'en'), ...updates(hi, 'hi')]) expect(Object.keys(l).sort()).toEqual(['edited', 'id', 'index', 'text']);
  });

  it('pays for identical English only once — across a sync that gives the lines new ids', async () => {
    const { operator, addPhone, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    operator({ type: 'sync', lines: [line('old-1', 0, 'Same sentence.')] });
    const hi = addPhone('hi1', 'hi');
    await flush();
    expect(calls).toHaveLength(1);
    operator({ type: 'sync', lines: [line('new-1', 0, 'Same sentence.')] }); // page reloaded: new session, new ids
    await flush();
    expect(calls).toHaveLength(1);
    expect(lastSnapshot(hi).lines).toEqual([line('new-1', 0, '[hi] Same sentence.')]);
  });

  it('a changed position or edited mark with the same words costs no call', async () => {
    const { operator, addPhone, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    operator({ type: 'sync', lines: [line('a', 0, 'Same words.')] });
    const hi = addPhone('hi1', 'hi');
    await flush();
    calls.length = 0;
    operator({ type: 'publish', lines: [line('a', 3, 'Same words.')] }); // a song was inserted above
    await flush();
    expect(calls).toHaveLength(0);
    expect(updates(hi, 'hi').pop()).toEqual(line('a', 3, '[hi] Same words.'));
  });

  it('re-translates an edited line, carries the edited mark, and drops an answer for text that has since changed', async () => {
    const { operator, addPhone, state, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    const hi = addPhone('hi1', 'hi');
    const gates: Array<() => void> = [];
    state.impl = (req) => new Promise(resolve => { gates.push(() => resolve(req.texts.map(t => `[hi] ${t}`))); });

    operator({ type: 'publish', lines: [line('a', 0, 'First version')] });
    await flush();
    expect(calls).toHaveLength(1);
    operator({ type: 'publish', lines: [line('a', 0, 'Second version', true)] });
    await flush();
    expect(calls).toHaveLength(2);
    gates[0](); // the answer for the first version arrives late...
    await flush();
    expect(updates(hi, 'hi')).toEqual([]); // ...and is not shown
    gates[1]();
    await flush();
    expect(updates(hi, 'hi')).toEqual([line('a', 0, '[hi] Second version', true)]);
  });

  it('retries once, then shows the English line and tells the operator; recovery is reported too', async () => {
    const { operator, operatorMsgs, addPhone, state, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    const hi = addPhone('hi1', 'hi');
    state.impl = async () => { throw Object.assign(new Error('401 bad key'), { status: 401 }); };
    operator({ type: 'publish', lines: [line('a', 0, 'Hello')] });
    await flush(1000);
    expect(calls).toHaveLength(2); // original + one retry
    expect(updates(hi, 'hi')).toEqual([line('a', 0, 'Hello')]); // English fallback, not silence
    expect(operatorMsgs.filter(m => m.type === 'translationStatus')).toEqual([
      { type: 'translationStatus', lang: 'hi', ok: false, error: 'API key missing or invalid' },
    ]);

    state.impl = async (req) => req.texts.map(t => `[hi] ${t}`);
    operator({ type: 'publish', lines: [line('b', 1, 'World')] });
    await flush(1000);
    expect(updates(hi, 'hi').pop()).toEqual(line('b', 1, '[hi] World'));
    expect(operatorMsgs.filter(m => m.type === 'translationStatus').pop()).toEqual({ type: 'translationStatus', lang: 'hi', ok: true });
  });

  it('falls back to one call per line when a batch reply is unusable', async () => {
    const { operator, addPhone, state, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi'] });
    operator({ type: 'sync', lines: [line('a', 0, 'One'), line('b', 1, 'Two')] });
    state.impl = async (req) => (req.texts.length > 1 ? ['only one answer'] : req.texts.map(t => `[hi] ${t}`));
    const hi = addPhone('hi1', 'hi');
    await flush(1000);
    expect(calls.map(c => c.texts.length)).toEqual([2, 2, 1, 1]); // batch + its retry, then a call per line
    expect(updates(hi, 'hi').map(l => l.text).sort()).toEqual(['[hi] One', '[hi] Two']);
  });

  it('uses the operator\'s per-language provider and model, and re-translates what phones read when the model changes', async () => {
    const { operator, addPhone, calls, flush } = setup();
    operator({ type: 'config', enabled: ['ta'], models: { ta: { provider: 'openai', model: 'gpt-4o-mini' } } });
    operator({ type: 'sync', lines: [line('a', 0, 'Grace')] });
    const ta = addPhone('ta1', 'ta');
    await flush();
    expect(calls[0].model).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });

    operator({ type: 'config', enabled: ['ta'], models: { ta: { provider: 'claude', model: 'x' } } });
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].model.provider).toBe('claude');
    expect(updates(ta, 'ta')).toHaveLength(2); // the first translation, then the one from the new model
  });

  it('logs every translation with its language', async () => {
    const { operator, addPhone, logs, flush } = setup();
    operator({ type: 'config', enabled: ['zh'] });
    addPhone('zh1', 'zh');
    operator({ type: 'publish', lines: [line('a', 0, 'Grace')] });
    await flush();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ lang: 'zh', id: 'a', english: 'Grace', translation: '[zh] Grace', provider: 'openai', batchSize: 1 });
  });
});

describe('ListenerRoom — Dutch can never reach a phone, in any language', () => {
  it('translates and forwards only the four-field English line, whatever the operator socket carries', async () => {
    const { operator, addPhone, calls, flush } = setup();
    operator({ type: 'config', enabled: ['hi', 'ta', 'zh', 'zh-TW'], sourceText: 'Nederlands in config' });
    const everyone = [
      addPhone('en', undefined),
      addPhone('hi', 'hi'), addPhone('ta', 'ta'), addPhone('zh', 'zh'), addPhone('zhtw', 'zh-TW'),
    ];

    const dutch = 'DUTCH-SOURCE Genade alleen';
    const leaky = (id: string, index: number, text: string) =>
      ({ ...line(id, index, text), sourceText: dutch, source: dutch, nl: dutch, asrText: dutch, machineText: dutch, translation: { sourceText: dutch } });
    operator({ type: 'sync', lines: [leaky('a', 0, 'Grace alone.')] });
    operator({ type: 'publish', lines: [leaky('b', 1, 'Faith alone.')], sourceText: dutch, drafting: ['b'] });
    await flush(2500);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(JSON.stringify(call)).not.toContain('DUTCH-SOURCE');
      expect(JSON.stringify(call)).not.toContain('Nederlands');
      expect(Object.keys(call).sort()).toEqual(['before', 'lang', 'model', 'ollamaBaseUrl', 'ollamaModel', 'terms', 'texts'].filter(k => k in call).sort());
      for (const text of [...call.texts, ...call.before]) expect(['Grace alone.', 'Faith alone.']).toContain(text);
    }
    for (const msgs of everyone) {
      const wire = JSON.stringify(msgs);
      expect(wire).not.toContain('DUTCH-SOURCE');
      expect(wire).not.toContain('sourceText');
      expect(wire).not.toContain('Nederlands');
      for (const m of msgs.filter(m => m.type === 'snapshot' || m.type === 'update')) {
        for (const l of m.lines as Msg[]) expect(Object.keys(l).sort()).toEqual(['edited', 'id', 'index', 'text']);
      }
    }
    // and every language really did get its own translation of the English
    expect(updates(everyone[1], 'hi').map(l => l.text)).toContain('[hi] Faith alone.');
    expect(updates(everyone[4], 'zh-TW').map(l => l.text)).toContain('[zh-TW] Faith alone.');
  });
});
