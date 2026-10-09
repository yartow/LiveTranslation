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

/** English texts we can substitute. KJV is always bundled (public domain); ESV/LSB exist only if scripts/build-bible-data.ts found their XML sources. */
export type EnglishVersion = 'KJV' | 'ESV' | 'LSB';

const ENGLISH_FILES: Record<EnglishVersion, string> = {
  KJV: 'kjv-en.json.gz',
  ESV: 'esv-en.json.gz',
  LSB: 'lsb-en.json.gz',
};

let cachedSv: VerseMap | null | undefined; // undefined = not yet attempted this process
const cachedEnglish: Partial<Record<EnglishVersion, VerseMap | null>> = {};

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

export function getEnglishBible(version: EnglishVersion): VerseMap | null {
  if (cachedEnglish[version] === undefined) cachedEnglish[version] = loadGzippedJson(ENGLISH_FILES[version]);
  return cachedEnglish[version] ?? null;
}

export function getKjv(): VerseMap | null {
  return getEnglishBible('KJV');
}

/** True if this English text was built into data/bible (KJV: always, once built; ESV/LSB: only with their XML sources). */
export function hasEnglishVersion(version: EnglishVersion): boolean {
  return getEnglishBible(version) !== null;
}

// Psalm superscriptions. The Statenvertaling numbers a stand-alone title as
// verse 1 (verses 1-2 for Ps 51/52/54/60) while English Bibles don't, so a
// spoken SV verse v is English verse v - t. The table {"51": 2, ...} (only
// psalms with t >= 1) is derived by scripts/build-bible-data.ts. Missing file =
// no remapping (identity), the same never-throw degradation as the verse data.
const PSALMS_BOOK = 19;
let cachedPsalmTitles: Record<string, number> | null | undefined;

function getPsalmTitleVerses(): Record<string, number> | null {
  if (cachedPsalmTitles === undefined) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(resolveBibleDir(), 'psalm-titles.json'), 'utf-8'));
      cachedPsalmTitles = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      cachedPsalmTitles = null;
    }
  }
  return cachedPsalmTitles ?? null;
}

/**
 * Maps a verse range as numbered in the Dutch Bible (what the preacher says and
 * the Dutch anchor uses) onto English numbering. Identical except in Psalms with a
 * stand-alone title verse. A range that starts inside the title is clamped to
 * English verse 1; a range lying entirely inside the title returns null (the
 * English Bibles have no numbered verse for it).
 */
export function dutchToEnglishVerses(
  n: number, c: number, verseStart: number, verseEnd: number,
): { start: number; end: number } | null {
  const t = n === PSALMS_BOOK ? (getPsalmTitleVerses()?.[String(c)] ?? 0) : 0;
  if (t === 0) return { start: verseStart, end: verseEnd };
  const end = verseEnd - t;
  if (end < 1) return null;
  return { start: Math.max(verseStart - t, 1), end };
}

function verseKey(n: number, c: number, v: number): string {
  return `${n}:${c}:${v}`;
}

/** Dutch verse text (Statenvertaling), or undefined if unavailable/out of range. */
export function getDutchVerse(n: number, c: number, v: number): string | undefined {
  return getStatenvertaling()?.[verseKey(n, c, v)];
}

/** English verse text (KJV unless another built version is named), or undefined if unavailable/out of range. */
export function getEnglishVerse(n: number, c: number, v: number, version: EnglishVersion = 'KJV'): string | undefined {
  return getEnglishBible(version)?.[verseKey(n, c, v)];
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
export function getEnglishVerseRange(
  n: number, c: number, verseStart: number, verseEnd: number, version: EnglishVersion = 'KJV',
): string {
  const parts: string[] = [];
  for (let v = verseStart; v <= verseEnd; v++) {
    const text = getEnglishVerse(n, c, v, version);
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

export function _resetBibleStoreForTests(): void {
  cachedSv = undefined;
  cachedPsalmTitles = undefined;
  for (const v of Object.keys(cachedEnglish) as EnglishVersion[]) delete cachedEnglish[v];
}
