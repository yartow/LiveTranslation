import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LISTENER_LANGUAGES, EXTRA_LISTENER_LANGUAGES, LISTENER_LANGUAGE_INFO, LISTENER_UI,
  buildListenerConfig, initialListenerLang, normalizeListenerLanguages, resolveListenerLang,
} from '../../client/src/lib/listener-languages.js';
import { EXTRA_LISTENER_LANGUAGES as SERVER_LANGUAGES, normalizeConfig } from '../../server/lib/listener-lang.js';
import { sanitizeSettings } from '../../client/src/lib/settings-validate.js';
import { defaultSettings } from '../../client/src/hooks/useSettings.js';
import { draftingIds } from '../../client/src/hooks/useListenerBroadcast.js';
import { initState, segmentReducer, selectPublishableLines } from '../../client/src/lib/sermon/segment-store.js';
import { hashText } from '../../client/src/lib/sermon/segment-model.js';

describe('client and server agree on the listener languages', () => {
  it('lists the same extra languages', () => {
    expect([...EXTRA_LISTENER_LANGUAGES]).toEqual([...SERVER_LANGUAGES]);
  });

  it('the config the operator page sends survives the hub\'s allowlist untouched', () => {
    const languages = normalizeListenerLanguages({
      hi: { enabled: true, provider: 'openai', model: 'gpt-4o-mini' },
      ta: { enabled: true, provider: 'claude', model: 'x' },
    });
    const sent = buildListenerConfig(languages, { baseUrl: 'http://localhost:11434', model: 'qwen3.6:latest' });
    const received = normalizeConfig(JSON.parse(JSON.stringify(sent)));
    expect(received.enabled).toEqual(['hi', 'ta']);
    expect(received.models.ta?.provider).toBe('claude');
    expect(received.ollamaBaseUrl).toBe('http://localhost:11434');
  });

  it('defaults to English only: nothing switched on', () => {
    expect(buildListenerConfig(DEFAULT_LISTENER_LANGUAGES, { baseUrl: '', model: '' }).enabled).toEqual([]);
  });
});

describe('normalizeListenerLanguages', () => {
  it('fills in everything and drops what it does not know', () => {
    const out = normalizeListenerLanguages({ hi: { enabled: true }, fr: { enabled: true }, ta: 'junk' });
    expect(Object.keys(out)).toEqual(['hi', 'ta', 'zh', 'zh-TW']);
    expect(out.hi).toEqual({ enabled: true, provider: 'openai', model: 'gpt-4o-mini' });
    expect(out.ta.enabled).toBe(false);
  });

  it('is applied to stored settings by sanitizeSettings', () => {
    const merged = { ...defaultSettings, listenerLanguages: { zh: { enabled: 'yes', provider: 'bogus', model: '' } } } as never;
    const clean = sanitizeSettings(merged, defaultSettings);
    expect(clean.listenerLanguages.zh).toEqual({ enabled: false, provider: 'openai', model: 'gpt-4o-mini' });
    expect(clean.listenerLanguages.hi.enabled).toBe(false);
  });
});

describe('choosing a language on the phone', () => {
  it('?lang= wins, then the remembered choice, then English', () => {
    expect(initialListenerLang('?lang=hi', 'ta')).toBe('hi');
    expect(initialListenerLang('', 'ta')).toBe('ta');
    expect(initialListenerLang('?lang=klingon', 'zh-TW')).toBe('zh-TW');
    expect(initialListenerLang('?lang=klingon', 'nonsense')).toBe('en');
    expect(initialListenerLang('', null)).toBe('en');
  });

  it('only ever shows a language the operator offers', () => {
    expect(resolveListenerLang('hi', ['hi', 'ta'])).toBe('hi');
    expect(resolveListenerLang('hi', [])).toBe('en');
    expect(resolveListenerLang('en', [])).toBe('en');
    expect(resolveListenerLang('zh-TW', ['zh'])).toBe('en');
  });
});

describe('phone presentation', () => {
  it('gives every language its own chrome strings, all filled in', () => {
    for (const code of ['en', ...EXTRA_LISTENER_LANGUAGES] as const) {
      for (const text of Object.values(LISTENER_UI[code])) expect(text.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(Object.values(LISTENER_UI).map(u => u.title)).size).toBe(5);
  });

  it('tags the text with the right script variant and never italicises Hindi or Tamil', () => {
    expect(LISTENER_LANGUAGE_INFO.zh.htmlLang).toBe('zh-Hans');
    expect(LISTENER_LANGUAGE_INFO['zh-TW'].htmlLang).toBe('zh-Hant');
    expect(LISTENER_LANGUAGE_INFO.hi.italicForEdited).toBe(false);
    expect(LISTENER_LANGUAGE_INFO.ta.italicForEdited).toBe(false);
    expect(LISTENER_LANGUAGE_INFO.en.italicForEdited).toBe(true);
    expect(LISTENER_LANGUAGE_INFO.zh.italicForEdited).toBe(true);
  });
});

describe('draftingIds — which published lines the operator is still typing', () => {
  const append = (state: ReturnType<typeof initState>, id: string, sourceText = '') =>
    segmentReducer(state, { type: 'APPEND_SEGMENT', id, sourceText, startTime: 0, endTime: 0, now: 1 });

  it('returns only the hand-typed lines of a batch', () => {
    let state = initState('s1');
    state = append(append(state, 'typed'), 'other', 'Hallo');
    state = segmentReducer(state, { type: 'SET_TARGET_MANUAL', id: 'typed', translatedText: 'Typed by hand', now: 2 });
    state = segmentReducer(state, { type: 'APPLY_TRANSLATION', id: 'other', translation: 'Machine text', requestHash: hashText('Hallo'), now: 3 } as never);
    // both lines are publishable, so the test is about who typed them, not about what is published
    expect(selectPublishableLines(state).map(l => [l.id, l.manual])).toEqual([['typed', true], ['other', false]]);
    const ids = draftingIds([{ id: 'typed' }, { id: 'other' }, { id: 'unknown' }], state);
    expect(ids).toEqual(['typed']);
  });

  it('is empty for an empty batch', () => {
    expect(draftingIds([], initState('s1'))).toEqual([]);
  });
});
