// Normalized word-bigram Dice coefficient — used by scripture.ts to decide
// whether spoken text matches a Bible verse closely enough to be treated as
// a verbatim reading (spec "Bijbelcitaten" section "Waar eindigt het
// citaat?"). Deliberately simple: this is a coarse verbatim-vs-paraphrase
// signal, not a diff tool. tests/lib/wer.ts has a separate Levenshtein-based
// word-error-rate helper for benchmarking ASR accuracy in tests — different
// purpose (offline test scoring vs. an online per-segment decision) and a
// different cost profile, so it isn't reused here.

const COMBINING_DIACRITICS_RE = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');

function normalize(text: string): string {
  return text
    .normalize('NFD').replace(COMBINING_DIACRITICS_RE, '') // strip diacritics
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(text: string): Set<string> {
  const words = normalize(text).split(' ').filter(Boolean);
  if (words.length === 0) return new Set();
  if (words.length === 1) return new Set(words); // unigram fallback so a one-word text isn't unconditionally 0-similarity
  const grams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) grams.add(`${words[i]} ${words[i + 1]}`);
  return grams;
}

/** Dice coefficient (2 * |A intersect B| / (|A|+|B|)) over word-bigrams, 0-1. Symmetric, cheap, and tolerant of minor ASR/correction noise (dropped articles, punctuation differences). */
export function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const g of Array.from(A)) if (B.has(g)) intersection++;
  return (2 * intersection) / (A.size + B.size);
}
