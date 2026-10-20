// Local ASR evaluation: runs the fixture clips (tests/fixtures/audio/*) through
// the REAL local Whisper (the mlx sidecar) under several chunking setups and
// scores each against its reference transcript (tests/fixtures/reference/*.txt).
//
//   npm run eval:asr                      # all clips, all setups
//   npm run eval:asr -- sermon1-60s       # only clips whose name contains this
//   npm run eval:asr -- --glossary data/preek_woordenlijst_NL_EN_clean.csv --glossary-terms 30
//
// Options:
//   <name>                  only clips whose filename contains <name>
//   --glossary <file>       give Whisper glossary terms in its prompt: a .csv in the app's
//                           glossary format (Dutch column) or a .txt with one term per line
//                           (`term = translation` allowed). Default: none.
//   --glossary-terms <n>    how many terms go in the prompt (default 15 = the app's cap)
//   --runs <n>              repeat every setup n times and average (Whisper is not
//                           deterministic; single runs vary by several WER points)
//   --no-guard              disable the truncation guard (whisper-guard.ts) to see what it saves
//   --opts <json>           worker decode overrides, e.g. '{"hallucination_silence_threshold":null,"no_speech_threshold":null,"segment_filter":false}'
//                           (see DEFAULT_OPTS in server/python/mlx_worker.py) — A/B a fix against the defaults
//   --verbose               print every chunk's time range, prompt and raw Whisper output
//   --setup <text>          only setups whose name contains <text> (e.g. "current app")
//
// Scoring ignores spelling-only differences (digits vs words, diacritics, fillers, and the
// pairs in tests/fixtures/spelling-variants.txt) -- see normalizeForScoring in tests/lib/wer.ts.
//
// Why this exists instead of tests/regression/wer-benchmark.test.ts: that test
// goes through POST /api/transcribe (OpenAI key + running server), is hardwired
// to English, and never exercises the chunking. This one answers "does chunk
// size/context change accuracy and hallucinations?" on the local engine.
//
// What it simulates, faithfully: the browser's speech-presence gate and VAD cut
// logic (it imports SpeechGate/windowMeanAbs from the
// client), then the server's per-chunk path: Whisper (with the same prompt
// builder) -> isAsrArtifact -> stripAsrArtifacts. What it does NOT include: the
// LLM correction step (needs API keys), the overlap dedupe, and the browser's
// own mic processing (the clips are already-recorded audio).

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename, extname } from 'path';
import { RATE, decodeTo16kMono, planChunks, transcribePlannedChunks, type ChunkingSetup } from './lib/asr-chunks';
import { SERMON_VAD_SILENCE_MS, SERMON_MIN_CHUNK_MS, SERMON_MAX_CHUNK_MS } from '../client/src/lib/sermon/chunk-limits';
import { computeWER, computeCER, countAsrArtifacts, deletionRuns, normalizeForScoring, parseAliases } from '../tests/lib/wer';

const ROOT = join(import.meta.dirname, '..');
const AUDIO_DIR = join(ROOT, 'tests/fixtures/audio');
const REF_DIR = join(ROOT, 'tests/fixtures/reference');
const LANGUAGE = 'nl';

interface Setup {
  name: string;
  /** null = one single pass over the whole clip (the upper bound). */
  chunking: null | ChunkingSetup;
  /** Feed the previous chunks' text back to Whisper as its prompt. */
  context: boolean;
}

const SETUPS: Setup[] = [
  { name: 'whole-clip (upper bound)', chunking: null, context: false },
  { name: 'old sermon (1s min, 1.1s pause, 7.5s cap, no ctx)', chunking: { vad: true, minMs: 1000, silenceMs: 1100, maxMs: 7500 }, context: false },
  { name: 'fixed 5s chunks, no ctx', chunking: { vad: false, minMs: 5000, silenceMs: 0, maxMs: 5000 }, context: false },
  { name: 'new sermon, no ctx (6s min, 0.7s pause, 20s cap)', chunking: { vad: true, minMs: 6000, silenceMs: 700, maxMs: 20000 }, context: false },
  { name: 'Sunday 2026-10-11 app (6s min, 20s cap) + ctx', chunking: { vad: true, minMs: 6000, silenceMs: 700, maxMs: 20000 }, context: true },
  { name: 'current app (4s min, 15s cap) + ctx', chunking: { vad: true, minMs: SERMON_MIN_CHUNK_MS, silenceMs: SERMON_VAD_SILENCE_MS, maxMs: SERMON_MAX_CHUNK_MS }, context: true },
  { name: 'faster: 3s min + ctx', chunking: { vad: true, minMs: 3000, silenceMs: 700, maxMs: 15000 }, context: true },
];

// ── scoring ──────────────────────────────────────────────────────────────────

interface Row {
  clip: string; setup: string; chunks: number; discarded: number; avgChunkSecs: number;
  werRaw: number; werFiltered: number; cerFiltered: number;
  artifactsRaw: number; artifactsFiltered: number; ms: number; hypothesis: string;
  /** Longest run of reference words missing from the hypothesis, and how many runs are >= 8 words (~3 s). */
  maxGap: number; gaps8: number;
  /** Seconds the worker reported as uncovered by any kept segment (includes genuine pauses). */
  uncoveredSecs: number;
}

function gapStats(runs: number[]): { maxGap: number; gaps8: number } {
  return { maxGap: runs.length ? Math.max(...runs) : 0, gaps8: runs.filter(n => n >= 8).length };
}

// ── CLI / glossary ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const out = { positional: [] as string[], glossary: undefined as string | undefined, glossaryTerms: 15, runs: 1, setup: undefined as string | undefined, verbose: false, guard: true, opts: undefined as Record<string, unknown> | undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--glossary') out.glossary = argv[++i];
    else if (argv[i] === '--glossary-terms') out.glossaryTerms = Math.max(1, Number(argv[++i]) || 15);
    else if (argv[i] === '--runs') out.runs = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === '--setup') out.setup = argv[++i];
    else if (argv[i] === '--verbose') out.verbose = true;
    else if (argv[i] === '--no-guard') out.guard = false;
    else if (argv[i] === '--opts') out.opts = JSON.parse(argv[++i]);
    else out.positional.push(argv[i]);
  }
  return out;
}

// Priority when only N terms fit in the prompt: proper names and book names are what
// Whisper gets wrong most (it has never seen "Filippenzen" spelled that way); generic
// theological vocabulary is usually transcribed fine already.
const CATEGORY_PRIORITY = ['Eigennaam', 'Bijbelboek', 'Plaatsnaam'];

async function loadGlossaryText(path: string, maxTerms: number): Promise<string> {
  const abs = join(process.cwd(), path);
  const raw = readFileSync(existsSync(abs) ? abs : path, 'utf8');
  if (!/\.csv$/i.test(path)) return raw.split('\n').map(l => l.trim()).filter(Boolean).slice(0, maxTerms).join('\n');
  const { parseGlossaryCsv } = await import('../server/lib/glossary-parse');
  const rows = [...parseGlossaryCsv(raw).fixed, ...parseGlossaryCsv(raw).context];
  const rank = (c: string) => { const i = CATEGORY_PRIORITY.indexOf(c); return i === -1 ? CATEGORY_PRIORITY.length : i; };
  return [...rows].sort((a, b) => rank(a.category) - rank(b.category)).map(r => r.nl).filter(Boolean).slice(0, maxTerms).join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* optional */ }
  // openai.ts builds a client at import; the key is never used here.
  process.env.OPENAI_API_KEY ??= 'unused-by-asr-eval';

  const args = parseArgs(process.argv.slice(2));
  const filter = args.positional[0];
  const aliasPath = join(ROOT, 'tests/fixtures/spelling-variants.txt');
  const aliases = existsSync(aliasPath) ? parseAliases(readFileSync(aliasPath, 'utf8')) : [];
  const score = (t: string) => normalizeForScoring(t, aliases);
  const glossaryText = args.glossary ? await loadGlossaryText(args.glossary, args.glossaryTerms) : undefined;
  if (glossaryText) console.log(`Glossary: ${glossaryText.split('\n').length} terms from ${args.glossary} -> Whisper prompt (cap ${args.glossaryTerms})`);
  const clips = existsSync(AUDIO_DIR)
    ? readdirSync(AUDIO_DIR).filter(f => /\.(m4a|mp3|wav|mp4|ogg|flac)$/i.test(f)).filter(f => !filter || f.includes(filter)).sort()
    : [];
  if (clips.length === 0) { console.error(`No clips found in ${AUDIO_DIR}${filter ? ` matching "${filter}"` : ''}`); process.exit(1); }

  const activeSetups = SETUPS.filter(x => !args.setup || x.name.includes(args.setup));
  if (activeSetups.length === 0) { console.error(`No setup matches "${args.setup}"`); process.exit(1); }
  const work = mkdtempSync(join(tmpdir(), 'asr-eval-'));
  const rows: Row[] = [];

  try {
    for (const file of clips) {
      const stem = basename(file, extname(file));
      const refPath = join(REF_DIR, `${stem}.txt`);
      if (!existsSync(refPath)) { console.warn(`skip ${file}: no reference ${refPath}`); continue; }
      const reference = readFileSync(refPath, 'utf8').trim();
      const samples = await decodeTo16kMono(join(AUDIO_DIR, file));
      console.log(`\n${stem}: ${(samples.length / RATE).toFixed(1)}s, ${reference.split(/\s+/).length} reference words`);

      for (const setup of activeSetups) for (let run = 0; run < args.runs; run++) {
        const t0 = Date.now();
        const planned = setup.chunking
          ? planChunks(samples, setup.chunking)
          : { chunks: [{ start: 0, end: samples.length, cut: 'stop' as const }], discarded: 0 };

        const results = await transcribePlannedChunks(samples, planned.chunks, {
          language: LANGUAGE, context: setup.context, glossaryText, glossaryTerms: args.glossaryTerms,
          guard: args.guard, opts: args.opts, workDir: work,
          onChunk: (_i, r) => {
            if (!args.verbose) return;
            if (r.guardRetried) console.log('      (guard: retried without the prompt)');
            console.log(`      [${(r.chunk.start / RATE).toFixed(1)}-${(r.chunk.end / RATE).toFixed(1)}s] prompt=${JSON.stringify(r.prompt ?? null)}\n        -> ${JSON.stringify(r.raw)}`);
          },
        });
        const rawParts = results.map(r => r.raw).filter(Boolean);
        const filteredParts = results.map(r => r.cleaned).filter(Boolean);
        const uncoveredSecs = results.reduce((n, r) => {
          const last = r.diags[r.diags.length - 1]?.diag; // same as before: the last attempt's diag
          return n + (last?.uncovered ?? []).reduce((m, [x, y]) => m + (y - x), 0);
        }, 0);

        const rawText = rawParts.join(' ');
        const filtered = filteredParts.join(' ');
        const totalSecs = planned.chunks.reduce((n, c) => n + (c.end - c.start), 0) / RATE;
        const row: Row = {
          clip: stem, setup: setup.name, chunks: planned.chunks.length, discarded: planned.discarded,
          avgChunkSecs: planned.chunks.length ? totalSecs / planned.chunks.length : 0,
          werRaw: computeWER(score(reference), score(rawText)),
          werFiltered: computeWER(score(reference), score(filtered)),
          cerFiltered: computeCER(score(reference), score(filtered)),
          artifactsRaw: countAsrArtifacts(rawText), artifactsFiltered: countAsrArtifacts(filtered),
          ms: Date.now() - t0, hypothesis: filtered,
          ...gapStats(deletionRuns(score(reference), score(filtered))), uncoveredSecs,
        };
        rows.push(row);
        console.log(`  ${setup.name.padEnd(52)} chunks=${String(row.chunks).padStart(2)} avg=${row.avgChunkSecs.toFixed(1).padStart(4)}s  WER ${(row.werRaw * 100).toFixed(1).padStart(5)}% -> ${(row.werFiltered * 100).toFixed(1).padStart(5)}% filtered  artifacts ${row.artifactsRaw}->${row.artifactsFiltered}  maxGap ${String(row.maxGap).padStart(2)}w gaps8+ ${row.gaps8}  (${(row.ms / 1000).toFixed(1)}s)`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Summary: mean over clips per setup
  console.log('\n── Mean over clips ─────────────────────────────────────────────────────────');
  console.log(`(${args.runs} run${args.runs > 1 ? 's' : ''} per clip)`);
  console.log('setup'.padEnd(54) + 'WER%'.padStart(7) + 'CER%'.padStart(7) + 'artif.'.padStart(8) + 'chunks'.padStart(8) + 'maxGap'.padStart(8) + 'gaps8+'.padStart(8));
  for (const setup of activeSetups) {
    const r = rows.filter(x => x.setup === setup.name);
    if (!r.length) continue;
    const mean = (f: (x: Row) => number) => r.reduce((n, x) => n + f(x), 0) / r.length;
    console.log(
      setup.name.padEnd(54) + (mean(x => x.werFiltered) * 100).toFixed(1).padStart(7) +
      (mean(x => x.cerFiltered) * 100).toFixed(1).padStart(7) + mean(x => x.artifactsFiltered).toFixed(1).padStart(8) +
      mean(x => x.chunks).toFixed(1).padStart(8) + Math.max(...r.map(x => x.maxGap)).toString().padStart(8) +
      r.reduce((n, x) => n + x.gaps8, 0).toString().padStart(8),
    );
  }

  const out = join(ROOT, 'tests/fixtures', `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`\nSaved ${out}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
