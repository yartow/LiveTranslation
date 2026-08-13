import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import {
  getDutchVerse, getEnglishVerse, getDutchVerseRange, getEnglishVerseRange, _resetBibleStoreForTests,
} from '../../server/lib/bible-store.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'bible');

describe('bible-store', () => {
  beforeEach(() => {
    process.env.BIBLE_DIR = FIXTURE_DIR;
    _resetBibleStoreForTests();
  });
  afterEach(() => {
    delete process.env.BIBLE_DIR;
    _resetBibleStoreForTests();
  });

  it('reads a single Dutch verse', () => {
    expect(getDutchVerse(43, 3, 16)).toContain('alzo lief');
  });

  it('reads a single English verse', () => {
    expect(getEnglishVerse(43, 3, 16)).toContain('so loved the world');
  });

  it('returns undefined for a verse outside the fixture', () => {
    expect(getDutchVerse(43, 3, 999)).toBeUndefined();
    expect(getEnglishVerse(1, 1, 1)).toBeUndefined();
  });

  it('concatenates a verse range in order', () => {
    const range = getDutchVerseRange(43, 3, 16, 18);
    expect(range).toContain('alzo lief');
    expect(range).toContain('eniggeboren Zoons van God');
    expect(range.indexOf('alzo lief')).toBeLessThan(range.indexOf('eniggeboren Zoons van God'));
  });

  it('skips a missing verse within a range rather than failing', () => {
    const range = getEnglishVerseRange(43, 3, 15, 17); // 15 doesn't exist in the fixture
    expect(range).toContain('For God so loved');
    expect(range).toContain('For God sent not his Son');
  });

  it('never throws and returns undefined/empty when BIBLE_DIR has no bible data', () => {
    process.env.BIBLE_DIR = '/nonexistent/dir';
    _resetBibleStoreForTests();
    expect(() => getDutchVerse(43, 3, 16)).not.toThrow();
    expect(getDutchVerse(43, 3, 16)).toBeUndefined();
    expect(getDutchVerseRange(43, 3, 16, 18)).toBe('');
  });
});
