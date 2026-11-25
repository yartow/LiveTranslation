import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRules, applyAsrCorrections, normalizePhrase, effectiveGlossary,
  applyLearnedCorrections, resetAsrCorrectionsCache,
} from '../../server/lib/asr-corrections.js';

const rules = (pairs: Array<[string, string]>) => buildRules(pairs.map(([heard, correct]) => ({ heard, correct })));

describe('applyAsrCorrections', () => {
  it('replaces a misheard phrase with the correct term', () => {
    const r = rules([['ik lees je logie', 'ecclesiologie']]);
    expect(applyAsrCorrections('Dat is ik lees je logie genoemd.', r)).toBe('Dat is ecclesiologie genoemd.');
  });

  it('ignores case, spacing and punctuation inside the phrase', () => {
    const r = rules([['ik lees je logie', 'ecclesiologie']]);
    expect(applyAsrCorrections('over ik  lees, je-logie gesproken', r)).toBe('over ecclesiologie gesproken');
  });

  it('capitalises the replacement when the match started a sentence', () => {
    const r = rules([['ik lees je logie', 'ecclesiologie']]);
    expect(applyAsrCorrections('Ik lees je logie is belangrijk.', r)).toBe('Ecclesiologie is belangrijk.');
  });

  it('only matches whole words', () => {
    const r = rules([['je logie', 'ecclesiologie']]);
    expect(applyAsrCorrections('mijn je logies', r)).toBe('mijn je logies');
    expect(applyAsrCorrections('xje logie', r)).toBe('xje logie');
  });

  it('handles accented letters as word characters', () => {
    const r = rules([['heiland', 'Heiland']]);
    expect(applyAsrCorrections('de heilandé', r)).toBe('de heilandé');
    expect(applyAsrCorrections('onze heiland', r)).toBe('onze Heiland');
  });

  it('applies the longest phrase first', () => {
    const r = rules([['je logie', 'LOGIE'], ['ik lees je logie', 'ecclesiologie']]);
    expect(applyAsrCorrections('ik lees je logie', r)).toBe('ecclesiologie');
  });

  it('replaces every occurrence, including adjacent ones', () => {
    const r = rules([['logie', 'ecclesiologie']]);
    expect(applyAsrCorrections('logie en logie', r)).toBe('ecclesiologie en ecclesiologie');
  });

  it('lets a later row override an earlier one for the same phrase', () => {
    const r = rules([['ik lees je logie', 'fout'], ['Ik lees je logie', 'ecclesiologie']]);
    expect(r).toHaveLength(1);
    expect(applyAsrCorrections('ik lees je logie', r)).toBe('ecclesiologie');
  });

  it('is a no-op without rules or text', () => {
    expect(applyAsrCorrections('hallo', [])).toBe('hallo');
    expect(applyAsrCorrections('', rules([['a b', 'c']]))).toBe('');
  });

  it('does not treat regex characters in a phrase as syntax', () => {
    const r = rules([['a.b (c)', 'X']]);
    expect(applyAsrCorrections('zie a b c nu', r)).toBe('zie X nu');
    expect(applyAsrCorrections('zie axb c nu', r)).toBe('zie axb c nu');
  });
});

describe('normalizePhrase', () => {
  it('compares phrases ignoring case and punctuation', () => {
    expect(normalizePhrase('Ik lees, je-logie!')).toBe('ik lees je logie');
  });
});

describe('learned corrections from asr-corrections.csv', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-corr-'));
    process.env.GLOSSARY_DIR = dir;
    resetAsrCorrectionsCache();
  });
  afterEach(() => {
    delete process.env.GLOSSARY_DIR;
    resetAsrCorrectionsCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing when the file does not exist', () => {
    expect(applyLearnedCorrections('ik lees je logie')).toBe('ik lees je logie');
    expect(effectiveGlossary('a\nb')).toBe('a\nb');
  });

  it('loads rules from the file (header skipped) and puts learned terms first in the glossary', () => {
    fs.writeFileSync(path.join(dir, 'asr-corrections.csv'), 'Gehoord,Nederlands\nik lees je logie,ecclesiologie\n');
    expect(applyLearnedCorrections('over ik lees je logie')).toBe('over ecclesiologie');
    expect(effectiveGlossary('verbond\necclesiologie = ecclesiology')).toBe('ecclesiologie\nverbond');
  });

  it('keeps the first priority lines (today\'s service) ahead of the learned terms', () => {
    fs.writeFileSync(path.join(dir, 'asr-corrections.csv'), 'Gehoord,Nederlands\nik lees je logie,ecclesiologie\n');
    expect(effectiveGlossary('Titel\nReinier\nverbond', 2)).toBe('Titel\nReinier\necclesiologie\nverbond');
    expect(effectiveGlossary('Titel\nverbond', 0)).toBe('ecclesiologie\nTitel\nverbond');
    expect(effectiveGlossary('ecclesiologie\nverbond', 1)).toBe('ecclesiologie\nverbond'); // a priority line is not repeated
  });

  it('picks up an edited file (cache is keyed on mtime)', () => {
    const file = path.join(dir, 'asr-corrections.csv');
    fs.writeFileSync(file, 'Gehoord,Nederlands\nfoo bar,Baz\n');
    expect(applyLearnedCorrections('foo bar')).toBe('Baz');
    fs.writeFileSync(file, 'Gehoord,Nederlands\nfoo bar,Qux\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(applyLearnedCorrections('foo bar')).toBe('Qux');
  });
});
