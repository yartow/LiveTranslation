import { describe, it, expect } from 'vitest';
import { countAsrArtifacts, dutchNumberWords, normalizeForScoring, parseAliases, computeWER } from '../lib/wer';

describe('countAsrArtifacts', () => {
  it('counts leftover caption hallucinations', () => {
    expect(countAsrArtifacts('Goedemorgen allemaal')).toBe(0);
    expect(countAsrArtifacts('[Muziek] Goedemorgen. Muziek. ♪')).toBe(3); // [Muziek] counts once
    expect(countAsrArtifacts('TV Gelderland 2021')).toBe(1);
  });
});

describe('dutchNumberWords', () => {
  it.each([
    [0, 'nul'], [5, 'vijf'], [12, 'twaalf'], [19, 'negentien'], [20, 'twintig'],
    [21, 'eenentwintig'], [22, 'tweeëntwintig'], [23, 'drieëntwintig'], [34, 'vierendertig'],
    [99, 'negenennegentig'], [100, 'honderd'], [101, 'honderdeen'], [120, 'honderdtwintig'],
    [200, 'tweehonderd'], [316, 'driehonderdzestien'], [999, 'negenhonderdnegenennegentig'],
  ])('%i -> %s', (n, words) => {
    expect(dutchNumberWords(n)).toBe(words);
  });

  it('rejects out-of-range numbers', () => {
    expect(() => dutchNumberWords(1000)).toThrow(RangeError);
    expect(() => dutchNumberWords(-1)).toThrow(RangeError);
  });
});

describe('normalizeForScoring', () => {
  it('treats digits and spelled-out numbers as equal', () => {
    expect(normalizeForScoring('vers 5 tot 11')).toBe(normalizeForScoring('vers vijf tot elf'));
    expect(normalizeForScoring('Filippenzen 2')).toBe(normalizeForScoring('Filippenzen twee'));
  });

  it('does not fuse a verse reference into one number', () => {
    expect(normalizeForScoring('Johannes 3:16')).toBe('johannes drie zestien');
  });

  it('leaves long numbers alone', () => {
    expect(normalizeForScoring('in 2021')).toBe('in 2021');
  });

  it('ignores diacritics, apostrophes, hyphens and fillers', () => {
    expect(normalizeForScoring("tweeëntwintig d'r")).toBe(normalizeForScoring('tweeentwintig dr'));
    expect(normalizeForScoring('ehm de Heer, eh, is goed')).toBe('de heer is goed');
    expect(normalizeForScoring('Jezus-Christus')).toBe('jezus christus');
  });

  it('applies aliases to both sides, including multi-word ones', () => {
    const aliases = parseAliases('goeie = goede\nd\'r voor = ervoor  # colloquial\n');
    expect(normalizeForScoring('met al je goeie voornemens', aliases)).toBe(normalizeForScoring('met al je goede voornemens', aliases));
    expect(normalizeForScoring("ik heb d'r voor gebeden", aliases)).toBe('ik heb ervoor gebeden');
  });

  it('does not alias inside a longer word', () => {
    const aliases = parseAliases('eh = er');
    expect(normalizeForScoring('geheel', aliases)).toBe('geheel');
  });

  it('does not hide a genuine error', () => {
    expect(computeWER(normalizeForScoring('wij lezen uit Filippenzen'), normalizeForScoring('wij lezen uit Filippense'))).toBeGreaterThan(0);
  });
});

describe('parseAliases', () => {
  it('ignores comments, blanks and malformed lines, longest variant first', () => {
    const pairs = parseAliases('# header\n\na b = ab\nx = y\nnonsense\n= z\n');
    expect(pairs).toEqual([['a b', 'ab'], ['x', 'y']]);
  });
});
