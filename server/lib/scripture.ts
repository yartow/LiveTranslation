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

import { getDutchVerseRange, getEnglishVerseRange, dutchToEnglishVerses, hasEnglishVersion, type EnglishVersion } from './bible-store';
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
  | { kind: 'verbatim'; verseEnd: number; text: string; version: EnglishVersion; reference: string }
  | { kind: 'paraphrase'; verseEnd: number; guidance: string; version: EnglishVersion }
  | { kind: 'ended' };

export interface AdjudicateOptions {
  /** The operator's chosen Bible ("Doelvertaling"). ESV and LSB are served from locally built text (data/bible/{esv,lsb}-en.json.gz); anything else, or a version whose text isn't built, falls back to KJV. Omitted = ESV, matching the settings default. */
  bibleVersion?: string;
  esvApiKey?: string;
  /** Defaults true — set false to skip the ESV API entirely. The API is only ever a fallback for ESV when the local ESV text isn't built. */
  preferEsv?: boolean;
  signal?: AbortSignal;
}

/** The version the operator asked for, if we have local text for it — else KJV (always bundled). */
function resolveLocalVersion(requested: string | undefined): EnglishVersion {
  const v = (requested ?? 'ESV').toUpperCase();
  if ((v === 'ESV' || v === 'LSB') && hasEnglishVersion(v)) return v;
  return 'KJV';
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

  // The spoken verses are numbered as in the Dutch Bible; English numbering
  // differs in Psalms with a stand-alone title verse (see bible-store.ts). Every
  // English lookup, API call and displayed reference below uses `en`; `verseEnd`
  // in the verdict stays Dutch-numbered because the client uses it to continue the reading.
  const en = dutchToEnglishVerses(candidate.bookNumber, candidate.chapter, candidate.verse, best.verseEnd);
  if (!en) return { kind: 'ended' }; // only the psalm title was read — no English verse to substitute

  if (best.sim >= VERBATIM_THRESHOLD) {
    const local = resolveLocalVersion(opts.bibleVersion);
    let version: EnglishVersion = local;
    let text = local === 'KJV' ? '' : getEnglishVerseRange(candidate.bookNumber, candidate.chapter, en.start, en.end, local);
    // ESV requested but not built locally (e.g. a Docker deploy without the XML): the API is the next-best source.
    if (!text && (opts.bibleVersion ?? 'ESV').toUpperCase() === 'ESV' && opts.preferEsv !== false) {
      const api = await fetchEsvPassage(book.en, candidate.chapter, en.start, en.end, { apiKey: opts.esvApiKey, signal: opts.signal });
      if (api) { text = api; version = 'ESV'; }
    }
    if (!text) {
      text = getEnglishVerseRange(candidate.bookNumber, candidate.chapter, en.start, en.end, 'KJV');
      version = 'KJV';
    }
    if (!text) return { kind: 'ended' }; // no English text available from any source
    const reference = en.end === en.start
      ? `${book.en} ${candidate.chapter}:${en.start}`
      : `${book.en} ${candidate.chapter}:${en.start}-${en.end}`;
    return { kind: 'verbatim', verseEnd: best.verseEnd, text, version, reference };
  }

  // Paraphrase band: guide the model toward the passage's register from local
  // text only — never an API call for a passage that's merely being alluded to.
  const guidanceVersion = resolveLocalVersion(opts.bibleVersion);
  const guidance = getEnglishVerseRange(candidate.bookNumber, candidate.chapter, en.start, en.end, guidanceVersion);
  if (!guidance) return { kind: 'ended' };
  return { kind: 'paraphrase', verseEnd: best.verseEnd, guidance, version: guidanceVersion };
}
