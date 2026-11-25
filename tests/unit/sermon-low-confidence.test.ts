import { describe, it, expect, vi } from 'vitest';
import { parseUncertain, selectLowConfidenceWords } from '../../server/lib/low-confidence.js';
import { ConfidenceStore, findWordIndex } from '../../client/src/lib/sermon/confidence-store.js';
import { matchDoubts, scoreThresholds } from '../../scripts/lib/confidence-eval.js';

describe('parseUncertain — never trust the sidecar', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(parseUncertain([{ word: 'Kik', p: 0.3 }, { word: '', p: 0.1 }, { word: 'x', p: 2 }, { word: 5, p: 0.1 }, null, 'str', { word: 'ok', p: '0.2' }]))
      .toEqual([{ word: 'Kik', p: 0.3 }]);
    expect(parseUncertain(undefined)).toEqual([]);
    expect(parseUncertain('nope')).toEqual([]);
  });

  it('caps the list and the word length', () => {
    expect(parseUncertain(Array.from({ length: 500 }, (_, i) => ({ word: `w${i}`, p: 0.1 })))).toHaveLength(200);
    expect(parseUncertain([{ word: 'x'.repeat(61), p: 0.1 }])).toEqual([]);
  });
});

describe('selectLowConfidenceWords', () => {
  const u = (word: string, p: number) => ({ word, p });

  it('keeps only clearly doubtful, word-like words, most doubtful first', () => {
    // goed .39 ok; evengeven .1 ok; kik is too short; Kind .55 is not doubtful enough; drie3 has a digit
    expect(selectLowConfidenceWords([u('goed', 0.39), u('evengeven', 0.1), u('kik', 0.2), u('Kind', 0.55), u('drie3', 0.1)]))
      .toEqual(['evengeven', 'goed']);
  });

  it('lists a word once, whatever its case, and honours the cap', () => {
    expect(selectLowConfidenceWords([u('Kerkenraad', 0.3), u('kerkenraad', 0.2)])).toEqual(['kerkenraad']);
    const many = Array.from({ length: 20 }, (_, i) => u(`woord${String.fromCharCode(97 + i)}`, 0.1 + i / 100));
    expect(selectLowConfidenceWords(many)).toHaveLength(8);
    expect(selectLowConfidenceWords(many, { max: 3 })).toHaveLength(3);
  });

  it('takes its thresholds from the options and survives no data', () => {
    expect(selectLowConfidenceWords([u('goede', 0.5)], { below: 0.6 })).toEqual(['goede']);
    expect(selectLowConfidenceWords([u('goede', 0.5)])).toEqual([]);
    expect(selectLowConfidenceWords(undefined)).toEqual([]);
    expect(selectLowConfidenceWords([])).toEqual([]);
  });
});

describe('findWordIndex', () => {
  it('finds a whole word, ignoring case, and not a part of a longer one', () => {
    expect(findWordIndex('Het kikker en Kik zijn er.', 'kik')).toBe(14);
    expect(findWordIndex('kikker', 'kik')).toBe(-1);
    expect(findWordIndex('Hij zei: "Evengeven!"', 'evengeven')).toBe(10);
    expect(findWordIndex('niets', 'iets')).toBe(-1);
    expect(findWordIndex('tekst', '')).toBe(-1);
  });
});

describe('ConfidenceStore', () => {
  it('shows a flagged word wherever it still is in the text, as written there', () => {
    const s = new ConfidenceStore();
    s.add(['Kik', 'evengeven']);
    expect(s.flaggedIn('Kik is geboren, het Evengeven! en nog een kik.')).toEqual(['Kik', 'Evengeven']);
    expect(s.flaggedIn('Het kind is geboren.')).toEqual([]); // corrected -> the chip is gone
    expect(s.flaggedIn('')).toEqual([]);
  });

  it('ignores accents and punctuation when matching', () => {
    const s = new ConfidenceStore();
    s.add(['Hebreeën']);
    expect(s.flaggedIn('Lees Hebreeen 12.')).toEqual(['Hebreeen']);
  });

  it('can dismiss a word for good', () => {
    const s = new ConfidenceStore();
    s.add(['Kik']);
    s.dismiss('kik');
    expect(s.flaggedIn('Kik is geboren')).toEqual([]);
    expect(s.size).toBe(0);
  });

  it('notifies listeners only when something changed, and bumps its version', () => {
    const s = new ConfidenceStore();
    const listener = vi.fn();
    s.subscribe(listener);
    s.add(['Kik']);
    expect(listener).toHaveBeenCalledTimes(1);
    const v = s.getVersion();
    s.add(['kik', 'Kik']); // already known
    s.add(undefined);
    s.add([]);
    s.dismiss('onbekend');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(s.getVersion()).toBe(v);
  });

  it('forgets the oldest words beyond its cap, and caps the chips per cell', () => {
    const s = new ConfidenceStore();
    s.add(Array.from({ length: 200 }, (_, i) => `woord${i}x`));
    expect(s.size).toBe(150);
    expect(s.flaggedIn('woord0x')).toEqual([]);
    expect(s.flaggedIn('woord199x')).toEqual(['woord199x']);
    expect(s.flaggedIn(Array.from({ length: 20 }, (_, i) => `woord${100 + i}x`).join(' '))).toHaveLength(6);
  });

  it('clear() empties it', () => {
    const s = new ConfidenceStore();
    s.add(['Kik']);
    s.clear();
    expect(s.size).toBe(0);
  });
});

describe('confidence calibration core', () => {
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '');

  it('pairs doubted words with their place in the text and whether they were edited', () => {
    const tokens = ['het', 'kik', 'is', 'geboren', 'kik'];
    const edited = [false, true, false, false, false];
    const recs = matchDoubts([{ word: 'Kik', p: 0.2 }, { word: 'Kik', p: 0.3 }, { word: 'weg', p: 0.1 }], tokens, edited, norm);
    // the first Kik claims token 1 (edited), the second claims token 4 (not); "weg" is not in the text
    expect(recs).toEqual([{ word: 'Kik', p: 0.2, edited: true }, { word: 'Kik', p: 0.3, edited: false }]);
    expect(matchDoubts(undefined, tokens, edited, norm)).toEqual([]);
  });

  it('scores precision, recall and lift per threshold', () => {
    const recs = [
      { word: 'evengeven', p: 0.1, edited: true },
      { word: 'betlehem', p: 0.3, edited: true },
      { word: 'gewone', p: 0.35, edited: false },
      { word: 'woorden', p: 0.5, edited: false },
      { word: 'kik', p: 0.1, edited: true }, // too short: never flagged
    ];
    // 100 words in the text, 10 of them edited -> a random word is edited 10% of the time
    const [t3, t4, t6] = scoreThresholds(recs, 10, 100, [0.3, 0.4, 0.6]);
    expect(t3).toMatchObject({ flagged: 1, hits: 1, precision: 1, recall: 0.1 });
    expect(t3.lift).toBeCloseTo(10);
    expect(t4).toMatchObject({ flagged: 3, hits: 2 });
    expect(t4.precision).toBeCloseTo(2 / 3);
    expect(t4.recall).toBeCloseTo(0.2);
    expect(t6).toMatchObject({ flagged: 4, hits: 2, precision: 0.5 });
    expect(t6.f1).toBeGreaterThan(0);
  });

  it('is all zeros, not NaN, with nothing flagged or nothing edited', () => {
    expect(scoreThresholds([], 0, 0, [0.4])[0]).toEqual({ below: 0.4, flagged: 0, hits: 0, precision: 0, recall: 0, lift: 0, f1: 0 });
  });
});
