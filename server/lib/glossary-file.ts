// Filesystem sandbox for the sermon-mode glossary files. The client picks a
// FILENAME (never a path) from Settings; the server resolves it against a
// server-configured base directory and refuses to read anything outside it.
// This is the deliberate resolution to a real tension: the spec wants
// client-editable file paths, but a client-supplied absolute path that the
// server reads and embeds into an LLM prompt is an arbitrary-file-disclosure
// vector. See the plan doc §"Path safety".

import path from 'node:path';
import fs from 'node:fs';

export const MAX_GLOSSARY_BYTES = 512 * 1024;

const DEFAULT_DIR = path.resolve(import.meta.dirname, '..', '..', 'data');

/** Not cached at module scope (deliberately) — reads process.env fresh each call so tests can stub GLOSSARY_DIR without a module reset. */
export function getGlossaryDir(): string {
  const envDir = process.env.GLOSSARY_DIR;
  return envDir ? path.resolve(envDir) : DEFAULT_DIR;
}

export type GlossaryKind = 'csv' | 'md';

// Real filenames in this repo contain spaces, digits, parens, and Latin-1
// Supplement/Extended-A letters (Statenvertaling diacritics) — allow those,
// nothing else. No path separators, no NUL, no leading dot (hidden files).
// No `u` flag — this project's tsconfig has no explicit `target`, which
// defaults low enough that tsc rejects the `u` regex flag. Literal Unicode
// character-range members (not \p{} property escapes, which do need `u`)
// work fine without it for BMP text like this.
const SAFE_NAME_RE = /^[\w .()'À-ɏ-]+$/;
const MAX_NAME_LEN = 128;

export function isSafeGlossaryName(name: string, kind: GlossaryKind): boolean {
  if (typeof name !== 'string' || !name || name.length > MAX_NAME_LEN) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) return false;
  if (name.startsWith('.')) return false;
  if (!SAFE_NAME_RE.test(name)) return false;
  const ext = kind === 'csv' ? '.csv' : '.md';
  return name.toLowerCase().endsWith(ext);
}

/** Throws on any unsafe or out-of-sandbox name — callers must catch. */
export function resolveGlossaryPath(name: string, kind: GlossaryKind): string {
  if (!isSafeGlossaryName(name, kind)) {
    throw new Error(`Unsafe glossary filename: ${name}`);
  }
  const dir = getGlossaryDir();
  const resolved = path.resolve(dir, name);
  if (!resolved.startsWith(dir + path.sep)) {
    throw new Error(`Glossary filename escapes the glossary directory: ${name}`);
  }
  return resolved;
}

export interface GlossaryFileContent {
  text: string;
  mtimeMs: number;
  bytes: number;
}

/** Throws on missing file, non-file, oversize file, or an unsafe name. */
export function readGlossaryFile(name: string, kind: GlossaryKind): GlossaryFileContent {
  const p = resolveGlossaryPath(name, kind);
  const stat = fs.statSync(p);
  if (!stat.isFile()) throw new Error(`Not a file: ${name}`);
  if (stat.size > MAX_GLOSSARY_BYTES) throw new Error(`Glossary file too large: ${name} (${stat.size} bytes, max ${MAX_GLOSSARY_BYTES})`);
  return { text: fs.readFileSync(p, 'utf8'), mtimeMs: stat.mtimeMs, bytes: stat.size };
}

/** Never throws — returns empty lists if the directory is missing or unreadable. */
export function listGlossaryFiles(): { csv: string[]; md: string[] } {
  try {
    const entries = fs.readdirSync(getGlossaryDir(), { withFileTypes: true });
    const csv = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.csv')).map(e => e.name).sort();
    const md = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md')).map(e => e.name).sort();
    return { csv, md };
  } catch {
    return { csv: [], md: [] };
  }
}

/** Never throws — returns null if the file is missing, unsafe, or unreadable. */
export function statGlossaryFile(name: string, kind: GlossaryKind): number | null {
  try {
    return fs.statSync(resolveGlossaryPath(name, kind)).mtimeMs;
  } catch {
    return null;
  }
}
