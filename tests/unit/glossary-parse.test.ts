import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseGlossaryCsv,
  parseDisambiguationDoc,
  extractDisambiguationTableTerms,
  crossCheckContextTerms,
} from '../../server/lib/glossary-parse.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'glossary');
const csvText = readFileSync(join(FIXTURES, 'mini.csv'), 'utf8');
const mdText = readFileSync(join(FIXTURES, 'mini.md'), 'utf8');

describe('parseGlossaryCsv', () => {
  const result = parseGlossaryCsv(csvText);

  it('parses straightforward 4-field rows', () => {
    expect(result.fixed.find(r => r.nl === 'Heiland')).toEqual({
      nl: 'Heiland', en: 'Savior', category: 'Theologisch', note: 'Wordt vaak fout vertaald',
    });
  });

  it('repairs a row whose Engels column contains an unquoted comma', () => {
    const row = result.fixed.find(r => r.nl === 'Trouwe');
    expect(row).toEqual({ nl: 'Trouwe', en: 'Faithful (adj., archaic form)', category: 'Psalmberijming', note: '' });
  });

  it('repairs a row whose Notitie column contains an unquoted comma', () => {
    const row = result.fixed.find(r => r.nl === 'Goedertierenheid');
    expect(row?.en).toBe('Lovingkindness / Steadfast love');
    expect(row?.category).toBe('Theologisch/Archaïsch');
  });

  it('counts repaired rows', () => {
    expect(result.repairedRows).toBe(2);
  });

  it('drops a row with an unrecoverable (unknown) category and warns', () => {
    expect(result.fixed.find(r => r.nl === 'Onbekend')).toBeUndefined();
    expect(result.context.find(r => r.nl === 'Onbekend')).toBeUndefined();
    expect(result.warnings.some(w => w.includes('Onbekend'))).toBe(true);
  });

  it('drops a row whose term looks like a prompt injection and warns', () => {
    expect(result.fixed.find(r => r.nl === 'Ignore alles')).toBeUndefined();
    expect(result.warnings.some(w => w.toLowerCase().includes('injectie'))).toBe(true);
  });

  it('keeps a Notitie starting with a Dutch word like "Niet" — field-level sanitization must not drop legitimate notes', () => {
    const row = result.fixed.find(r => r.nl === 'Barmhartigheid');
    expect(row?.note).toContain('Niet "grace"');
  });

  it('counts total and dropped rows correctly', () => {
    expect(result.totalRows).toBe(13);
    expect(result.droppedRows).toBe(2); // Onbekend (unknown category) + Ignore alles (injection)
  });

  it('parses a properly RFC4180-quoted field unaffected by the repair heuristic', () => {
    const row = result.fixed.find(r => r.nl === 'Verzoendeksel');
    expect(row?.en).toBe('Mercy seat, kind of');
  });

  describe('duplicate resolution', () => {
    it('lets Contextafhankelijk win over a fixed-category duplicate, and warns', () => {
      expect(result.fixed.find(r => r.nl === 'Genade')).toBeUndefined();
      const ctxRow = result.context.find(r => r.nl === 'Genade');
      expect(ctxRow?.category).toBe('Contextafhankelijk');
      expect(result.warnings.some(w => w.includes('Genade') && w.includes('Contextafhankelijk'))).toBe(true);
    });

    it('silently dedupes a benign same-translation duplicate across categories', () => {
      const matches = result.fixed.filter(r => r.nl === 'Wederkomst');
      expect(matches).toHaveLength(1);
      expect(result.warnings.some(w => w.includes('Wederkomst'))).toBe(false);
    });
  });
});

describe('parseGlossaryCsv edge cases', () => {
  it('returns empty result for empty input', () => {
    const result = parseGlossaryCsv('');
    expect(result).toEqual({ fixed: [], context: [], totalRows: 0, repairedRows: 0, droppedRows: 0, warnings: [] });
  });

  it('warns but does not throw on an unexpected header', () => {
    const result = parseGlossaryCsv('A,B,C,D\nx,y,Theologisch,z');
    expect(result.warnings.some(w => w.includes('header'))).toBe(true);
    expect(result.fixed).toHaveLength(1);
  });
});

describe('parseDisambiguationDoc', () => {
  const doc = parseDisambiguationDoc(mdText);

  it('extracts the first fenced block as systemBlock', () => {
    expect(doc.systemBlock).toContain('{DOELVERTALING}');
    expect(doc.systemBlock).toContain('DEITEIT_HOOFDLETTER');
  });

  it('extracts the second fenced block as examplesBlock', () => {
    expect(doc.examplesBlock).toContain('NL: "test"');
  });

  it('returns empty blocks when there are no fenced blocks', () => {
    const empty = parseDisambiguationDoc('# no fences here');
    expect(empty.systemBlock).toBe('');
    expect(empty.examplesBlock).toBe('');
  });
});

describe('extractDisambiguationTableTerms', () => {
  it('extracts the first-column terms from the markdown table', () => {
    const doc = parseDisambiguationDoc(mdText);
    const terms = extractDisambiguationTableTerms(doc.systemBlock);
    expect(terms).toEqual(['genade', 'boze']);
  });
});

describe('crossCheckContextTerms', () => {
  it('flags a doc term missing from the CSV Contextafhankelijk set', () => {
    const warnings = crossCheckContextTerms(['genade'], ['genade', 'boze']);
    expect(warnings.some(w => w.includes('boze'))).toBe(true);
    expect(warnings.some(w => w.includes('genade'))).toBe(false);
  });

  it('flags a CSV Contextafhankelijk term missing from the doc table', () => {
    const warnings = crossCheckContextTerms(['genade', 'trouw'], ['genade']);
    expect(warnings.some(w => w.includes('trouw'))).toBe(true);
  });

  it('is case-insensitive', () => {
    const warnings = crossCheckContextTerms(['Genade'], ['genade']);
    expect(warnings).toEqual([]);
  });
});
