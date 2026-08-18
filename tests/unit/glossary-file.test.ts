import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import {
  isSafeGlossaryName,
  resolveGlossaryPath,
  readGlossaryFile,
  listGlossaryFiles,
  statGlossaryFile,
} from '../../server/lib/glossary-file.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'glossary');

describe('isSafeGlossaryName', () => {
  it('rejects path traversal and absolute paths', () => {
    expect(isSafeGlossaryName('../etc/passwd', 'csv')).toBe(false);
    expect(isSafeGlossaryName('/etc/passwd.csv', 'csv')).toBe(false);
    expect(isSafeGlossaryName('a/b.csv', 'csv')).toBe(false);
    expect(isSafeGlossaryName('a\\b.csv', 'csv')).toBe(false);
    expect(isSafeGlossaryName('..\\..\\x.csv', 'csv')).toBe(false);
  });

  it('rejects the wrong extension', () => {
    expect(isSafeGlossaryName('notes.txt', 'csv')).toBe(false);
    expect(isSafeGlossaryName('mini.csv', 'md')).toBe(false);
  });

  it('rejects empty, oversized, NUL-containing, and dotfile names', () => {
    expect(isSafeGlossaryName('', 'csv')).toBe(false);
    expect(isSafeGlossaryName('a'.repeat(200) + '.csv', 'csv')).toBe(false);
    expect(isSafeGlossaryName('bad\0name.csv', 'csv')).toBe(false);
    expect(isSafeGlossaryName('.hidden.csv', 'csv')).toBe(false);
  });

  it('accepts realistic filenames including spaces and digits', () => {
    expect(isSafeGlossaryName('preek_woordenlijst_NL_EN_1.csv', 'csv')).toBe(true);
    expect(isSafeGlossaryName('preek woordenlijst 3.csv', 'csv')).toBe(true);
    expect(isSafeGlossaryName('context_afhankelijke_termen_prompt_v2.md', 'md')).toBe(true);
  });
});

describe('resolveGlossaryPath', () => {
  it('throws for an unsafe name without touching the filesystem', () => {
    expect(() => resolveGlossaryPath('../../../etc/passwd', 'csv')).toThrow();
  });
});

describe('with GLOSSARY_DIR pointed at the test fixtures', () => {
  beforeEach(() => { process.env.GLOSSARY_DIR = FIXTURES; });
  afterEach(() => { delete process.env.GLOSSARY_DIR; });

  it('resolves a safe name inside the sandbox', () => {
    const p = resolveGlossaryPath('mini.csv', 'csv');
    expect(p).toBe(join(FIXTURES, 'mini.csv'));
  });

  it('reads a real file and reports size/mtime', () => {
    const content = readGlossaryFile('mini.csv', 'csv');
    expect(content.text).toContain('Nederlands,Engels,Categorie,Notitie');
    expect(content.bytes).toBeGreaterThan(0);
    expect(content.mtimeMs).toBeGreaterThan(0);
  });

  it('throws for a missing file', () => {
    expect(() => readGlossaryFile('nope.csv', 'csv')).toThrow();
  });

  it('lists available csv/md files in the directory', () => {
    const { csv, md } = listGlossaryFiles();
    expect(csv).toContain('mini.csv');
    expect(md).toContain('mini.md');
    expect(md).toContain('empty.md');
  });

  it('statGlossaryFile returns mtime for an existing file and null for a missing one', () => {
    expect(statGlossaryFile('mini.csv', 'csv')).toBeGreaterThan(0);
    expect(statGlossaryFile('nope.csv', 'csv')).toBeNull();
  });
});

describe('listGlossaryFiles with a nonexistent directory', () => {
  beforeEach(() => { process.env.GLOSSARY_DIR = '/nonexistent/does/not/exist'; });
  afterEach(() => { delete process.env.GLOSSARY_DIR; });

  it('never throws — returns empty lists', () => {
    expect(listGlossaryFiles()).toEqual({ csv: [], md: [] });
  });
});
