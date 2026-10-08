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

import { spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename, extname } from 'path';
import { SpeechGate, windowMeanAbs } from '../client/src/lib/chunk-based-transcription';
import { computeWER, computeCER, countAsrArtifacts, normalizeForScoring, parseAliases } from '../tests/lib/wer';

const ROOT = join(import.meta.dirname, '..');
const AUDIO_DIR = join(ROOT, 'tests/fixtures/audio');
const REF_DIR = join(ROOT, 'tests/fixtures/reference');
const RATE = 16_000;
const FRAME = 1365; // ~85 ms at 16 kHz, matching the browser's ~85 ms frames at 48 kHz
const FRAME_MS = (FRAME / RATE) * 1000;
const GATE_WINDOW_MS = 20;
const GATE_WINDOW = Math.round((GATE_WINDOW_MS / 1000) * RATE);
const LANGUAGE = 'nl';

interface Setup {
  name: string;
  /** null = one single pass over the whole clip (the upper bound). */
  chunking: null | { vad: boolean; minMs: number; silenceMs: number; maxMs: number };
  /** Feed the previous chunks' text back to Whisper as its prompt. */
  context: boolean;
}

const SETUPS: Setup[] = [
  { name: 'whole-clip (upper bound)', chunking: null, context: false },
  { name: 'old sermon (1s min, 1.1s pause, 7.5s cap, no ctx)', chunking: { vad: true, minMs: 1000, silenceMs: 1100, maxMs: 7500 }, context: false },
  { name: 'fixed 5s chunks, no ctx', chunking: { vad: false, minMs: 5000, silenceMs: 0, maxMs: 5000 }, context: false },
  { name: 'new sermon, no ctx (6s min, 0.7s pause, 20s cap)', chunking: { vad: true, minMs: 6000, silenceMs: 700, maxMs: 20000 }, context: false },
  { name: 'new sermon + ctx (current app)', chunking: { vad: true, minMs: 6000, silenceMs: 700, maxMs: 20000 }, context: true },
  { name: 'faster: 4s min + ctx', chunking: { vad: true, minMs: 4000, silenceMs: 700, maxMs: 15000 }, context: true },
  { name: 'faster: 3s min + ctx', chunking: { vad: true, minMs: 3000, silenceMs: 700, maxMs: 15000 }, context: true },
];

// ── audio helpers ────────────────────────────────────────────────────────────

function decodeTo16kMono(path: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-']);
    const parts: Buffer[] = [];
    let err = '';
    ff.stdout.on('data', (d: Buffer) => parts.push(d));
    ff.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed (${code}): ${err}`));
      const buf = Buffer.concat(parts);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice());
    });
  });
}

function wavBuffer(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ── chunk planner: mirrors ChunkBasedTranscription.onaudioprocess/commitChunk ─

interface Chunk { start: number; end: number }

export function planChunks(samples: Float32Array, c: NonNullable<Setup['chunking']>): { chunks: Chunk[]; discarded: number } {
  const chunks: Chunk[] = [];
  let discarded = 0;
  let chunkStart = 0;
  const gate = new SpeechGate();
  let vadSilenceMs = 0;
  const minSamples = Math.round((c.minMs / 1000) * RATE);
  const maxSamples = Math.max(minSamples, Math.round((c.maxMs / 1000) * RATE));

  const commit = (end: number) => {
    if (end <= chunkStart) return;
    if (gate.keepChunk()) chunks.push({ start: chunkStart, end });
    else discarded++;
    chunkStart = end;
    gate.resetChunk();
    vadSilenceMs = 0;
  };

  for (let pos = 0; pos + FRAME <= samples.length; pos += FRAME) {
    let sum = 0;
    for (let i = pos; i < pos + FRAME; i++) sum += Math.abs(samples[i]);
    const meanAbs = sum / FRAME;

    const silent = meanAbs < Math.max(0.005, gate.noiseFloor * 2.0);
    vadSilenceMs = silent ? vadSilenceMs + FRAME_MS : 0;
    // Same 20 ms-window gate as the browser (see SpeechGate).
    for (const w of windowMeanAbs(samples.subarray(pos, pos + FRAME), GATE_WINDOW)) gate.push(w, GATE_WINDOW_MS);

    const end = pos + FRAME;
    const accumulated = end - chunkStart;
    if (c.vad && vadSilenceMs >= c.silenceMs && accumulated >= minSamples) commit(end);
    else if (accumulated >= maxSamples) commit(end);
  }
  const tail = samples.length - chunkStart;
  if (tail >= 100) commit(samples.length);
  return { chunks, discarded };
}

// ── scoring ──────────────────────────────────────────────────────────────────

interface Row {
  clip: string; setup: string; chunks: number; discarded: number; avgChunkSecs: number;
  werRaw: number; werFiltered: number; cerFiltered: number;
  artifactsRaw: number; artifactsFiltered: number; ms: number; hypothesis: string;
}

// ── CLI / glossary ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const out = { positional: [] as string[], glossary: undefined as string | undefined, glossaryTerms: 15, runs: 1, setup: undefined as string | undefined, verbose: false, guard: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--glossary') out.glossary = argv[++i];
    else if (argv[i] === '--glossary-terms') out.glossaryTerms = Math.max(1, Number(argv[++i]) || 15);
    else if (argv[i] === '--runs') out.runs = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === '--setup') out.setup = argv[++i];
    else if (argv[i] === '--verbose') out.verbose = true;
    else if (argv[i] === '--no-guard') out.guard = false;
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
  const { transcribeWithMlx } = await import('../server/lib/mlx-whisper');
  const { buildWhisperPrompt } = await import('../server/lib/openai');
  const { isAsrArtifact, stripAsrArtifacts } = await import('../server/lib/asr-artifacts');
  const { transcribeGuarded } = await import('../server/lib/whisper-guard');

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
          : { chunks: [{ start: 0, end: samples.length }], discarded: 0 };

        const rawParts: string[] = [];
        const filteredParts: string[] = [];
        let prev = '';
        for (let i = 0; i < planned.chunks.length; i++) {
          const { start, end } = planned.chunks[i];
          const path = join(work, `${stem}-${i}.wav`);
          writeFileSync(path, wavBuffer(samples.subarray(start, end)));
          const prompt = buildWhisperPrompt(glossaryText, undefined, setup.context ? prev || undefined : undefined, LANGUAGE, args.glossaryTerms);
          const guarded = await transcribeGuarded(
            (usePrompt) => transcribeWithMlx(path, LANGUAGE, usePrompt ? prompt : undefined),
            args.guard && !!prompt, (end - start) / RATE,
          );
          const raw = guarded.text.trim();
          if (args.verbose && guarded.retried) console.log('      (guard: retried without the prompt)');
          rmSync(path, { force: true });
          if (args.verbose) console.log(`      [${(start / RATE).toFixed(1)}-${(end / RATE).toFixed(1)}s] prompt=${JSON.stringify(prompt ?? null)}\n        -> ${JSON.stringify(raw)}`);
          if (raw) rawParts.push(raw);
          // Same order as server/lib/chunk-transcription.ts
          const cleaned = !raw || isAsrArtifact(raw, LANGUAGE) ? '' : stripAsrArtifacts(raw, LANGUAGE);
          if (cleaned) { filteredParts.push(cleaned); prev = (prev + ' ' + cleaned).slice(-300); }
        }

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
        };
        rows.push(row);
        console.log(`  ${setup.name.padEnd(52)} chunks=${String(row.chunks).padStart(2)} avg=${row.avgChunkSecs.toFixed(1).padStart(4)}s  WER ${(row.werRaw * 100).toFixed(1).padStart(5)}% -> ${(row.werFiltered * 100).toFixed(1).padStart(5)}% filtered  artifacts ${row.artifactsRaw}->${row.artifactsFiltered}  (${(row.ms / 1000).toFixed(1)}s)`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Summary: mean over clips per setup
  console.log('\n── Mean over clips ─────────────────────────────────────────────────────────');
  console.log(`(${args.runs} run${args.runs > 1 ? 's' : ''} per clip)`);
  console.log('setup'.padEnd(54) + 'WER%'.padStart(7) + 'CER%'.padStart(7) + 'artif.'.padStart(8) + 'chunks'.padStart(8));
  for (const setup of activeSetups) {
    const r = rows.filter(x => x.setup === setup.name);
    if (!r.length) continue;
    const mean = (f: (x: Row) => number) => r.reduce((n, x) => n + f(x), 0) / r.length;
    console.log(
      setup.name.padEnd(54) + (mean(x => x.werFiltered) * 100).toFixed(1).padStart(7) +
      (mean(x => x.cerFiltered) * 100).toFixed(1).padStart(7) + mean(x => x.artifactsFiltered).toFixed(1).padStart(8) +
      mean(x => x.chunks).toFixed(1).padStart(8),
    );
  }

  const out = join(ROOT, 'tests/fixtures', `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`\nSaved ${out}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
