// Detects Bible references in Dutch sermon text (spec "Bijbelcitaten" §
// Referentie-herkenning) — e.g. "Johannes 3:16", "1 Korinthe 13 vers 4 tot
// 7", "Johannes hoofdstuk 3 vers zestien". Pure and framework-free, runs at
// ingest time on each newly-flushed segment — see useSermonIngest.ts.
//
// Deliberately entirely client-side: it only needs the small book-name table
// below (client/src/lib/sermon/bible-books.generated.ts, built by
// scripts/build-bible-data.ts), never verse text. The resolved
// bookNumber/chapter/verse is what gets sent to the server as a
// `readingCandidate` — the server's scripture.ts (verse lookup + anchor
// matching) trusts that resolution rather than re-parsing the Dutch text
// itself, so book-name recognition exists in exactly one place.
//
// A human fallback covers whatever this parser misses (spec: "Menselijke
// fallback"): the preacher's own reference announcement is never replaced by
// this parser's output (see buildRef's canonicalEn, which is only ever a
// *hint* for how to render the announcement — the source sentence is always
// translated normally too), and a misrecognized/unrecognized reference can
// be corrected by hand in the source pane, which re-parses on every edit.

import { BIBLE_BOOKS, type BibleBook } from './bible-books.generated';

export interface BibleRef {
  bookNumber: number;
  chapter: number;
  /** null = a chapter-only reference ("Johannes 3"), not a verse-level quote. */
  verseStart: number | null;
  verseEnd: number | null;
  /** The exact source substring this reference was parsed from. */
  raw: string;
  /** How the reference reads in English — e.g. "John 3:16", "John 3:16-18", "John 3". A rendering hint for the announcement sentence, NOT a quotation — see the header comment. */
  canonicalEn: string;
}

// ── Dutch number words (1–199, enough for any chapter or verse — Psalm 119
//    is the Bible's longest chapter) ────────────────────────────────────────

const ONES: Record<string, number> = { een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9 };
const TEENS: Record<string, number> = {
  tien: 10, elf: 11, twaalf: 12, dertien: 13, veertien: 14,
  vijftien: 15, zestien: 16, zeventien: 17, achttien: 18, negentien: 19,
};
const TENS: Record<string, number> = {
  twintig: 20, dertig: 30, veertig: 40, vijftig: 50,
  zestig: 60, zeventig: 70, tachtig: 80, negentig: 90,
};

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Parses a single Dutch cardinal-number word ("zestien", "eenentwintig", "honderdnegentien"). Returns null if unrecognized. */
export function parseDutchNumberWord(word: string): number | null {
  const w = stripDiacritics(word.toLowerCase().trim());
  if (!w) return null;
  if (w === 'honderd') return 100;
  if (w.startsWith('honderd')) {
    const rest = parseDutchNumberWord(w.slice('honderd'.length));
    return rest === null ? null : 100 + rest;
  }
  if (w in TEENS) return TEENS[w];
  if (w in TENS) return TENS[w];
  if (w in ONES) return ONES[w];
  // Compound: <ones>en<tens>, e.g. "vijfenzeventig" = vijf + en + zeventig = 75.
  for (const [onesWord, onesVal] of Object.entries(ONES)) {
    const prefix = `${onesWord}en`;
    if (!w.startsWith(prefix)) continue;
    const tensWord = w.slice(prefix.length);
    if (tensWord in TENS) return onesVal + TENS[tensWord];
  }
  return null;
}

/** A token's numeric value whether it's a bare digit string or a Dutch number word. */
function parseNumberToken(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  return parseDutchNumberWord(token);
}

// ── Book-name alias table ───────────────────────────────────────────────────

const ORDINAL_WORDS: Record<number, string> = { 1: 'eerste', 2: 'tweede', 3: 'derde' };

// Hand-picked spoken-form variants not already covered by BIBLE_BOOKS' own
// `nl` (the Statenvertaling's own book name, not always how a modern
// preacher says it). The operator-editable extension point for anything
// this list misses is the glossary CSV's Bijbelboek rows (see
// server/lib/glossary-store.ts's bibleBookAliases) — not yet merged into
// this client-side table (would need a fetch from the server at session
// start); this built-in set covers the common cases in the meantime.
const SPOKEN_VARIANTS: Record<number, string[]> = {
  19: ['psalm'], // Psalmen
  44: ['handelingen'], // Handelingen der apostelen
  46: ['1 korinthe', 'eerste korinthe', '1e korinthe'], // 1 Korinthiers
  47: ['2 korinthe', 'tweede korinthe', '2e korinthe'], // 2 Korintiers
  49: ['efeze'], // Efeziers
  54: ['1 timotheus', 'eerste timotheus', '1e timotheus'],
  55: ['2 timotheus', 'tweede timotheus', '2e timotheus'],
  66: ['openbaring', 'openbaringen'], // Openbaring van Johannes
};

interface AliasEntry { tokens: string[]; bookNumber: number }

function buildAliasTable(books: BibleBook[]): AliasEntry[] {
  const entries: AliasEntry[] = [];
  const add = (name: string, n: number) => {
    const norm = stripDiacritics(name.toLowerCase().trim());
    if (!norm) return;
    entries.push({ tokens: norm.split(/\s+/), bookNumber: n });
  };

  for (const book of books) {
    add(book.nl, book.n);
    add(book.abbr, book.n);
    for (const variant of SPOKEN_VARIANTS[book.n] ?? []) add(variant, book.n);

    // Numbered books ("1 Korinthiers") also get "eerste Korinthiers" / "1e
    // Korinthiers" registered automatically, for every book whose `nl`
    // starts with a bare digit — not just the ones in SPOKEN_VARIANTS above.
    const m = book.nl.match(/^([123]) (.+)$/);
    if (m) {
      const num = Number(m[1]) as 1 | 2 | 3;
      const rest = m[2];
      add(`${ORDINAL_WORDS[num]} ${rest}`, book.n);
      add(`${num}e ${rest}`, book.n);
    }
  }
  // Longest (most tokens) first, so a multi-word alias is preferred over a
  // shorter one that happens to be its prefix.
  return entries.sort((a, b) => b.tokens.length - a.tokens.length);
}

const ALIAS_TABLE = buildAliasTable(BIBLE_BOOKS);
const MAX_BOOK_TOKENS = ALIAS_TABLE.reduce((max, e) => Math.max(max, e.tokens.length), 1);

// ── Tokenizer ────────────────────────────────────────────────────────────

interface Token { text: string; norm: string; start: number; end: number }

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    tokens.push({ text: m[0], norm: stripDiacritics(m[0].toLowerCase()), start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/** Strips leading/trailing punctuation for alias/number matching — but not `:`, which is meaningful inside a fused "3:16" token, or `/`, meaningful inside "t/m". */
function bareWord(norm: string): string {
  return norm.replace(/^[^\w:/]+|[^\w:/]+$/g, '');
}

function matchBookAt(tokens: Token[], i: number): { bookNumber: number; nextIndex: number } | null {
  const maxSpan = Math.min(MAX_BOOK_TOKENS, tokens.length - i);
  for (let span = maxSpan; span >= 1; span--) {
    const candidate = tokens.slice(i, i + span).map(t => bareWord(t.norm)).join(' ');
    const hit = ALIAS_TABLE.find(e => e.tokens.join(' ') === candidate);
    if (hit) return { bookNumber: hit.bookNumber, nextIndex: i + span };
  }
  return null;
}

/** chapter[:verse[-verseEnd]] fused onto one token, e.g. "3:16" or "3:16-18". */
function parseInlineChapterVerse(token: string): { chapter: number; verseStart: number | null; verseEnd: number | null } | null {
  const m = bareWord(token).match(/^(\d+):(\d+)(?:[-–](\d+))?$/);
  if (!m) return null;
  return { chapter: Number(m[1]), verseStart: Number(m[2]), verseEnd: m[3] ? Number(m[3]) : null };
}

const VERSE_WORD = new Set(['vers', 'vs']);
const RANGE_WORD = new Set(['tot', 't/m']);

function buildRef(
  bookNumber: number, chapter: number, verseStart: number | null, verseEnd: number | null,
  text: string, start: number, end: number,
): BibleRef | null {
  const book = BIBLE_BOOKS.find(b => b.n === bookNumber);
  if (!book) return null;
  const verseSuffix = verseStart === null ? '' : verseEnd !== null ? `:${verseStart}-${verseEnd}` : `:${verseStart}`;
  return { bookNumber, chapter, verseStart, verseEnd, raw: text.slice(start, end), canonicalEn: `${book.en} ${chapter}${verseSuffix}` };
}

/**
 * Finds the first Bible reference in `text` starting at or after `fromIndex`
 * (a character offset — callers scanning for a second reference in the same
 * text pass the end of the first). Recognizes "Johannes 3:16", "Johannes 3
 * vers 16"/"vs 16", "Johannes hoofdstuk 3 vers 16", numbered/ordinal books
 * ("1 Korinthe", "eerste Korinthe", "1e Korinthe"), spelled-out numbers
 * ("Johannes drie vers zestien"), verse ranges ("16-18", "16 tot 18", "16
 * t/m 18", "16 en 17"), and chapter-only references ("Johannes 3" —
 * verseStart/verseEnd both null).
 */
export function findBibleRef(text: string, fromIndex = 0): BibleRef | null {
  const tokens = tokenize(text).filter(t => t.end > fromIndex);

  for (let i = 0; i < tokens.length; i++) {
    const bookMatch = matchBookAt(tokens, i);
    if (!bookMatch) continue;

    let j = bookMatch.nextIndex;
    if (j >= tokens.length) continue;

    if (bareWord(tokens[j].norm) === 'hoofdstuk') j++;
    if (j >= tokens.length) continue;

    const inline = parseInlineChapterVerse(tokens[j].text);
    if (inline) {
      return buildRef(bookMatch.bookNumber, inline.chapter, inline.verseStart, inline.verseEnd, text, tokens[i].start, tokens[j].end);
    }

    const chapter = parseNumberToken(bareWord(tokens[j].norm));
    if (chapter === null) continue; // book name used in ordinary prose, not a reference
    let endTokenIndex = j;
    j++;

    let verseStart: number | null = null;
    let verseEnd: number | null = null;
    if (j < tokens.length && VERSE_WORD.has(bareWord(tokens[j].norm))) {
      const verseTokenIndex = j + 1;
      if (verseTokenIndex < tokens.length) {
        const verseTokenText = bareWord(tokens[verseTokenIndex].norm);
        const fusedRange = verseTokenText.match(/^(\d+)-(\d+)$/);
        if (fusedRange) {
          verseStart = Number(fusedRange[1]);
          verseEnd = Number(fusedRange[2]);
          endTokenIndex = verseTokenIndex;
        } else {
          const v = parseNumberToken(verseTokenText);
          if (v !== null) {
            verseStart = v;
            endTokenIndex = verseTokenIndex;
            const afterVerse = verseTokenIndex + 1;
            if (afterVerse < tokens.length) {
              const rangeWord = bareWord(tokens[afterVerse].norm);
              if (rangeWord === 'en' || RANGE_WORD.has(rangeWord)) {
                const endValIndex = afterVerse + 1;
                const endVal = endValIndex < tokens.length ? parseNumberToken(bareWord(tokens[endValIndex].norm)) : null;
                if (endVal !== null) { verseEnd = endVal; endTokenIndex = endValIndex; }
              }
            }
          }
        }
      }
    }

    return buildRef(bookMatch.bookNumber, chapter, verseStart, verseEnd, text, tokens[i].start, tokens[endTokenIndex].end);
  }

  return null;
}

/** All references found in `text`, left to right, non-overlapping. */
export function findAllBibleRefs(text: string): BibleRef[] {
  const refs: BibleRef[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const ref = findBibleRef(text, searchFrom);
    if (!ref) break;
    refs.push(ref);
    const idx = text.indexOf(ref.raw, searchFrom);
    searchFrom = idx === -1 ? text.length : idx + ref.raw.length;
  }
  return refs;
}
