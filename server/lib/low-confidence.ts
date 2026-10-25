// Which of the words Whisper was unsure about are worth showing the operator as "check this word".
// The MLX worker reports every word below probability 0.6 (mlx_worker.py's uncertain_words); showing
// them all would be noise — Whisper is a little unsure about many perfectly good words — so only the
// clearly doubtful, word-like ones go to the page, a handful per chunk. Pure and unit-tested.
//
// The threshold is a starting point: `scripts/asr-confidence-check.ts` measures, on a recorded
// service, how often the flagged words are the ones the operator really corrected.

export interface UncertainWord {
  word: string;
  /** Whisper's probability for the word (0-1). */
  p: number;
}

export const LOW_CONFIDENCE_BELOW = 0.4;
export const LOW_CONFIDENCE_MIN_LENGTH = 4;
export const LOW_CONFIDENCE_MAX_PER_CHUNK = 8;

/** Validates the worker's list (never trust a sidecar's JSON shape) — anything malformed is dropped. */
export function parseUncertain(raw: unknown): UncertainWord[] {
  if (!Array.isArray(raw)) return [];
  const out: UncertainWord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { word, p } = item as { word?: unknown; p?: unknown };
    if (typeof word === 'string' && word.length > 0 && word.length <= 60 && typeof p === 'number' && p >= 0 && p <= 1) out.push({ word, p });
  }
  return out.slice(0, 200);
}

export function selectLowConfidenceWords(
  uncertain: UncertainWord[] | undefined,
  opts: { below?: number; minLength?: number; max?: number } = {},
): string[] {
  const below = opts.below ?? LOW_CONFIDENCE_BELOW;
  const minLength = opts.minLength ?? LOW_CONFIDENCE_MIN_LENGTH;
  const max = opts.max ?? LOW_CONFIDENCE_MAX_PER_CHUNK;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of [...(uncertain ?? [])].sort((a, b) => a.p - b.p)) {
    const word = u.word.trim();
    const key = word.toLowerCase();
    if (u.p >= below || word.length < minLength || /\d/.test(word) || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}
