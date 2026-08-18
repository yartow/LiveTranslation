import { describe, it, expect } from 'vitest';
import { similarity } from '../../server/lib/text-similarity.js';

describe('similarity', () => {
  it('is 1 for identical text', () => {
    expect(similarity('Want alzo lief heeft God de wereld gehad', 'Want alzo lief heeft God de wereld gehad')).toBe(1);
  });

  it('is 0 for completely unrelated text', () => {
    expect(similarity('Want alzo lief heeft God de wereld gehad', 'De kat zat op de mat vandaag')).toBe(0);
  });

  it('is high for text that differs only in punctuation/case', () => {
    const a = 'Want alzo lief heeft God de wereld gehad, dat Hij Zijn Zoon gaf.';
    const b = 'want alzo lief heeft god de wereld gehad dat hij zijn zoon gaf';
    expect(similarity(a, b)).toBeGreaterThan(0.95);
  });

  it('is high for text that differs only by diacritics', () => {
    expect(similarity('Hebreeën negen vers een', 'Hebreeen negen vers een')).toBeGreaterThan(0.95);
  });

  it('is symmetric', () => {
    const a = 'Genade zij u en vrede van God onze Vader';
    const b = 'Vrede en genade zij met u van onze Vader God';
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 10);
  });

  it('is 0 when either input is empty', () => {
    expect(similarity('', 'Iets')).toBe(0);
    expect(similarity('Iets', '')).toBe(0);
    expect(similarity('', '')).toBe(0);
  });

  it('drops noticeably for a paraphrase of the same idea', () => {
    const verse = 'Want alzo lief heeft God de wereld gehad, dat Hij Zijn eniggeboren Zoon gegeven heeft';
    const paraphrase = 'God hield zoveel van de mensen dat Hij Zijn eigen Zoon aan ons gaf';
    const exact = similarity(verse, verse);
    const paraphrased = similarity(verse, paraphrase);
    expect(paraphrased).toBeLessThan(exact);
    expect(paraphrased).toBeLessThan(0.5);
  });
});
