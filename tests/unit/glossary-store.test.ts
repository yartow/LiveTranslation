import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import {
  getGlossaryBundle,
  reloadGlossary,
  getGlossaryStatus,
  initGlossary,
  _resetGlossaryForTests,
} from '../../server/lib/glossary-store.js';
import { _resetBibleBooksForTests } from '../../server/lib/bible-books.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'glossary');
const BIBLE_FIXTURES = join(__dirname, '..', 'fixtures', 'bible');

describe('glossary-store', () => {
  beforeEach(() => {
    process.env.GLOSSARY_DIR = FIXTURES;
    _resetGlossaryForTests();
    // Point at a directory with no books.json rather than leaving BIBLE_DIR
    // unset — an unset var falls through to the real data/bible/, whose
    // presence depends on whether scripts/build-bible-data.ts has been run
    // in this checkout, which would make these tests non-hermetic.
    process.env.BIBLE_DIR = '/nonexistent/bible-dir';
    _resetBibleBooksForTests();
  });
  afterEach(() => {
    delete process.env.GLOSSARY_DIR;
    delete process.env.BIBLE_DIR;
    _resetGlossaryForTests();
    _resetBibleBooksForTests();
  });

  it('builds a bundle from a valid csv+md pair', () => {
    const bundle = getGlossaryBundle({ csv: 'mini.csv', prompt: 'mini.md' });
    expect(bundle).not.toBeNull();
    expect(bundle!.diagnostics.loaded).toBe(true);
    expect(bundle!.diagnostics.csv.fixedRows).toBeGreaterThan(0);
    expect(bundle!.disambiguationTemplate).toContain('{DOELVERTALING}');
    expect(bundle!.fixedBlock).toContain('DATA ONLY');
  });

  it('returns a stable version across repeated calls for the same selection', () => {
    const a = getGlossaryBundle({ csv: 'mini.csv', prompt: 'mini.md' });
    const b = getGlossaryBundle({ csv: 'mini.csv', prompt: 'mini.md' });
    expect(a!.version).toBe(b!.version);
  });

  it('returns null and loaded:false, without throwing, for a missing CSV', () => {
    const bundle = getGlossaryBundle({ csv: 'nope.csv', prompt: 'mini.md' });
    expect(bundle).toBeNull();
  });

  it('never throws for a missing csv, and status reports the error', () => {
    expect(() => getGlossaryStatus({ csv: 'nope.csv', prompt: 'mini.md' })).not.toThrow();
    const status = getGlossaryStatus({ csv: 'nope.csv', prompt: 'mini.md' });
    expect(status.loaded).toBe(false);
    expect(status.errors.length).toBeGreaterThan(0);
  });

  it('never throws when the prompt doc has no fenced block', () => {
    const bundle = getGlossaryBundle({ csv: 'mini.csv', prompt: 'empty.md' });
    expect(bundle).toBeNull();
    const status = getGlossaryStatus({ csv: 'mini.csv', prompt: 'empty.md' });
    expect(status.errors.some(e => e.includes('fenced code block'))).toBe(true);
  });

  it('reloadGlossary rebuilds and returns fresh diagnostics', () => {
    getGlossaryBundle({ csv: 'mini.csv', prompt: 'mini.md' });
    const diagnostics = reloadGlossary({ csv: 'mini.csv', prompt: 'mini.md' });
    expect(diagnostics.loaded).toBe(true);
  });

  it('status includes the cross-check warnings (boze in doc, not in csv-context)', () => {
    const status = getGlossaryStatus({ csv: 'mini.csv', prompt: 'mini.md' });
    expect(status.warnings.some(w => w.includes('boze'))).toBe(true);
  });

  it('status reports available csv/md files', () => {
    const status = getGlossaryStatus({ csv: 'mini.csv', prompt: 'mini.md' });
    expect(status.available.csv).toContain('mini.csv');
    expect(status.available.md).toContain('mini.md');
  });

  it('status.stale is false right after a fresh build', () => {
    reloadGlossary({ csv: 'mini.csv', prompt: 'mini.md' });
    const status = getGlossaryStatus({ csv: 'mini.csv', prompt: 'mini.md' });
    expect(status.stale).toBe(false);
  });

  it('initGlossary never throws even with no glossary files present', () => {
    process.env.GLOSSARY_DIR = '/nonexistent/dir';
    expect(() => initGlossary()).not.toThrow();
  });

  it('caches bundles per distinct selection without unbounded growth', () => {
    for (let i = 0; i < 20; i++) {
      getGlossaryBundle({ csv: 'mini.csv', prompt: 'mini.md' });
    }
    // same selection every time -> should not grow the cache at all
    const bundle = getGlossaryBundle({ csv: 'mini.csv', prompt: 'mini.md' });
    expect(bundle).not.toBeNull();
  });

  describe('bibleBookAliases', () => {
    it('is empty when bible data has not been built (no BIBLE_DIR)', () => {
      // mini.csv has a "Genesis,Genesis,Bijbelboek," row, but with no
      // books.json available there is nothing to resolve it against.
      const bundle = getGlossaryBundle({ csv: 'mini.csv', prompt: 'mini.md' });
      expect(bundle!.bibleBookAliases.size).toBe(0);
    });

    it('resolves the CSV\'s Bijbelboek rows against the bible-books table', () => {
      process.env.BIBLE_DIR = BIBLE_FIXTURES;
      _resetBibleBooksForTests();
      _resetGlossaryForTests(); // bundle is cached — force a rebuild against the new BIBLE_DIR

      const bundle = getGlossaryBundle({ csv: 'mini.csv', prompt: 'mini.md' });
      expect(bundle!.bibleBookAliases.get('genesis')).toBe(1);
    });
  });
});
