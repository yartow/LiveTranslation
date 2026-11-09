// Scoring for "show low-confidence words": do the words Whisper doubts turn out to be the words the
// operator corrected? Pure (no files) so it is unit-tested on synthetic data; scripts/asr-confidence-check.ts
// feeds it a recorded session.

export interface Doubt { word: string; p: number }

export interface FlagRecord {
  word: string;
  p: number;
  /** The operator changed or removed this word (it lies inside an edit). */
  edited: boolean;
}

/**
 * Pairs each doubted word of a chunk with its occurrence among the chunk's recognised words, and says
 * whether that occurrence was edited. `tokens` are the chunk's normalised words in order; `edited[i]`
 * says whether token i was edited. A doubted word with no match in the text (the filters or the
 * correction step removed it) is skipped — it can't be shown to the operator either.
 */
export function matchDoubts(
  doubts: Doubt[] | undefined,
  tokens: string[],
  edited: boolean[],
  norm: (w: string) => string,
): FlagRecord[] {
  const claimed = new Set<number>();
  const out: FlagRecord[] = [];
  for (const d of doubts ?? []) {
    const n = norm(d.word);
    if (!n) continue;
    const i = tokens.findIndex((t, k) => t === n && !claimed.has(k));
    if (i < 0) continue;
    claimed.add(i);
    out.push({ word: d.word, p: d.p, edited: !!edited[i] });
  }
  return out;
}

export interface ThresholdScore {
  below: number;
  flagged: number;
  hits: number;
  /** hits / flagged — how often a flagged word really was corrected. */
  precision: number;
  /** hits / all edited words — how many corrections the flags would have pointed at. */
  recall: number;
  /** precision / the overall edit rate: how much better than flagging at random. */
  lift: number;
  f1: number;
}

const MIN_LENGTH = 4;

/** Scores flagging every doubted word below each threshold (same length/digit filters as the app). */
export function scoreThresholds(
  records: FlagRecord[],
  totalEditedWords: number,
  totalWords: number,
  thresholds: number[],
): ThresholdScore[] {
  const baseline = totalWords > 0 ? totalEditedWords / totalWords : 0;
  return thresholds.map(below => {
    const flagged = records.filter(r => r.p < below && r.word.length >= MIN_LENGTH && !/\d/.test(r.word));
    const hits = flagged.filter(r => r.edited).length;
    const precision = flagged.length ? hits / flagged.length : 0;
    const recall = totalEditedWords ? hits / totalEditedWords : 0;
    return {
      below, flagged: flagged.length, hits, precision, recall,
      lift: baseline > 0 ? precision / baseline : 0,
      f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    };
  });
}
