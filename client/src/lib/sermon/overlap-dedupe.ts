// Chunk-boundary overlap dedupe (plan §3 "Chunk-overlap duplication").
//
// Sermon mode forces chunkOverlapMs=0 and VAD chunking so cuts land between
// words, but that alone doesn't guarantee zero restated words at a chunk
// boundary — ASR can still repeat the tail of one chunk at the head of the
// next. This is a belt-and-braces string-level cleanup: find the longest
// run of trailing words in `prevTail` that reappears at the start of
// `incoming`, and drop that reappearing prefix from `incoming`.
//
// Deliberately conservative: a match of a single short word is NOT treated
// as overlap, because that's indistinguishable from the speaker genuinely
// repeating a short word ("heel, heel goed") — see the test suite.

const LEADING_PUNCT_RE = /^[.,!?;:"'“”‘’«»()[\]{}…]+/;
const TRAILING_PUNCT_RE = /[.,!?;:"'“”‘’«»()[\]{}…]+$/;
const MAX_COMPARE_TOKENS = 8;
const MIN_SINGLE_TOKEN_LEN = 5;

interface Token {
  core: string;
  normalized: string;
  coreEnd: number; // offset in the ORIGINAL string, right after the token's word core (before trailing punctuation)
}

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Whitespace-delimited tokens, each with leading/trailing punctuation stripped for comparison, but original offsets preserved so we can cut the source string precisely. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const rawStart = m.index;
    const leadLen = raw.match(LEADING_PUNCT_RE)?.[0].length ?? 0;
    const withoutLead = raw.slice(leadLen);
    const trailLen = withoutLead.match(TRAILING_PUNCT_RE)?.[0].length ?? 0;
    const core = withoutLead.slice(0, withoutLead.length - trailLen);
    if (!core) continue;
    const coreStart = rawStart + leadLen;
    tokens.push({ core, normalized: stripDiacritics(core.toLowerCase()), coreEnd: coreStart + core.length });
  }
  return tokens;
}

/**
 * Drops the prefix of `incoming` that duplicates the tail of `prevTail`, if
 * any. Returns `incoming` unchanged when no qualifying overlap is found.
 */
export function dedupeOverlap(prevTail: string, incoming: string): string {
  if (!prevTail.trim() || !incoming.trim()) return incoming;

  const prevTokens = tokenize(prevTail);
  const inTokens = tokenize(incoming);
  const maxK = Math.min(MAX_COMPARE_TOKENS, prevTokens.length, inTokens.length);

  for (let k = maxK; k >= 1; k--) {
    const prevSlice = prevTokens.slice(prevTokens.length - k);
    const inSlice = inTokens.slice(0, k);
    const isMatch = prevSlice.every((t, i) => t.normalized === inSlice[i].normalized);
    if (!isMatch) continue;

    const lastMatched = inSlice[inSlice.length - 1];
    if (k === 1 && lastMatched.core.length < MIN_SINGLE_TOKEN_LEN) continue;

    return incoming.slice(lastMatched.coreEnd);
  }

  return incoming;
}

/** Last ~80 characters of `text`, used to seed the next dedupe comparison. */
export function tail80(text: string): string {
  return text.slice(-80);
}
