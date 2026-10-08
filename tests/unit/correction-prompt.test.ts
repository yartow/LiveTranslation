import { describe, it, expect } from 'vitest';
import { guardCorrection, homophoneExamples, NO_ANNOTATIONS_RULE } from '../../server/lib/correction-prompt.js';

describe('guardCorrection', () => {
  it('accepts a normal correction', () => {
    expect(guardCorrection('de heer is mijn herder', 'De Heer is mijn Herder')).toBe('De Heer is mijn Herder');
  });

  it('accepts a correction that is shorter (fillers removed)', () => {
    expect(guardCorrection('eh de heer eh is mijn herder', 'De Heer is mijn Herder')).toBe('De Heer is mijn Herder');
  });

  it('falls back to the raw text when the model invents a long continuation', () => {
    const raw = 'amen';
    const invented = 'Amen. Laten we samen bidden voor alle mensen die hier vandaag aanwezig zijn en dank u wel.';
    expect(guardCorrection(raw, invented)).toBe(raw);
  });

  it('falls back to the raw text on empty / missing output', () => {
    expect(guardCorrection('hallo', '')).toBe('hallo');
    expect(guardCorrection('hallo', undefined)).toBe('hallo');
    expect(guardCorrection('hallo', '   ')).toBe('hallo');
  });

  it('tolerates modest growth from added punctuation', () => {
    expect(guardCorrection('ja', 'Ja.')).toBe('Ja.');
  });
});

describe('homophoneExamples', () => {
  it('gives Dutch examples for Dutch, not English ones', () => {
    expect(homophoneExamples('nl')).toContain('wordt/word');
    expect(homophoneExamples('nl')).not.toContain('pray/prey');
  });

  it('handles region tags and falls back to English', () => {
    expect(homophoneExamples('nl-NL')).toContain('wordt/word');
    expect(homophoneExamples(undefined)).toContain('pray/prey');
    expect(homophoneExamples('ko')).toContain('pray/prey');
  });
});

describe('NO_ANNOTATIONS_RULE', () => {
  it('tells the model to drop caption annotations', () => {
    expect(NO_ANNOTATIONS_RULE).toMatch(/\[Muziek\]/);
  });
});
