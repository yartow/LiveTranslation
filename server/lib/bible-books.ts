// Loads data/bible/books.json (built by scripts/build-bible-data.ts) once
// and caches it in memory. Two server-side callers share this: glossary-
// store.ts (to resolve the CSV's Bijbelboek rows into book numbers for
// bibleBookAliases) and bible-store.ts/scripture.ts (to resolve a parsed
// reference's book number into verse text). Never throws — a missing or
// not-yet-built bible-data directory degrades both callers to "scripture
// substitution off" rather than failing the app, same discipline as
// glossary-store.ts's own file loading.

import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface BibleBook {
  n: number;
  nl: string;
  en: string;
  /** Dutch short form from the Statenvertaling source — see bible-ref.ts's fuller, operator-editable alias list for spoken-form matching. */
  abbr: string;
}

const DEFAULT_BIBLE_DIR = path.resolve(import.meta.dirname, '..', '..', 'data', 'bible');

/** Not cached at module scope (deliberately) — reads process.env fresh each call so tests can stub BIBLE_DIR without a module reset. Mirrors glossary-file.ts's resolveGlossaryDir(). */
function resolveBibleDir(): string {
  return process.env.BIBLE_DIR || DEFAULT_BIBLE_DIR;
}

let cachedBooks: BibleBook[] | null | undefined; // undefined = not yet attempted this process

export function getBibleBooks(): BibleBook[] | null {
  if (cachedBooks !== undefined) return cachedBooks;
  try {
    const raw = readFileSync(path.join(resolveBibleDir(), 'books.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    cachedBooks = Array.isArray(parsed) ? parsed : null;
  } catch {
    cachedBooks = null; // not built yet, or BIBLE_DIR misconfigured — callers degrade gracefully
  }
  return cachedBooks;
}

/** English book name (case-insensitive, exact) -> canonical book number, or undefined if bible data isn't built or the name isn't recognized. */
export function bookNumberByEnglishName(en: string): number | undefined {
  const target = en.trim().toLowerCase();
  return getBibleBooks()?.find(b => b.en.toLowerCase() === target)?.n;
}

export function _resetBibleBooksForTests(): void {
  cachedBooks = undefined;
}
