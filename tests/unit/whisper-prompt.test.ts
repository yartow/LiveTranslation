import { describe, it, expect } from 'vitest';
import { buildWhisperPrompt } from '../../server/lib/openai.js';

describe('buildWhisperPrompt', () => {
  it('returns undefined when there is nothing to say', () => {
    expect(buildWhisperPrompt()).toBeUndefined();
    expect(buildWhisperPrompt('  ', '  ', '  ', 'nl')).toBeUndefined();
  });

  it('never emits a bare "Terms:" keyword list', () => {
    const p = buildWhisperPrompt('Heidelbergse Catechismus\nGenade', undefined, undefined, 'nl')!;
    expect(p).not.toMatch(/Terms:/i);
    expect(p).toContain('Heidelbergse Catechismus, Genade');
    expect(p).toMatch(/preek/); // phrased in the spoken language
  });

  it('puts the previous transcript LAST, right before the audio', () => {
    const p = buildWhisperPrompt('Genade', undefined, 'En zo komen wij tot het einde van dit hoofdstuk.', 'nl')!;
    expect(p.endsWith('En zo komen wij tot het einde van dit hoofdstuk.')).toBe(true);
    expect(p.indexOf('Genade')).toBeLessThan(p.indexOf('En zo komen'));
  });

  it('uses only the term before "=" from glossary lines', () => {
    const p = buildWhisperPrompt('grace = genade', undefined, undefined, 'en')!;
    expect(p).toContain('grace');
    expect(p).not.toContain('genade');
  });

  it('keeps the prompt within the length budget, trimming the glossary before the previous text', () => {
    const glossary = Array.from({ length: 40 }, (_, i) => `begrip-nummer-${i}`).join('\n');
    const prev = 'woord '.repeat(80).trim();
    const p = buildWhisperPrompt(glossary, 'Preek over Romeinen', prev, 'nl')!;
    expect(p.length).toBeLessThanOrEqual(500);
    expect(p.endsWith('woord')).toBe(true);
  });

  it('cuts the previous transcript at a word boundary', () => {
    const prev = 'a'.repeat(50) + ' ' + 'bcdef '.repeat(60).trim();
    const p = buildWhisperPrompt(undefined, undefined, prev, 'nl')!;
    expect(p.split(' ').every(w => w === 'bcdef')).toBe(true);
  });
});
