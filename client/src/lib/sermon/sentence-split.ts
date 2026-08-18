// Dutch sentence-boundary detection for the ingest flush trigger (plan §3).
// The whole flush design depends on this being right: if boundaries are
// missed, text never leaves the PROVISIONAL path; if boundaries are
// hallucinated (splitting inside "Hebr. 11:1" or "d.w.z."), segments get cut
// mid-reference and translation context breaks. See
// tests/unit/sermon-sentence-split.test.ts for the cases this guards.

// Abbreviations and Bible-book short forms whose trailing period must NOT be
// read as a sentence end. Stored lowercase; internal dots (e.g. "d.w.z")
// are kept literally since the token extractor below captures them.
const ABBREVIATIONS = new Set([
  // General Dutch abbreviations
  'bijv', 'dhr', 'mevr', 'dr', 'drs', 'prof', 'ing', 'ir', 'mr', 'vs', 'ds',
  'o.a', 'd.w.z', 'i.p.v', 't.a.v', 'n.a.v', 'e.d', 'etc', 'jl', 'a.s', 'z.g',
  // Bible books, common abbreviated forms (HSV/Statenvertaling style)
  'gen', 'ex', 'lev', 'num', 'deut', 'joz', 'richt', 'sam', 'kon', 'kron',
  'ezr', 'neh', 'est', 'ps', 'spr', 'pred', 'hgl', 'jes', 'jer', 'klaagl',
  'ez', 'dan', 'hos', 'joel', 'joël', 'am', 'ob', 'jona', 'mich', 'nah',
  'hab', 'zef', 'hag', 'zach', 'mal', 'matt', 'mark', 'luk', 'joh', 'hand',
  'rom', 'kor', 'gal', 'ef', 'fil', 'kol', 'th', 'tim', 'tit', 'filem',
  'hebr', 'jak', 'petr', 'jud', 'op',
]);

// Closing punctuation that can trail a sentence-ending mark without
// preventing it from being a boundary — e.g. `zei hij."` ends right after
// the closing quote, not before it.
const CLOSERS = new Set(['"', "'", '’', '”', ')', ']', '»', '›']);

const TERMINATOR_RE = /[.!?…]+/g;

// ASCII letters + Latin-1 Supplement (covers Dutch diacritics: é ë ï ö ü …).
// Deliberately avoids the regex `u` flag / \p{L}: the project's tsconfig has
// no explicit `target`, which defaults tsc to ES3 and rejects unicode flags.
const LETTER_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]/;

/** The run of letters/internal-dots immediately preceding index `punctStart` — used for the abbreviation/initials check. */
function precedingToken(text: string, punctStart: number): string {
  let i = punctStart;
  while (i > 0 && (LETTER_RE.test(text[i - 1]) || text[i - 1] === '.')) i--;
  return text.slice(i, punctStart);
}

/**
 * Indices marking the end of each complete sentence in `text` (the position
 * right after the terminating punctuation and any trailing closing quote —
 * i.e. `text.slice(0, boundary)` is the complete, trimmable sentence).
 */
export function findBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  TERMINATOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERMINATOR_RE.exec(text))) {
    const punctStart = m.index;
    let end = punctStart + m[0].length;
    while (end < text.length && CLOSERS.has(text[end])) end++;

    // A real sentence boundary is followed by whitespace or end-of-string.
    // This alone rules out decimals ("3.5") and the internal dots of
    // multi-dot abbreviations ("d.w.z.") without any special-casing.
    if (end < text.length && !/\s/.test(text[end])) continue;

    const token = precedingToken(text, punctStart);
    if (token) {
      if (ABBREVIATIONS.has(token.toLowerCase())) continue;
      if (token.length === 1 && LETTER_RE.test(token)) continue; // single-letter initial, e.g. "J."
    }

    boundaries.push(end);
  }
  return boundaries;
}

/** Index just past the last complete sentence in `text`, or -1 if there is none. */
export function lastBoundary(text: string): number {
  const boundaries = findBoundaries(text);
  return boundaries.length ? boundaries[boundaries.length - 1] : -1;
}

/** Splits `text` into trimmed, complete sentences plus any trailing partial remainder. */
export function splitSentences(text: string): string[] {
  const boundaries = findBoundaries(text);
  const sentences: string[] = [];
  let start = 0;
  for (const b of boundaries) {
    const piece = text.slice(start, b).trim();
    if (piece) sentences.push(piece);
    start = b;
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}
