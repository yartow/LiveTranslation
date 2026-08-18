// Adjudicates a detected Bible reading against what the preacher actually
// said (spec "Bijbelcitaten" — the three-layer scripture-handling design,
// AC 11 & 12). This is what lets a translate call skip the model entirely
// for a verbatim reading (exact verse text — free, fast, and word-perfect)
// while still translating a paraphrase in the preacher's own words instead
// of putting words in his mouth.
//
// See client/src/lib/sermon/bible-ref.ts for how a reading is *detected* in
// the first place — book/chapter/verse resolution happens entirely
// client-side and is trusted here rather than re-parsed, so book-name
// recognition exists in exactly one place. See server/lib/sermon-
// translate.ts for the only caller.

import { getDutchVerseRange, getEnglishVerseRange } from './bible-store';
import { getBibleBooks } from './bible-books';
import { similarity } from './text-similarity';
import { fetchEsvPassage } from './esv-api';

// A preacher often reads several verses in one breath before the segmenter
// cuts a sentence boundary — check the candidate against 1, 2, and 3-verse
// windows starting at the announced verse rather than assuming the reading
// is exactly one verse long.
const MAX_WINDOW = 3;

/** Spoken text this close (or closer) to the Dutch anchor is treated as a verbatim reading — substitute the exact English verse text, no model call. */
export const VERBATIM_THRESHOLD = 0.72;
/** Below this, the reading has ended (the preacher moved on to explanation) — translate normally with no scripture guidance at all. */
export const PARAPHRASE_THRESHOLD = 0.45;

export interface ReadingCandidate {
  bookNumber: number;
  chapter: number;
  verse: number;
}

export type ScriptureVerdict =
  | { kind: 'verbatim'; verseEnd: number; text: string; version: 'ESV' | 'KJV'; reference: string }
  | { kind: 'paraphrase'; verseEnd: number; guidance: string; version: 'KJV' }
  | { kind: 'ended' };

export interface AdjudicateOptions {
  esvApiKey?: string;
  /** Defaults true — set false to skip the ESV API entirely (e.g. no key configured, or the operator prefers the bundled KJV) and use KJV for a verbatim hit too. */
  preferEsv?: boolean;
  signal?: AbortSignal;
}

/**
 * Compares `spoken` (a segment's Dutch source text) against the Dutch anchor
 * verse(s) starting at `candidate`. Returns:
 *  - `verbatim` — substitute the exact English text (ESV via API, falling
 *    back to bundled KJV on any API failure — see esv-api.ts).
 *  - `paraphrase` — the preacher is alluding to / summarizing the passage;
 *    translate his own words, using the English text only as register
 *    guidance for the model, never substituted directly (AC12).
 *  - `ended` — not a close enough match at all; the reading is over (or
 *    never started), translate with no scripture involvement.
 */
export async function adjudicateScripture(
  spoken: string, candidate: ReadingCandidate, opts: AdjudicateOptions = {},
): Promise<ScriptureVerdict> {
  const book = getBibleBooks()?.find(b => b.n === candidate.bookNumber);
  if (!book) return { kind: 'ended' };

  let best: { verseEnd: number; sim: number } | null = null;
  for (let span = 1; span <= MAX_WINDOW; span++) {
    const verseEnd = candidate.verse + span - 1;
    const dutch = getDutchVerseRange(candidate.bookNumber, candidate.chapter, candidate.verse, verseEnd);
    if (!dutch) break; // ran past the end of the chapter (or bible data isn't built) — no wider window to try
    const sim = similarity(spoken, dutch);
    if (!best || sim > best.sim) best = { verseEnd, sim };
  }

  if (!best || best.sim < PARAPHRASE_THRESHOLD) return { kind: 'ended' };

  if (best.sim >= VERBATIM_THRESHOLD) {
    const esvText = opts.preferEsv !== false
      ? await fetchEsvPassage(book.en, candidate.chapter, candidate.verse, best.verseEnd, { apiKey: opts.esvApiKey, signal: opts.signal })
      : null;
    const text = esvText ?? getEnglishVerseRange(candidate.bookNumber, candidate.chapter, candidate.verse, best.verseEnd);
    if (!text) return { kind: 'ended' }; // no English text available from either source
    const reference = best.verseEnd === candidate.verse
      ? `${book.en} ${candidate.chapter}:${candidate.verse}`
      : `${book.en} ${candidate.chapter}:${candidate.verse}-${best.verseEnd}`;
    return { kind: 'verbatim', verseEnd: best.verseEnd, text, version: esvText ? 'ESV' : 'KJV', reference };
  }

  // Paraphrase band: guide the model toward the passage's register without
  // an ESV lookup — worth spending an API call on a passage that's actually
  // being quoted, not one that's merely being alluded to.
  const guidance = getEnglishVerseRange(candidate.bookNumber, candidate.chapter, candidate.verse, best.verseEnd);
  if (!guidance) return { kind: 'ended' };
  return { kind: 'paraphrase', verseEnd: best.verseEnd, guidance, version: 'KJV' };
}
