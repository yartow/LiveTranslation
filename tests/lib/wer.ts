// Word Error Rate and Character Error Rate utilities.
// WER = (S + D + I) / N where N = reference word count.

export interface BenchmarkResult {
  fixture: string;
  chunkDurationSecs: number;
  chunkOverlapMs: number;
  useTranscriptContext: boolean;
  wer: number;
  cer: number;
  glossaryHits: number;
  glossaryTotal: number;
  durationMs: number;
  hypothesis: string;
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function charTokenize(text: string): string[] {
  return text.trim().split('').filter(c => c !== ' ');
}

// Standard Levenshtein edit distance (Wagner-Fischer DP).
function editDistance(ref: string[], hyp: string[]): { sub: number; del: number; ins: number } {
  const m = ref.length;
  const n = hyp.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Back-trace to count substitutions, deletions, insertions
  let i = m, j = n, sub = 0, del = 0, ins = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1]) {
      i--; j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      sub++; i--; j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      del++; i--;
    } else {
      ins++; j--;
    }
  }
  return { sub, del, ins };
}

export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, '')   // strip punctuation except apostrophes
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeWER(reference: string, hypothesis: string): number {
  const ref = tokenize(normalizeTranscript(reference));
  const hyp = tokenize(normalizeTranscript(hypothesis));
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const { sub, del, ins } = editDistance(ref, hyp);
  return (sub + del + ins) / ref.length;
}

export function computeCER(reference: string, hypothesis: string): number {
  const ref = charTokenize(normalizeTranscript(reference));
  const hyp = charTokenize(normalizeTranscript(hypothesis));
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const { sub, del, ins } = editDistance(ref, hyp);
  return (sub + del + ins) / ref.length;
}

// Count how many glossary terms appear in the hypothesis.
export function countGlossaryHits(glossary: string[], hypothesis: string): { hits: number; total: number } {
  const normHyp = normalizeTranscript(hypothesis);
  let hits = 0;
  for (const term of glossary) {
    if (normHyp.includes(normalizeTranscript(term))) hits++;
  }
  return { hits, total: glossary.length };
}

export function formatResultsTable(results: BenchmarkResult[]): string {
  const header = [
    'Fixture',
    'ChunkSecs',
    'OverlapMs',
    'Context',
    'WER%',
    'CER%',
    'Gloss%',
    'ms',
  ].join(' | ');
  const sep = header.replace(/[^|]/g, '-').replace(/\|/g, '|');

  const rows = results.map(r => [
    r.fixture.padEnd(20),
    String(r.chunkDurationSecs).padStart(9),
    String(r.chunkOverlapMs).padStart(9),
    (r.useTranscriptContext ? 'yes' : 'no').padStart(7),
    (r.wer * 100).toFixed(1).padStart(5),
    (r.cer * 100).toFixed(1).padStart(5),
    (r.glossaryTotal > 0 ? (r.glossaryHits / r.glossaryTotal * 100).toFixed(0) : 'n/a').padStart(6),
    String(r.durationMs).padStart(6),
  ].join(' | '));

  return [header, sep, ...rows].join('\n');
}
