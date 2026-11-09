// Scoring for `npm run eval:translate`. Pure (no files, no network) so it is unit-tested.
//
// chrF is the standard character-n-gram F-score for translation quality (Popović 2015): it rewards a
// translation for sharing character sequences with the reference, so a near-synonym or a small
// inflection costs a little instead of everything (as an exact match would) and, unlike BLEU, it
// behaves on single sentences. 0-100, higher is better. Here: character n-grams 1-6, whitespace
// ignored, precision and recall averaged over n, F-beta with beta = 2 (recall counts double).

const MAX_N = 6;
const BETA = 2;

function ngrams(text: string, n: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i + n <= text.length; i++) {
    const g = text.slice(i, i + n);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** chrF of `hypothesis` against `reference`, 0-100. Two empty texts are identical (100); one empty is 0. */
export function chrF(hypothesis: string, reference: string): number {
  const hyp = hypothesis.replace(/\s+/g, ''), ref = reference.replace(/\s+/g, '');
  if (!hyp && !ref) return 100;
  if (!hyp || !ref) return 0;
  let pSum = 0, rSum = 0, used = 0;
  for (let n = 1; n <= MAX_N; n++) {
    if (hyp.length < n || ref.length < n) break;
    const h = ngrams(hyp, n), r = ngrams(ref, n);
    let overlap = 0, hTotal = 0, rTotal = 0;
    h.forEach(c => { hTotal += c; });
    r.forEach(c => { rTotal += c; });
    h.forEach((c, g) => { overlap += Math.min(c, r.get(g) ?? 0); });
    pSum += overlap / hTotal;
    rSum += overlap / rTotal;
    used++;
  }
  const p = pSum / used, r = rSum / used;
  if (p + r === 0) return 0;
  return (100 * (1 + BETA * BETA) * p * r) / (BETA * BETA * p + r);
}

/** Lowercased, punctuation-free, single-spaced — for "is it the same sentence, give or take punctuation". */
export function normalizeForExact(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function exactMatch(hypothesis: string, reference: string): boolean {
  return normalizeForExact(hypothesis) === normalizeForExact(reference);
}

export interface Summary { mean: number; median: number; p95: number }

/** Mean, median and 95th percentile (nearest rank) of `values`; zeros for none. */
export function summarize(values: number[]): Summary {
  if (!values.length) return { mean: 0, median: 0, p95: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, median: at(0.5), p95: at(0.95) };
}

export interface RunSpec { provider: 'openai' | 'claude' | 'ollama'; model?: string }

/** `openai`, `openai:gpt-4o`, `ollama:qwen2.5:14b` (only the first colon splits) — or null when the provider is unknown. */
export function parseRunSpec(spec: string): RunSpec | null {
  const i = spec.indexOf(':');
  const provider = (i < 0 ? spec : spec.slice(0, i)).trim();
  const model = i < 0 ? undefined : spec.slice(i + 1).trim() || undefined;
  return provider === 'openai' || provider === 'claude' || provider === 'ollama' ? { provider, model } : null;
}
