import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { saveTranscript, isValidSessionId } from '../../server/lib/transcript-file.js';

describe('transcript-file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cttay-transcripts-'));
    process.env.TRANSCRIPT_DIR = path.join(dir, 'out');
  });
  afterEach(() => {
    delete process.env.TRANSCRIPT_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts only plain session ids', () => {
    expect(isValidSessionId('smh3k2a')).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'a.md', 'x'.repeat(65), 42, null]) expect(isValidSessionId(bad)).toBe(false);
  });

  it('creates the folder, names the file by date and session, and overwrites it in place', async () => {
    const file = await saveTranscript('s1', '# One\n', new Date(2026, 10, 8, 23, 59));
    expect(file).toBe(path.join(dir, 'out', '2026-11-08-s1.md'));
    // Saved again the next day: still the same file.
    expect(await saveTranscript('s1', '# Two\n', new Date(2026, 10, 9))).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('# Two\n');
    expect(fs.readdirSync(path.join(dir, 'out'))).toEqual(['2026-11-08-s1.md']);
  });

  it('refuses a session id that is not plain', async () => {
    await expect(saveTranscript('../evil', 'x')).rejects.toThrow('invalid session id');
  });
});
