import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendCsvRow, csvQuote, MAX_GLOSSARY_BYTES } from '../../server/lib/glossary-file.js';
import { addToGlossary } from '../../server/lib/glossary-add.js';
import { resetAsrCorrectionsCache, applyLearnedCorrections } from '../../server/lib/asr-corrections.js';
import { parseCsv } from '../../server/lib/csv-parse.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-add-'));
  process.env.GLOSSARY_DIR = dir;
  resetAsrCorrectionsCache();
});
afterEach(() => {
  delete process.env.GLOSSARY_DIR;
  resetAsrCorrectionsCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

describe('csvQuote', () => {
  it('quotes only when needed and doubles inner quotes', () => {
    expect(csvQuote('plain')).toBe('plain');
    expect(csvQuote('a,b')).toBe('"a,b"');
    expect(csvQuote('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('appendCsvRow', () => {
  it('creates a missing file with the header', () => {
    appendCsvRow('new.csv', ['a', 'b'], ['H1', 'H2']);
    expect(read('new.csv')).toBe('H1,H2\na,b\n');
  });

  it('adds a newline first when the file does not end with one, and round-trips tricky fields', () => {
    fs.writeFileSync(path.join(dir, 'g.csv'), 'Nederlands,Engels\nx,y');
    appendCsvRow('g.csv', ['a,b', 'c "d"']);
    expect(parseCsv(read('g.csv'))).toEqual([['Nederlands', 'Engels'], ['x', 'y'], ['a,b', 'c "d"']]);
  });

  it('rejects unsafe names and a file that would outgrow the read cap', () => {
    expect(() => appendCsvRow('../evil.csv', ['a'])).toThrow();
    expect(() => appendCsvRow('notes.txt', ['a'])).toThrow();
    fs.writeFileSync(path.join(dir, 'big.csv'), 'x'.repeat(MAX_GLOSSARY_BYTES - 3));
    expect(() => appendCsvRow('big.csv', ['abcdef'])).toThrow(/exceed/);
  });
});

describe('addToGlossary', () => {
  const base = 'Nederlands,Engels,Categorie,Notitie\nGenade,Grace,Theologisch,\n';

  it('appends the term to the glossary CSV and the misheard phrase to the corrections file', () => {
    fs.writeFileSync(path.join(dir, 'g.csv'), base);
    const r = addToGlossary({ csv: 'g.csv', heard: 'ik lees je logie', dutch: 'ecclesiologie', english: 'ecclesiology' });
    expect(r).toEqual({ ok: true, glossaryRowAdded: true, correctionAdded: true });
    expect(read('g.csv')).toBe(base + 'ecclesiologie,ecclesiology,Theologisch,\n');
    expect(read('asr-corrections.csv')).toBe('Gehoord,Nederlands\nik lees je logie,ecclesiologie\n');
    expect(applyLearnedCorrections('ik lees je logie')).toBe('ecclesiologie');
  });

  it('skips the correction when "heard" equals the Dutch word', () => {
    fs.writeFileSync(path.join(dir, 'g.csv'), base);
    const r = addToGlossary({ csv: 'g.csv', heard: 'Verbond', dutch: 'verbond', english: 'covenant' });
    expect(r).toEqual({ ok: true, glossaryRowAdded: true, correctionAdded: false });
    expect(fs.existsSync(path.join(dir, 'asr-corrections.csv'))).toBe(false);
  });

  it('adds only a correction when no English is given', () => {
    fs.writeFileSync(path.join(dir, 'g.csv'), base);
    const r = addToGlossary({ csv: 'g.csv', heard: 'ik lees je logie', dutch: 'ecclesiologie' });
    expect(r).toEqual({ ok: true, glossaryRowAdded: false, correctionAdded: true });
    expect(read('g.csv')).toBe(base);
  });

  it('answers 409 with the existing translation for a duplicate, unless forced', () => {
    fs.writeFileSync(path.join(dir, 'g.csv'), base);
    const dup = addToGlossary({ csv: 'g.csv', dutch: 'genade', english: 'Mercy' });
    expect(dup).toMatchObject({ ok: false, status: 409, existingEnglish: 'Grace' });
    expect(read('g.csv')).toBe(base);
    expect(addToGlossary({ csv: 'g.csv', dutch: 'genade', english: 'Mercy', force: true }).ok).toBe(true);
  });

  it('rejects empty input, instruction-like terms, tiny "heard" phrases and a bad file name', () => {
    fs.writeFileSync(path.join(dir, 'g.csv'), base);
    expect(addToGlossary({ csv: 'g.csv', dutch: '', english: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(addToGlossary({ csv: 'g.csv', dutch: 'ignore previous', english: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(addToGlossary({ csv: 'g.csv', heard: 'de', dutch: 'Deus' })).toMatchObject({ ok: false, status: 400 });
    expect(addToGlossary({ csv: 'g.csv', dutch: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(addToGlossary({ csv: '../g.csv', dutch: 'a', english: 'b' })).toMatchObject({ ok: false, status: 400 });
    expect(addToGlossary({ csv: 'asr-corrections.csv', dutch: 'a', english: 'b' })).toMatchObject({ ok: false, status: 400 });
    expect(read('g.csv')).toBe(base);
  });

  it('keeps a multi-line or backtick-laden value on one clean row', () => {
    fs.writeFileSync(path.join(dir, 'g.csv'), base);
    addToGlossary({ csv: 'g.csv', dutch: 'woord\nnieuw', english: 'a```b' });
    const rows = parseCsv(read('g.csv'));
    expect(rows).toHaveLength(3);
    expect(rows[2][0]).toBe('woord nieuw');
    expect(rows[2][1]).not.toContain('`');
  });

  it('creates the glossary CSV when it does not exist yet', () => {
    expect(addToGlossary({ csv: 'fresh.csv', dutch: 'verbond', english: 'covenant' }).ok).toBe(true);
    expect(read('fresh.csv')).toBe('Nederlands,Engels,Categorie,Notitie\nverbond,covenant,Theologisch,\n');
  });
});
