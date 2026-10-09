import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { adjudicateScripture, VERBATIM_THRESHOLD, PARAPHRASE_THRESHOLD } from '../../server/lib/scripture.js';
import { _resetBibleStoreForTests } from '../../server/lib/bible-store.js';
import { _resetBibleBooksForTests } from '../../server/lib/bible-books.js';

const BIBLE_FIXTURES = join(__dirname, '..', 'fixtures', 'bible');
const JOHN_3_16 = 'Want alzo lief heeft God de wereld gehad, dat Hij Zijn eniggeboren Zoon gegeven heeft, opdat een iegelijk die in Hem gelooft, niet verderve, maar het eeuwige leven hebbe.';

describe('adjudicateScripture', () => {
  let esvCacheDir: string;
  let kjvOnlyDir: string;
  /** Simulates a deploy where the ESV/LSB XML was never built (only SV + KJV in BIBLE_DIR). */
  const useKjvOnlyData = () => {
    process.env.BIBLE_DIR = kjvOnlyDir;
    _resetBibleStoreForTests();
    _resetBibleBooksForTests();
  };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.BIBLE_DIR = BIBLE_FIXTURES;
    esvCacheDir = mkdtempSync(join(tmpdir(), 'esv-cache-test-'));
    process.env.ESV_CACHE_DIR = esvCacheDir;
    kjvOnlyDir = mkdtempSync(join(tmpdir(), 'bible-kjv-only-'));
    for (const f of ['books.json', 'sv-nl.json.gz', 'kjv-en.json.gz']) copyFileSync(join(BIBLE_FIXTURES, f), join(kjvOnlyDir, f));
    delete process.env.ESV_API_KEY;
    _resetBibleStoreForTests();
    _resetBibleBooksForTests();
  });
  afterEach(() => {
    delete process.env.BIBLE_DIR;
    delete process.env.ESV_CACHE_DIR;
    delete process.env.ESV_API_KEY;
    global.fetch = originalFetch;
    rmSync(esvCacheDir, { recursive: true, force: true });
    rmSync(kjvOnlyDir, { recursive: true, force: true });
    _resetBibleStoreForTests();
    _resetBibleBooksForTests();
  });

  it('is verbatim for an exact reading, falling back to bundled KJV with no ESV key configured', async () => {
    useKjvOnlyData();
    const verdict = await adjudicateScripture(JOHN_3_16, { bookNumber: 43, chapter: 3, verse: 16 });
    expect(verdict.kind).toBe('verbatim');
    if (verdict.kind === 'verbatim') {
      expect(verdict.version).toBe('KJV');
      expect(verdict.text).toContain('For God so loved the world');
      expect(verdict.reference).toBe('John 3:16');
      expect(verdict.verseEnd).toBe(16);
    }
  });

  it('prefers ESV when a key is configured and the API succeeds (AC11)', async () => {
    useKjvOnlyData();
    process.env.ESV_API_KEY = 'test-key';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ passages: ['For God so loved the world (ESV wording)...'] }),
    }) as unknown as typeof fetch;

    const verdict = await adjudicateScripture(JOHN_3_16, { bookNumber: 43, chapter: 3, verse: 16 });
    expect(verdict.kind).toBe('verbatim');
    if (verdict.kind === 'verbatim') {
      expect(verdict.version).toBe('ESV');
      expect(verdict.text).toBe('For God so loved the world (ESV wording)...');
    }
  });

  it('falls back to KJV when the ESV API fails, without failing the call (AC11 resilience)', async () => {
    useKjvOnlyData();
    process.env.ESV_API_KEY = 'test-key';
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const verdict = await adjudicateScripture(JOHN_3_16, { bookNumber: 43, chapter: 3, verse: 16 });
    expect(verdict.kind).toBe('verbatim');
    if (verdict.kind === 'verbatim') {
      expect(verdict.version).toBe('KJV');
      expect(verdict.text).toContain('For God so loved the world');
    }
  });

  // The ESV/LSB fixtures are synthetic ("[ESV-fixture] ..."), not the real copyrighted text.
  it('serves the chosen version from local text with no API call or key (ESV)', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const verdict = await adjudicateScripture(JOHN_3_16, { bookNumber: 43, chapter: 3, verse: 16 }, { bibleVersion: 'ESV' });
    expect(verdict.kind).toBe('verbatim');
    if (verdict.kind === 'verbatim') {
      expect(verdict.version).toBe('ESV');
      expect(verdict.text).toContain('[ESV-fixture]');
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('serves LSB when LSB is chosen', async () => {
    const verdict = await adjudicateScripture(JOHN_3_16, { bookNumber: 43, chapter: 3, verse: 16 }, { bibleVersion: 'LSB' });
    expect(verdict.kind).toBe('verbatim');
    if (verdict.kind === 'verbatim') {
      expect(verdict.version).toBe('LSB');
      expect(verdict.text).toContain('[LSB-fixture]');
    }
  });

  it('uses KJV for a version with no local text (NASB)', async () => {
    const verdict = await adjudicateScripture(JOHN_3_16, { bookNumber: 43, chapter: 3, verse: 16 }, { bibleVersion: 'NASB' });
    expect(verdict.kind).toBe('verbatim');
    if (verdict.kind === 'verbatim') {
      expect(verdict.version).toBe('KJV');
      expect(verdict.text).not.toContain('fixture');
    }
  });

  it('gives paraphrase guidance in the chosen version', async () => {
    const paraphrase = 'Want alzo lief heeft God de wereld gehad dat Hij zijn Zoon gaf zodat iedereen die gelooft niet verloren gaat';
    const verdict = await adjudicateScripture(paraphrase, { bookNumber: 43, chapter: 3, verse: 16 }, { bibleVersion: 'LSB' });
    expect(verdict.kind).toBe('paraphrase');
    if (verdict.kind === 'paraphrase') {
      expect(verdict.version).toBe('LSB');
      expect(verdict.guidance).toContain('[LSB-fixture]');
    }
  });

  it('maps a Psalm reading onto English numbering past the Dutch title verses', async () => {
    // Statenvertaling Ps 51:3 is English Ps 51:1 (verses 1-2 are the title).
    const ps51v3 = 'Wees mij genadig, o God! naar Uw goedertierenheid; delg mijn overtredingen uit, naar de grootheid Uwer ontfermingen.';
    const verdict = await adjudicateScripture(ps51v3, { bookNumber: 19, chapter: 51, verse: 3 }, { bibleVersion: 'KJV' });
    expect(verdict.kind).toBe('verbatim');
    if (verdict.kind === 'verbatim') {
      expect(verdict.text).toContain('Have mercy upon me, O God');
      expect(verdict.reference).toBe('Psalms 51:1');
      expect(verdict.verseEnd).toBe(3); // stays Dutch-numbered so the client continues at SV verse 4
    }
  });

  it('extends the verse window when the preacher reads on into the next verse(s)', async () => {
    const johnThreeSixteenToEighteen = JOHN_3_16 +
      ' Want God heeft Zijn Zoon niet gezonden in de wereld, opdat Hij de wereld veroordelen zou, maar opdat de wereld door Hem zou behouden worden.';
    const verdict = await adjudicateScripture(johnThreeSixteenToEighteen, { bookNumber: 43, chapter: 3, verse: 16 });
    expect(verdict.kind).toBe('verbatim');
    if (verdict.kind === 'verbatim') expect(verdict.verseEnd).toBe(17);
  });

  it('is a paraphrase (not verbatim) when the preacher summarizes the verse in his own words (AC12)', async () => {
    const paraphrase = 'Want alzo lief heeft God de wereld gehad dat Hij zijn Zoon gaf zodat iedereen die gelooft niet verloren gaat';
    const verdict = await adjudicateScripture(paraphrase, { bookNumber: 43, chapter: 3, verse: 16 }, { bibleVersion: 'KJV' });
    expect(verdict.kind).toBe('paraphrase');
    if (verdict.kind === 'paraphrase') {
      expect(verdict.guidance).toContain('For God so loved the world');
      expect(verdict.version).toBe('KJV');
    }
  });

  it('is ended for text with no meaningful relation to the anchor verse (the reading is over)', async () => {
    const explanation = 'En dit is precies waarom wij vanavond hier bijeen zijn gekomen, broeders en zusters';
    const verdict = await adjudicateScripture(explanation, { bookNumber: 43, chapter: 3, verse: 16 });
    expect(verdict.kind).toBe('ended');
  });

  it('is ended when the candidate book number does not exist', async () => {
    const verdict = await adjudicateScripture(JOHN_3_16, { bookNumber: 999, chapter: 3, verse: 16 });
    expect(verdict.kind).toBe('ended');
  });

  it('is ended (never throws) when bible data has not been built', async () => {
    process.env.BIBLE_DIR = '/nonexistent/dir';
    _resetBibleStoreForTests();
    _resetBibleBooksForTests();
    const verdict = await adjudicateScripture(JOHN_3_16, { bookNumber: 43, chapter: 3, verse: 16 });
    expect(verdict.kind).toBe('ended');
  });

  it('thresholds are ordered sensibly', () => {
    expect(VERBATIM_THRESHOLD).toBeGreaterThan(PARAPHRASE_THRESHOLD);
  });
});
