import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import {
  getDutchVerse, getEnglishVerse, getDutchVerseRange, getEnglishVerseRange, hasEnglishVersion, dutchToEnglishVerses, _resetBibleStoreForTests,
} from '../../server/lib/bible-store.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'bible');

describe('bible-store', () => {
  const originalBibleDir = process.env.BIBLE_DIR;

  beforeEach(() => {
    process.env.BIBLE_DIR = FIXTURE_DIR;
    _resetBibleStoreForTests();
  });
  afterEach(() => {
    if (originalBibleDir === undefined) delete process.env.BIBLE_DIR;
    else process.env.BIBLE_DIR = originalBibleDir;
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

  it('reads a specific English version when built, defaulting to KJV', () => {
    expect(getEnglishVerse(43, 3, 16)).not.toContain('fixture');
    expect(getEnglishVerse(43, 3, 16, 'ESV')).toContain('[ESV-fixture]');
    expect(getEnglishVerseRange(43, 3, 16, 17, 'LSB')).toContain('[LSB-fixture]');
    expect(hasEnglishVersion('KJV')).toBe(true);
    expect(hasEnglishVersion('ESV')).toBe(true);
  });

  it('reports a version as unavailable (and returns undefined) when its file was not built', () => {
    process.env.BIBLE_DIR = '/nonexistent/dir';
    _resetBibleStoreForTests();
    expect(hasEnglishVersion('ESV')).toBe(false);
    expect(getEnglishVerse(43, 3, 16, 'ESV')).toBeUndefined();
  });

  describe('dutchToEnglishVerses (Psalm title verses)', () => {
    // Fixture psalm-titles.json: Psalm 51 has a two-verse title in the Dutch numbering.
    it('shifts a Psalm by its title-verse count', () => {
      expect(dutchToEnglishVerses(19, 51, 3, 3)).toEqual({ start: 1, end: 1 });
      expect(dutchToEnglishVerses(19, 51, 3, 5)).toEqual({ start: 1, end: 3 });
    });
    it('clamps a range that starts inside the title, and nulls one entirely inside it', () => {
      expect(dutchToEnglishVerses(19, 51, 1, 3)).toEqual({ start: 1, end: 1 });
      expect(dutchToEnglishVerses(19, 51, 1, 2)).toBeNull();
    });
    it('leaves untitled psalms and other books alone', () => {
      expect(dutchToEnglishVerses(19, 23, 1, 2)).toEqual({ start: 1, end: 2 });
      expect(dutchToEnglishVerses(43, 3, 16, 17)).toEqual({ start: 16, end: 17 });
    });
    it('is the identity when the table is not built', () => {
      process.env.BIBLE_DIR = '/nonexistent/dir';
      _resetBibleStoreForTests();
      expect(dutchToEnglishVerses(19, 51, 3, 3)).toEqual({ start: 3, end: 3 });
    });
  });

  it('never throws and returns undefined/empty when BIBLE_DIR has no bible data', () => {
    process.env.BIBLE_DIR = '/nonexistent/dir';
    _resetBibleStoreForTests();
    expect(() => getDutchVerse(43, 3, 16)).not.toThrow();
    expect(getDutchVerse(43, 3, 16)).toBeUndefined();
    expect(getDutchVerseRange(43, 3, 16, 18)).toBe('');
  });
});
