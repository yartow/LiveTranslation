import { describe, it, expect, vi } from 'vitest';
import { looksTruncated, wavDurationSecs, transcribeGuarded } from '../../server/lib/whisper-guard.js';

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('looksTruncated', () => {
  it('flags the observed echo: 5 words for 7.9 s of Scripture', () => {
    expect(looksTruncated('Filippenzen 2, vers 5 tot 11.', 7.9)).toBe(true);
  });
  it('accepts normal speech rates', () => {
    expect(looksTruncated(words(20), 7.9)).toBe(false);
    expect(looksTruncated(words(12), 10)).toBe(false);
  });
  it('never fires on short chunks (a single word is legitimate)', () => {
    expect(looksTruncated('Amen.', 3)).toBe(false);
    expect(looksTruncated('', 4.9)).toBe(false);
  });
  it('treats an empty transcript of a long chunk as truncated', () => {
    expect(looksTruncated('', 8)).toBe(true);
  });
  it('ignores non-finite durations', () => {
    expect(looksTruncated('a', NaN)).toBe(false);
    expect(looksTruncated('a', Infinity)).toBe(false);
  });
});

describe('wavDurationSecs', () => {
  it('computes seconds for 16 kHz mono 16-bit PCM', () => {
    expect(wavDurationSecs(44 + 32_000 * 8)).toBeCloseTo(8, 5);
    expect(wavDurationSecs(10)).toBe(0);
  });
});

describe('transcribeGuarded', () => {
  it('retries without the prompt and keeps the fuller transcript', async () => {
    const run = vi.fn(async (usePrompt: boolean) => (usePrompt ? 'Filippenzen 2, vers 5 tot 11.' : words(22)));
    const r = await transcribeGuarded(run, true, 7.9);
    expect(r).toEqual({ text: words(22), retried: true });
    expect(run.mock.calls.map(c => c[0])).toEqual([true, false]);
  });

  it('keeps the first result when the retry is not better', async () => {
    const run = vi.fn(async (usePrompt: boolean) => (usePrompt ? words(4) : words(2)));
    expect((await transcribeGuarded(run, true, 8)).text).toBe(words(4));
  });

  it('does not retry a healthy transcript', async () => {
    const run = vi.fn(async () => words(25));
    const r = await transcribeGuarded(run, true, 8);
    expect(r.retried).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not retry when no prompt was used (nothing to blame)', async () => {
    const run = vi.fn(async () => '');
    const r = await transcribeGuarded(run, false, 8);
    expect(r.retried).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('survives a failing retry', async () => {
    const run = vi.fn(async (usePrompt: boolean) => { if (!usePrompt) throw new Error('boom'); return words(3); });
    const r = await transcribeGuarded(run, true, 8);
    expect(r).toEqual({ text: words(3), retried: true });
  });
});
