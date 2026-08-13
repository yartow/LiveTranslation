import { describe, it, expect } from 'vitest';
import { buildCheckIndex, checkGlossaryAdherence } from '../../server/lib/glossary-check.js';
import type { GlossaryRow } from '../../server/lib/glossary-parse.js';

function row(nl: string, en: string, category = 'Theologisch'): GlossaryRow {
  return { nl, en, category, note: '' };
}

describe('buildCheckIndex', () => {
  it('excludes terms shorter than 5 characters', () => {
    const index = buildCheckIndex([row('Job', 'Job'), row('Heiland', 'Savior')], new Set());
    expect(index.expectedByTerm.has('job')).toBe(false);
    expect(index.expectedByTerm.has('heiland')).toBe(true);
  });

  it('excludes glossary rows with " / " alternatives — no single expected answer', () => {
    const index = buildCheckIndex([row('Genade', 'Grace / Mercy')], new Set());
    expect(index.expectedByTerm.size).toBe(0);
    expect(index.pattern).toBeNull();
  });

  it('excludes context-dependent terms defensively', () => {
    const index = buildCheckIndex([row('Genade', 'Grace', 'Contextafhankelijk')], new Set(['genade']));
    expect(index.expectedByTerm.size).toBe(0);
  });

  it('strips a parenthetical from the expected translation', () => {
    const index = buildCheckIndex([row('Rijk Gods', 'Kingdom (of God)')], new Set());
    expect(index.expectedByTerm.get('rijk gods')).toBe('Kingdom');
  });
});

describe('checkGlossaryAdherence', () => {
  const index = buildCheckIndex([row('Heiland', 'Savior'), row('Verlosser', 'Redeemer')], new Set());

  it('returns no warning when the expected translation is present', () => {
    expect(checkGlossaryAdherence('Hij is de Heiland.', 'He is the Savior.', index)).toEqual([]);
  });

  it('returns a warning when the expected translation is absent', () => {
    expect(checkGlossaryAdherence('Hij is de Heiland.', 'He is the Redeemer.', index))
      .toEqual([{ term: 'Heiland', expected: 'Savior' }]);
  });

  it('is case-insensitive on both source and translation', () => {
    expect(checkGlossaryAdherence('hij is de HEILAND.', 'he is the savior.', index)).toEqual([]);
  });

  it('excludes a 4-character term (below the 5-char minimum)', () => {
    const idx = buildCheckIndex([row('Eer', 'Honor'), row('Amos', 'Amos')], new Set());
    expect(idx.expectedByTerm.size).toBe(0);
  });

  it('does not match a term embedded inside a longer word', () => {
    const idx = buildCheckIndex([row('Heiland', 'Savior')], new Set());
    // "Heilanden" contains "Heiland" as a substring but is a different word
    expect(checkGlossaryAdherence('De Heilanden bestaan niet.', 'Saviors do not exist.', idx)).toEqual([]);
  });

  it('returns no warnings when the pattern is null (no eligible terms)', () => {
    const empty = buildCheckIndex([], new Set());
    expect(checkGlossaryAdherence('Heiland', 'anything', empty)).toEqual([]);
  });

  it('caps the number of warnings at max', () => {
    const many = buildCheckIndex(
      [row('Heiland', 'Savior'), row('Verlosser', 'Redeemer'), row('Middelaar', 'Mediator'), row('Voorzienigheid', 'Providence')],
      new Set(),
    );
    const source = 'Heiland Verlosser Middelaar Voorzienigheid.';
    const warnings = checkGlossaryAdherence(source, 'no glossary hits at all here', many, 2);
    expect(warnings).toHaveLength(2);
  });

  it('deduplicates repeated occurrences of the same term in one source', () => {
    const warnings = checkGlossaryAdherence('Heiland, Heiland, Heiland.', 'nothing matches', index);
    expect(warnings).toEqual([{ term: 'Heiland', expected: 'Savior' }]);
  });
});
