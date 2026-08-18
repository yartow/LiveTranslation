// Lazily loads and caches sermon mode's Bible-quote verse data (built by
// scripts/build-bible-data.ts into data/bible/*.json.gz) — server-only, this
// is never shipped to the client (unlike bible-books.ts's small book table,
// which client/src/lib/sermon/bible-books.generated.ts also carries a copy
// of for reference parsing). Same never-throw discipline as
// glossary-store.ts: a missing or not-yet-built bible-data directory
// disables scripture substitution rather than failing a translate call —
// see scripture.ts, the only caller.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

export type VerseMap = Record<string, string>; // "bookNumber:chapter:verse" -> text

/** Not cached at module scope (deliberately) — reads process.env fresh each call so tests can stub BIBLE_DIR without a module reset. Mirrors glossary-file.ts's resolveGlossaryDir() and bible-books.ts's resolveBibleDir(). */
function resolveBibleDir(): string {
  return process.env.BIBLE_DIR || path.resolve(import.meta.dirname, '..', '..', 'data', 'bible');
}

let cachedSv: VerseMap | null | undefined; // undefined = not yet attempted this process
let cachedKjv: VerseMap | null | undefined;

function loadGzippedJson(filename: string): VerseMap | null {
  try {
    const raw = readFileSync(path.join(resolveBibleDir(), filename));
    const parsed = JSON.parse(gunzipSync(raw).toString('utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // not built yet, or BIBLE_DIR misconfigured — callers degrade gracefully
  }
}

export function getStatenvertaling(): VerseMap | null {
  if (cachedSv === undefined) cachedSv = loadGzippedJson('sv-nl.json.gz');
  return cachedSv;
}

export function getKjv(): VerseMap | null {
  if (cachedKjv === undefined) cachedKjv = loadGzippedJson('kjv-en.json.gz');
  return cachedKjv;
}

function verseKey(n: number, c: number, v: number): string {
  return `${n}:${c}:${v}`;
}

/** Dutch verse text (Statenvertaling), or undefined if unavailable/out of range. */
export function getDutchVerse(n: number, c: number, v: number): string | undefined {
  return getStatenvertaling()?.[verseKey(n, c, v)];
}

/** English verse text (KJV), or undefined if unavailable/out of range. */
export function getEnglishVerse(n: number, c: number, v: number): string | undefined {
  return getKjv()?.[verseKey(n, c, v)];
}

/**
 * Concatenated Dutch text for verseStart..verseEnd (inclusive). Skips any
 * individual missing verse rather than failing outright — verse numbering
 * occasionally differs by one at a chapter/psalm-heading boundary between
 * translations. Empty string if none of the range was found (e.g. past the
 * end of the chapter, or bible data isn't built).
 */
export function getDutchVerseRange(n: number, c: number, verseStart: number, verseEnd: number): string {
  const parts: string[] = [];
  for (let v = verseStart; v <= verseEnd; v++) {
    const text = getDutchVerse(n, c, v);
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

/** English counterpart of getDutchVerseRange, same semantics. */
export function getEnglishVerseRange(n: number, c: number, verseStart: number, verseEnd: number): string {
  const parts: string[] = [];
  for (let v = verseStart; v <= verseEnd; v++) {
    const text = getEnglishVerse(n, c, v);
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

export function _resetBibleStoreForTests(): void {
  cachedSv = undefined;
  cachedKjv = undefined;
}
