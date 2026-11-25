import { describe, it, expect } from 'vitest';
import { locatePhrase, replacePhrase } from '../../client/src/lib/sermon/glossary-fix.js';

describe('replacePhrase', () => {
  it('replaces the phrase, ignoring case', () => {
    expect(replacePhrase('Ik lees je logie is belangrijk', 'ik lees je logie', 'ecclesiologie', 0)).toBe('ecclesiologie is belangrijk');
  });

  it('picks the occurrence nearest the highlight', () => {
    const text = 'logie en nog een logie daar';
    expect(replacePhrase(text, 'logie', 'X', 0)).toBe('X en nog een logie daar');
    expect(replacePhrase(text, 'logie', 'X', 17)).toBe('logie en nog een X daar');
  });

  it('follows a phrase narrower than the highlight and keeps the rest of the row', () => {
    expect(replacePhrase('Ik lees je logie is een woord', 'Ik lees je logie', 'ecclesiologie', 0)).toBe('ecclesiologie is een woord');
  });

  it('returns null when the phrase is gone or empty', () => {
    expect(replacePhrase('iets anders', 'logie', 'X', 0)).toBeNull();
    expect(locatePhrase('iets', '   ', 0)).toBe(-1);
  });
});
