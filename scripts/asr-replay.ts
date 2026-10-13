// Replays a recorded session through TODAY's chunking + per-chunk Whisper path and writes
// the result in the same archive format as ASR_DEBUG_DIR, so scripts/asr-compare.ts can
// diff it against the original recording.
//
//   npx tsx scripts/asr-session-audio.ts data/asr-debug/<session>          # builds full.wav
//   npx tsx scripts/asr-replay.ts data/asr-debug/<session>/full.wav
//   npx tsx scripts/asr-replay.ts <audio> [--glossary <csv|txt>] [--glossary-terms n]
//                                         [--no-guard] [--no-context] [--out <dir>]
//                                         [--from <secs>] [--to <secs>]
//
// Chunk limits come from client/src/lib/sermon/chunk-limits.ts (what the app uses).
// Like asr-eval this has no LLM correction step and no browser mic path: it compares Whisper
// output (`strippedText`) only. Output: data/asr-debug/replay-<timestamp>/<i>.json per chunk.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { RATE, decodeTo16kMono, planChunks, transcribePlannedChunks, type Chunk, type ChunkResult } from './lib/asr-chunks';
import { SERMON_VAD_SILENCE_MS, SERMON_MIN_CHUNK_MS, SERMON_MAX_CHUNK_MS } from '../client/src/lib/sermon/chunk-limits';

const ROOT = join(import.meta.dirname, '..');
const LANGUAGE = 'nl';

function parseArgs(argv: string[]) {
  const out = { audio: undefined as string | undefined, glossary: undefined as string | undefined, glossaryTerms: 15, guard: true, context: true, out: undefined as string | undefined, from: 0, to: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--glossary') out.glossary = argv[++i];
    else if (a === '--glossary-terms') out.glossaryTerms = Math.max(1, Number(argv[++i]) || 15);
    else if (a === '--no-guard') out.guard = false;
    else if (a === '--no-context') out.context = false;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--from') out.from = Number(argv[++i]) || 0;
    else if (a === '--to') out.to = Number(argv[++i]) || Infinity;
    else if (!a.startsWith('--')) out.audio = a;
  }
  return out;
}

async function loadGlossaryText(path: string, maxTerms: number): Promise<string> {
  const raw = readFileSync(path, 'utf8');
  if (!/\.csv$/i.test(path)) return raw.split('\n').map(l => l.trim()).filter(Boolean).slice(0, maxTerms).join('\n');
  const { parseGlossaryCsv } = await import('../server/lib/glossary-parse');
  const parsed = parseGlossaryCsv(raw);
  const priority = ['Eigennaam', 'Bijbelboek', 'Plaatsnaam'];
  const rank = (c: string) => { const i = priority.indexOf(c); return i === -1 ? priority.length : i; };
  return [...parsed.fixed, ...parsed.context].sort((a, b) => rank(a.category) - rank(b.category)).map(r => r.nl).filter(Boolean).slice(0, maxTerms).join('\n');
}

async function main() {
  try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* optional */ }
  process.env.OPENAI_API_KEY ??= 'unused-by-asr-replay'; // openai.ts builds a client at import; never used here

  const args = parseArgs(process.argv.slice(2));
  if (!args.audio || !existsSync(args.audio)) { console.error('usage: npx tsx scripts/asr-replay.ts <audio file> [options]'); process.exit(1); }
  const outDir = resolve(args.out ?? join(ROOT, 'data/asr-debug', `replay-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  mkdirSync(outDir, { recursive: true });

  const all = await decodeTo16kMono(args.audio);
  const from = Math.round(args.from * RATE);
  const samples = all.subarray(from, Math.min(all.length, Math.round(args.to * RATE)));
  const glossaryText = args.glossary ? await loadGlossaryText(args.glossary, args.glossaryTerms) : undefined;

  const { chunks, discarded } = planChunks(samples, { vad: true, minMs: SERMON_MIN_CHUNK_MS, silenceMs: SERMON_VAD_SILENCE_MS, maxMs: SERMON_MAX_CHUNK_MS });
  console.log(`${(samples.length / RATE / 60).toFixed(1)} min from ${args.audio}${from ? ` (starting at ${args.from}s)` : ''}`);
  console.log(`Chunking ${SERMON_MIN_CHUNK_MS / 1000}s min / ${SERMON_MAX_CHUNK_MS / 1000}s max / ${SERMON_VAD_SILENCE_MS}ms pause: ${chunks.length} chunks, ${discarded} discarded by the gate`);
  console.log(`Writing ${outDir}`);

  // Resume: a chunk file already in outDir with the same start sample is reused (the plan is deterministic).
  const cached = (i: number, chunk: Chunk): ChunkResult | undefined => {
    try {
      const d = JSON.parse(readFileSync(join(outDir, `${i}.json`), 'utf8'));
      if (d.meta?.startSample !== chunk.start + from || d.meta?.samples !== chunk.end - chunk.start) return undefined;
      return { chunk, prompt: d.prompt ?? undefined, raw: d.rawText, cleaned: d.strippedText, guardRetried: !!d.guardRetried, diags: d.attempts ?? [] };
    } catch { return undefined; }
  };
  const work = mkdtempSync(join(tmpdir(), 'asr-replay-'));
  const t0 = Date.now();
  try {
    await transcribePlannedChunks(samples, chunks, {
      language: LANGUAGE, context: args.context, glossaryText, glossaryTerms: args.glossaryTerms, guard: args.guard, workDir: work, cached,
      onChunk: (i, r) => {
        const startSample = r.chunk.start + from; // keep timestamps relative to the original recording
        writeFileSync(join(outDir, `${i}.json`), JSON.stringify({
          chunkIndex: i,
          meta: { chunkIndex: i, startSample, samples: r.chunk.end - r.chunk.start, prefixSamples: 0, cut: r.chunk.cut },
          prompt: r.prompt ?? null, guardRetried: r.guardRetried, rawText: r.raw, strippedText: r.cleaned,
          attempts: r.diags.map(d => ({ usePrompt: d.usePrompt, diag: d.diag })),
        }, null, 2));
        if ((i + 1) % 25 === 0 || i + 1 === chunks.length) {
          const done = r.chunk.end / RATE, secs = (Date.now() - t0) / 1000;
          console.log(`  ${i + 1}/${chunks.length} chunks, ${(done / 60).toFixed(1)} min of audio, ${(secs / 60).toFixed(1)} min elapsed`);
        }
      },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileSync(join(outDir, 'replay.json'), JSON.stringify({ source: resolve(args.audio), from: args.from, to: args.to, guard: args.guard, context: args.context, glossary: args.glossary ?? null, minMs: SERMON_MIN_CHUNK_MS, maxMs: SERMON_MAX_CHUNK_MS, silenceMs: SERMON_VAD_SILENCE_MS }, null, 2));
  console.log(`Done in ${((Date.now() - t0) / 60000).toFixed(1)} min. Next: npx tsx scripts/asr-compare.ts <original session> ${outDir}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
