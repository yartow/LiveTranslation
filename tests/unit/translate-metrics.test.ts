import { describe, it, expect } from 'vitest';
import { chrF, exactMatch, normalizeForExact, summarize, parseRunSpec } from '../../scripts/lib/translate-metrics.js';

describe('chrF', () => {
  it('is 100 for identical text, ignoring whitespace', () => {
    expect(chrF('The Lord be with you.', 'The Lord be with you.')).toBe(100);
    expect(chrF('The Lord  be with\nyou.', 'The Lord be with you.')).toBe(100);
  });

  it('matches a hand-computed value', () => {
    // "abc" vs "abd": n=1 P=R=2/3, n=2 P=R=1/2, n=3 P=R=0 (longer n skipped) -> mean 0.3889; with P = R, F = P
    expect(chrF('abc', 'abd')).toBeCloseTo(38.89, 1);
  });

  it('scores a close translation above a distant one, and unrelated text near zero', () => {
    const ref = 'We may trust in the faithfulness of our God.';
    const close = chrF('We can trust in the faithfulness of our God.', ref);
    const far = chrF('Rain falls heavily on the city today.', ref);
    expect(close).toBeGreaterThan(80);
    expect(far).toBeLessThan(close - 30);
    expect(chrF('zzzz qqqq', ref)).toBeLessThan(5);
  });

  it('counts recall double: dropping words hurts more than adding one', () => {
    const ref = 'Grace to you and peace from God our Father.';
    expect(chrF('Grace to you.', ref)).toBeLessThan(chrF('Grace to you and peace from God our heavenly Father.', ref));
  });

  it('handles empty and very short text', () => {
    expect(chrF('', '')).toBe(100);
    expect(chrF('', 'text')).toBe(0);
    expect(chrF('text', '')).toBe(0);
    expect(chrF('a', 'a')).toBe(100);
    expect(chrF('a', 'b')).toBe(0);
  });
});

describe('exactMatch', () => {
  it('ignores case, punctuation, accents and spacing', () => {
    expect(normalizeForExact('  The  LORD, be with you!  ')).toBe('the lord be with you');
    expect(exactMatch('Hebreeën 12:1', 'hebreeen 12 1')).toBe(true);
    expect(exactMatch('The Lord be with you.', 'The Lord be with you all.')).toBe(false);
  });
});

describe('summarize', () => {
  it('gives mean, median and p95', () => {
    const s = summarize([1, 2, 3, 4, 100]);
    expect(s.mean).toBe(22);
    expect(s.median).toBe(3);
    expect(s.p95).toBe(100);
    expect(summarize([7])).toEqual({ mean: 7, median: 7, p95: 7 });
    expect(summarize([])).toEqual({ mean: 0, median: 0, p95: 0 });
  });
});

describe('parseRunSpec', () => {
  it('reads provider and optional model, splitting only at the first colon', () => {
    expect(parseRunSpec('openai')).toEqual({ provider: 'openai', model: undefined });
    expect(parseRunSpec('openai:gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(parseRunSpec('ollama:qwen2.5:14b')).toEqual({ provider: 'ollama', model: 'qwen2.5:14b' });
    expect(parseRunSpec('claude:')).toEqual({ provider: 'claude', model: undefined });
  });
  it('rejects an unknown provider', () => {
    expect(parseRunSpec('gemini')).toBeNull();
    expect(parseRunSpec('')).toBeNull();
  });
});
