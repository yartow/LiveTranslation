import { describe, it, expect } from 'vitest';
import { parseDutchNumberWord, findBibleRef, findAllBibleRefs } from '../../client/src/lib/sermon/bible-ref.js';

describe('parseDutchNumberWord', () => {
  it('parses ones, teens, and tens', () => {
    expect(parseDutchNumberWord('drie')).toBe(3);
    expect(parseDutchNumberWord('zestien')).toBe(16);
    expect(parseDutchNumberWord('twintig')).toBe(20);
  });

  it('parses compound numbers (ones-en-tens)', () => {
    expect(parseDutchNumberWord('eenentwintig')).toBe(21);
    expect(parseDutchNumberWord('tweeëntwintig')).toBe(22); // diacritic form
    expect(parseDutchNumberWord('vijfenzeventig')).toBe(75);
    expect(parseDutchNumberWord('achtentwintig')).toBe(28);
  });

  it('parses honderd + rest, up to Psalm 119\'s chapter length', () => {
    expect(parseDutchNumberWord('honderd')).toBe(100);
    expect(parseDutchNumberWord('honderdnegentien')).toBe(119);
    expect(parseDutchNumberWord('honderdzesenzeventig')).toBe(176);
  });

  it('returns null for unrecognized words', () => {
    expect(parseDutchNumberWord('appel')).toBeNull();
    expect(parseDutchNumberWord('')).toBeNull();
  });
});

describe('findBibleRef — standard forms', () => {
  it('parses "Johannes 3:16"', () => {
    const ref = findBibleRef('Johannes 3:16');
    expect(ref).not.toBeNull();
    expect(ref).toMatchObject({ bookNumber: 43, chapter: 3, verseStart: 16, verseEnd: null, canonicalEn: 'John 3:16' });
  });

  it('parses "Johannes 3 vers 16"', () => {
    const ref = findBibleRef('Johannes 3 vers 16');
    expect(ref).toMatchObject({ bookNumber: 43, chapter: 3, verseStart: 16, canonicalEn: 'John 3:16' });
  });

  it('parses "Johannes 3 vs 16"', () => {
    const ref = findBibleRef('Johannes 3 vs 16');
    expect(ref).toMatchObject({ bookNumber: 43, chapter: 3, verseStart: 16 });
  });

  it('parses "Johannes hoofdstuk 3 vers 16"', () => {
    const ref = findBibleRef('Johannes hoofdstuk 3 vers 16');
    expect(ref).toMatchObject({ bookNumber: 43, chapter: 3, verseStart: 16 });
  });

  it('parses spelled-out numbers: "Johannes drie vers zestien"', () => {
    const ref = findBibleRef('Johannes drie vers zestien');
    expect(ref).toMatchObject({ bookNumber: 43, chapter: 3, verseStart: 16, canonicalEn: 'John 3:16' });
  });

  it('parses a chapter-only reference: "Johannes 3"', () => {
    const ref = findBibleRef('Laten we lezen uit Johannes 3.');
    expect(ref).toMatchObject({ bookNumber: 43, chapter: 3, verseStart: null, verseEnd: null, canonicalEn: 'John 3' });
  });
});

describe('findBibleRef — numbered/ordinal books', () => {
  it('parses "1 Korinthe 13 vers 4 tot 7"', () => {
    const ref = findBibleRef('1 Korinthe 13 vers 4 tot 7');
    expect(ref).toMatchObject({ bookNumber: 46, chapter: 13, verseStart: 4, verseEnd: 7, canonicalEn: '1 Corinthians 13:4-7' });
  });

  it('parses "eerste Korinthe 13"', () => {
    const ref = findBibleRef('eerste Korinthe 13');
    expect(ref).toMatchObject({ bookNumber: 46, chapter: 13, verseStart: null, canonicalEn: '1 Corinthians 13' });
  });

  it('parses "1e Korinthe 13:4"', () => {
    const ref = findBibleRef('1e Korinthe 13:4');
    expect(ref).toMatchObject({ bookNumber: 46, chapter: 13, verseStart: 4 });
  });

  it('distinguishes 1 vs 2 Korinthe', () => {
    expect(findBibleRef('2 Korinthe 5:17')).toMatchObject({ bookNumber: 47, chapter: 5, verseStart: 17 });
  });
});

describe('findBibleRef — verse ranges', () => {
  it('parses a fused dash range "16-18"', () => {
    const ref = findBibleRef('Johannes 3 vers 16-18');
    expect(ref).toMatchObject({ verseStart: 16, verseEnd: 18, canonicalEn: 'John 3:16-18' });
  });

  it('parses "16 tot 18"', () => {
    const ref = findBibleRef('Johannes 3 vers 16 tot 18');
    expect(ref).toMatchObject({ verseStart: 16, verseEnd: 18 });
  });

  it('parses "16 t/m 18"', () => {
    const ref = findBibleRef('Johannes 3 vers 16 t/m 18');
    expect(ref).toMatchObject({ verseStart: 16, verseEnd: 18 });
  });

  it('parses "16 en 17"', () => {
    const ref = findBibleRef('Johannes 3 vers 16 en 17');
    expect(ref).toMatchObject({ verseStart: 16, verseEnd: 17 });
  });

  it('parses an inline fused chapter:verse-verse "3:16-18"', () => {
    const ref = findBibleRef('Johannes 3:16-18');
    expect(ref).toMatchObject({ chapter: 3, verseStart: 16, verseEnd: 18 });
  });
});

describe('findBibleRef — abbreviations and spoken variants', () => {
  it('recognizes the Statenvertaling short form ("Joh")', () => {
    expect(findBibleRef('Joh 3:16')).toMatchObject({ bookNumber: 43 });
  });

  it('recognizes "Openbaring" for "Openbaring van Johannes"', () => {
    expect(findBibleRef('Openbaring 21:4')).toMatchObject({ bookNumber: 66, chapter: 21, verseStart: 4 });
  });

  it('recognizes "Psalm" (singular) for "Psalmen"', () => {
    expect(findBibleRef('Psalm 23:1')).toMatchObject({ bookNumber: 19, chapter: 23, verseStart: 1 });
  });

  it('recognizes "Handelingen" for "Handelingen der apostelen"', () => {
    expect(findBibleRef('Handelingen 2:4')).toMatchObject({ bookNumber: 44 });
  });
});

describe('findBibleRef — no false positives', () => {
  it('returns null for ordinary prose with no reference', () => {
    expect(findBibleRef('Genade zij u en vrede van God onze Vader.')).toBeNull();
  });

  it('does not treat a bare book name with no chapter number as a reference', () => {
    expect(findBibleRef('Johannes was een discipel van Jezus.')).toBeNull();
  });
});

describe('findAllBibleRefs', () => {
  it('finds two references in one segment', () => {
    const refs = findAllBibleRefs('Lees eerst Johannes 3:16, en dan Romeinen 8:28.');
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ bookNumber: 43, chapter: 3, verseStart: 16 });
    expect(refs[1]).toMatchObject({ bookNumber: 45, chapter: 8, verseStart: 28 });
  });

  it('returns an empty array when there is no reference', () => {
    expect(findAllBibleRefs('Geen enkele referentie hier.')).toEqual([]);
  });
});
