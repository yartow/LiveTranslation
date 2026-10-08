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
  /** Hallucinated caption artifacts still present in the hypothesis (see countAsrArtifacts). */
  artifacts: number;
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

// ── Fairer scoring for Dutch ─────────────────────────────────────────────────
// Plain WER counts "vers 5" vs "vers vijf" and "goeie" vs "goede" as errors,
// which says nothing about transcription quality. normalizeForScoring()
// removes those differences from BOTH sides before comparing:
//  - digits -> Dutch number words (0-999; "3:16" -> "drie zestien"),
//  - diacritics, apostrophes and hyphens (d'r -> dr, tweeëntwintig == tweeentwintig),
//  - spoken fillers (ehm, eh, ...): references contain them, Whisper omits them,
//    and the app's correction step removes them anyway,
//  - an optional alias list of genuinely-equivalent spellings.

const UNITS = ['nul', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen', 'tien',
  'elf', 'twaalf', 'dertien', 'veertien', 'vijftien', 'zestien', 'zeventien', 'achttien', 'negentien'];
const TENS = ['', '', 'twintig', 'dertig', 'veertig', 'vijftig', 'zestig', 'zeventig', 'tachtig', 'negentig'];

/** Dutch number word for 0-999, written as one compound the way Dutch spells it ("eenentwintig", "honderdtwintig"). */
export function dutchNumberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) throw new RangeError(`dutchNumberWords: ${n} out of range`);
  if (n < 20) return UNITS[n];
  if (n < 100) {
    const unit = n % 10;
    const tens = TENS[Math.floor(n / 10)];
    if (unit === 0) return tens;
    const u = UNITS[unit];
    return `${u}${u.endsWith('e') ? 'ën' : 'en'}${tens}`;
  }
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = hundreds === 1 ? 'honderd' : `${UNITS[hundreds]}honderd`;
  return rest === 0 ? head : `${head}${dutchNumberWords(rest)}`;
}

const FILLER_RE = /\b(?:ehm|eh|euh|uh|um|hm|hmm)\b/g;

function stripDiacriticsForScoring(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Alias list: one `variant = canonical` pair per line, `#` comments allowed. */
export function parseAliases(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/#.*/, '').trim();
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const variant = normalizeForScoring(trimmed.slice(0, eq));
    const canonical = normalizeForScoring(trimmed.slice(eq + 1));
    if (variant && canonical && variant !== canonical) pairs.push([variant, canonical]);
  }
  // Longest variant first so a phrase alias wins over a word inside it.
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

export function normalizeForScoring(text: string, aliases: Array<[string, string]> = []): string {
  let t = text.toLowerCase();
  // Digits first, padded with spaces, before punctuation removal would fuse "3:16" into "316".
  t = t.replace(/\d+/g, (m) => (m.length <= 3 ? ` ${dutchNumberWords(Number(m))} ` : m));
  t = stripDiacriticsForScoring(t)
    .replace(/'/g, '')
    .replace(/[-–—]/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(FILLER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [variant, canonical] of aliases) {
    t = ` ${t} `.replace(new RegExp(` ${variant} `, 'g'), ` ${canonical} `).trim();
  }
  return t.replace(/\s+/g, ' ');
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

// Counts hallucinated caption artifacts left in a transcript — the metric the
// "Muziek" problem is judged by. WER alone barely moves for a few stray words.
const ARTIFACT_COUNT_RE = /\b(?:muziek|music|applaus|applause|gelach|laughter|ondertitel\w*|subtitle\w*|amara)\b|[♪♫]|\[[^\]]{1,40}\]|\*{2,}|tv gelderland/gi;

export function countAsrArtifacts(text: string): number {
  return (text.match(ARTIFACT_COUNT_RE) ?? []).length;
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
    'Artif.',
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
    String(r.artifacts).padStart(6),
    String(r.durationMs).padStart(6),
  ].join(' | '));

  return [header, sep, ...rows].join('\n');
}
