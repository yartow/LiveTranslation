// ESV API client (api.esv.org) for sermon mode's Bible-quote "Layer 1" verse
// text (spec "Bijbelcitaten" section "Bron van de Engelse verstekst") —
// fetched only when a reading is judged verbatim (see scripture.ts), and
// cached to disk so a re-read of the same verse (or a common cross-
// reference used across sermons) doesn't re-hit the API — keeping well
// within the free tier's ~5,000 queries/day, 500 verses/query limits.
//
// Falls back to the bundled KJV (bible-store.ts) whenever this returns
// null: no ESV_API_KEY configured, the request errors, or the network is
// unavailable — scripture.ts is the only caller and treats every failure
// mode here as "use KJV instead", never as a reason to fail the translate
// call. Crossway's attribution requirement is met by surfacing
// ESV_ATTRIBUTION in the UI wherever ESV-sourced text is shown, not by
// bundling ESV text itself — the bundled fallback is KJV, public domain.
//
// Unlike glossary-file.ts's GLOSSARY_DIR sandboxing, there is no path-
// traversal surface to defend here: cache filenames are built entirely from
// already-validated integers (book number 1-66, positive chapter/verse),
// never from external/user-supplied strings.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export const ESV_ATTRIBUTION =
  'Scripture quotations marked ESV are from the ESV® Bible (The Holy Bible, English Standard Version®), ' +
  'copyright © 2001 by Crossway, a publishing ministry of Good News Publishers. Used by permission. All rights reserved.';

function resolveCacheDir(): string {
  return process.env.ESV_CACHE_DIR || path.resolve(import.meta.dirname, '..', '..', 'data', 'bible-cache', 'esv');
}

function cacheKey(bookEn: string, chapter: number, verseStart: number, verseEnd: number): string {
  const safeBook = bookEn.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${safeBook}-${chapter}-${verseStart}-${verseEnd}.txt`;
}

function readCache(key: string): string | null {
  try {
    const file = path.join(resolveCacheDir(), key);
    return existsSync(file) ? readFileSync(file, 'utf-8') : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, text: string): void {
  try {
    const dir = resolveCacheDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, key), text, 'utf-8');
  } catch {
    // Non-fatal — the verse text is still returned to the caller even if the cache write fails.
  }
}

export interface EsvFetchOptions {
  apiKey?: string;
  signal?: AbortSignal;
}

/**
 * Fetches "Book C:V" or "Book C:V-V" from api.esv.org, with headings,
 * footnotes, verse numbers, and the passage reference stripped so the
 * result is plain quotable prose. Returns null (never throws) on a missing
 * key, network error, or malformed response.
 */
export async function fetchEsvPassage(
  bookEn: string, chapter: number, verseStart: number, verseEnd: number, opts: EsvFetchOptions = {},
): Promise<string | null> {
  const key = cacheKey(bookEn, chapter, verseStart, verseEnd);
  const cached = readCache(key);
  if (cached !== null) return cached;

  const apiKey = opts.apiKey || process.env.ESV_API_KEY;
  if (!apiKey) return null;

  const range = verseStart === verseEnd ? `${verseStart}` : `${verseStart}-${verseEnd}`;
  const url = new URL('https://api.esv.org/v3/passage/text/');
  url.searchParams.set('q', `${bookEn} ${chapter}:${range}`);
  url.searchParams.set('include-headings', 'false');
  url.searchParams.set('include-footnotes', 'false');
  url.searchParams.set('include-verse-numbers', 'false');
  url.searchParams.set('include-short-copyright', 'false');
  url.searchParams.set('include-passage-references', 'false');

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Token ${apiKey}` },
      signal: opts.signal ?? AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { passages?: string[] };
    const text = data.passages?.[0]?.trim().replace(/\s+/g, ' ');
    if (!text) return null;
    writeCache(key, text);
    return text;
  } catch {
    return null;
  }
}
