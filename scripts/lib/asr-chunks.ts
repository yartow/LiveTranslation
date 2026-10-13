// Shared by scripts/asr-eval.ts and scripts/asr-replay.ts: decode audio, plan chunks the way the
// browser would, and run them through the server's per-chunk Whisper path.

import { spawn } from 'child_process';
import { writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { SpeechGate, windowMeanAbs } from '../../client/src/lib/chunk-based-transcription';
import type { MlxDiag } from '../../server/lib/mlx-whisper';

export const RATE = 16_000;
const FRAME = 1365; // ~85 ms at 16 kHz, matching the browser's ~85 ms frames at 48 kHz
const FRAME_MS = (FRAME / RATE) * 1000;
const GATE_WINDOW_MS = 20;
const GATE_WINDOW = Math.round((GATE_WINDOW_MS / 1000) * RATE);

export interface ChunkingSetup { vad: boolean; minMs: number; silenceMs: number; maxMs: number }

// ── audio helpers ────────────────────────────────────────────────────────────

export function decodeTo16kMono(path: string): Promise<Float32Array> {
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

export function wavBuffer(samples: Float32Array): Buffer {
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

export interface Chunk { start: number; end: number; cut: 'vad' | 'cap' | 'stop' }

export function planChunks(samples: Float32Array, c: ChunkingSetup): { chunks: Chunk[]; discarded: number } {
  const chunks: Chunk[] = [];
  let discarded = 0;
  let chunkStart = 0;
  const gate = new SpeechGate();
  let vadSilenceMs = 0;
  const minSamples = Math.round((c.minMs / 1000) * RATE);
  const maxSamples = Math.max(minSamples, Math.round((c.maxMs / 1000) * RATE));

  const commit = (end: number, cut: Chunk['cut']) => {
    if (end <= chunkStart) return;
    if (gate.keepChunk()) chunks.push({ start: chunkStart, end, cut });
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
    if (c.vad && vadSilenceMs >= c.silenceMs && accumulated >= minSamples) commit(end, 'vad');
    else if (accumulated >= maxSamples) commit(end, 'cap');
  }
  const tail = samples.length - chunkStart;
  if (tail >= 100) commit(samples.length, 'stop');
  return { chunks, discarded };
}

export interface ChunkResult {
  chunk: Chunk;
  prompt: string | undefined;
  /** Whisper's text after the guard, before artifact filtering. */
  raw: string;
  /** After isAsrArtifact/stripAsrArtifacts ('' = dropped). */
  cleaned: string;
  guardRetried: boolean;
  diags: Array<{ usePrompt: boolean; diag: MlxDiag | null }>;
}

export interface TranscribeOptions {
  language: string;
  /** Feed the previous chunks' text back to Whisper as its prompt. */
  context: boolean;
  glossaryText?: string;
  glossaryTerms: number;
  guard: boolean;
  opts?: Record<string, unknown>;
  workDir: string;
  /** Resume support: return a previously computed result for chunk i to skip Whisper (its text still feeds the rolling context). */
  cached?: (i: number, chunk: Chunk) => ChunkResult | undefined;
  onChunk?: (i: number, r: ChunkResult) => void;
}

/** The server's per-chunk path (server/lib/chunk-transcription.ts): Whisper -> guard -> artifact filters. No LLM correction. */
export async function transcribePlannedChunks(samples: Float32Array, chunks: Chunk[], o: TranscribeOptions): Promise<ChunkResult[]> {
  const { transcribeWithMlxDetailed } = await import('../../server/lib/mlx-whisper');
  const { buildWhisperPrompt } = await import('../../server/lib/openai');
  const { isAsrArtifact, stripAsrArtifacts } = await import('../../server/lib/asr-artifacts');
  const { transcribeGuarded } = await import('../../server/lib/whisper-guard');

  const out: ChunkResult[] = [];
  let prev = '';
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const hit = o.cached?.(i, chunk);
    if (hit) {
      if (hit.cleaned) prev = (prev + ' ' + hit.cleaned).slice(-300);
      out.push(hit);
      continue;
    }
    const path = join(o.workDir, `chunk-${i}.wav`);
    writeFileSync(path, wavBuffer(samples.subarray(chunk.start, chunk.end)));
    const prompt = buildWhisperPrompt(o.glossaryText, undefined, o.context ? prev || undefined : undefined, o.language, o.glossaryTerms);
    const diags: ChunkResult['diags'] = [];
    const guarded = await transcribeGuarded(
      async (usePrompt) => {
        const res = await transcribeWithMlxDetailed(path, o.language, usePrompt ? prompt : undefined, undefined, o.opts);
        diags.push({ usePrompt, diag: res.diag });
        return res.text;
      },
      o.guard && !!prompt, (chunk.end - chunk.start) / RATE,
    );
    rmSync(path, { force: true });
    const raw = guarded.text.trim();
    // Same order as server/lib/chunk-transcription.ts
    const cleaned = !raw || isAsrArtifact(raw, o.language) ? '' : stripAsrArtifacts(raw, o.language);
    if (cleaned) prev = (prev + ' ' + cleaned).slice(-300);
    const result: ChunkResult = { chunk, prompt, raw, cleaned, guardRetried: guarded.retried, diags };
    out.push(result);
    o.onChunk?.(i, result);
  }
  return out;
}
