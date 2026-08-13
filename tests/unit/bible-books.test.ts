import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { getBibleBooks, bookNumberByEnglishName, _resetBibleBooksForTests } from '../../server/lib/bible-books.js';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'bible');

describe('bible-books', () => {
  beforeEach(() => {
    process.env.BIBLE_DIR = FIXTURE_DIR;
    _resetBibleBooksForTests();
  });
  afterEach(() => {
    delete process.env.BIBLE_DIR;
    _resetBibleBooksForTests();
  });

  it('loads and caches the books table from BIBLE_DIR', () => {
    const books = getBibleBooks();
    expect(books).not.toBeNull();
    expect(books).toHaveLength(3);
    expect(books![0]).toEqual({ n: 1, nl: 'Genesis', en: 'Genesis', abbr: 'Gen' });
  });

  it('resolves a book number by exact, case-insensitive English name', () => {
    expect(bookNumberByEnglishName('John')).toBe(43);
    expect(bookNumberByEnglishName('john')).toBe(43);
    expect(bookNumberByEnglishName('  JOHN  ')).toBe(43);
  });

  it('returns undefined for an unrecognized name', () => {
    expect(bookNumberByEnglishName('Nonexistent Book')).toBeUndefined();
  });

  it('never throws and returns null when BIBLE_DIR has no books.json', () => {
    process.env.BIBLE_DIR = '/nonexistent/dir';
    _resetBibleBooksForTests();
    expect(() => getBibleBooks()).not.toThrow();
    expect(getBibleBooks()).toBeNull();
    expect(bookNumberByEnglishName('John')).toBeUndefined();
  });
});
