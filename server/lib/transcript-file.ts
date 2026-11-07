// The English transcript of a service as a markdown file on the operator's machine — written by
// POST /api/sermon/transcript-md each time the operator stops recording (and on later edits), see
// client/src/hooks/useTranscriptSave.ts. One file per page session, overwritten in place:
// TRANSCRIPT_DIR/YYYY-MM-DD-<sessionId>.md (default <repo>/data/transcripts, gitignored via data/*).
//
// The client names only the session id, never a path: it is checked against a strict pattern, so the
// write cannot leave TRANSCRIPT_DIR.

import fs from 'fs/promises';
import path from 'path';

const DEFAULT_DIR = path.resolve(import.meta.dirname, '..', '..', 'data', 'transcripts');
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Read fresh on every call so tests can point it elsewhere. */
export function transcriptDir(): string {
  return process.env.TRANSCRIPT_DIR ? path.resolve(process.env.TRANSCRIPT_DIR) : DEFAULT_DIR;
}

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID.test(id);
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Writes `markdown` for `sessionId` and returns the file's path. A session that already has a file
 * keeps it (a sermon running past midnight, or saved again the next morning, stays one file).
 */
export async function saveTranscript(sessionId: string, markdown: string, now: Date = new Date()): Promise<string> {
  if (!isValidSessionId(sessionId)) throw new Error('invalid session id');
  const dir = transcriptDir();
  await fs.mkdir(dir, { recursive: true });
  const suffix = `-${sessionId}.md`;
  const existing = (await fs.readdir(dir)).find(f => f.endsWith(suffix) && /^\d{4}-\d{2}-\d{2}-/.test(f));
  const file = path.join(dir, existing ?? `${localDate(now)}${suffix}`);
  // Write-then-rename, so a reader (or a crash mid-write) never sees half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, markdown, 'utf8');
  await fs.rename(tmp, file);
  return file;
}
