// Aligns what the recognizer said (per-chunk archive of an ASR_DEBUG_DIR session, `npm run dev:record`)
// with what the human left on screen (transcript.json): both sides become normalised word streams that a
// Myers diff lines up. Shared by scripts/asr-edits.ts (what changed), scripts/build-asr-fixtures.ts
// (cut the audio into test clips with the corrected text as reference) and scripts/asr-confidence-check.ts.
//
// Normalisation is the ASR scorer's (tests/lib/wer.ts), so only real word changes show.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { dedupeOverlap, tail80 } from '../../client/src/lib/sermon/overlap-dedupe';

const RATE = 16_000;
const ROOT = join(import.meta.dirname, '..');
const MAX_EDIT_WORDS = 40;
const MAX_D = 8000;

export type Stage = 'raw' | 'stripped' | 'corrected';

export interface Token {
  norm: string;     // one normalised word (a raw word like "3:16" can yield several)
  raw: string;      // the word as written
  rawIdx: number;   // index into the raw word list, to render a raw word once
  time: number;     // seconds into the recording (original side only)
  segment: number;  // segment index (edited side only)
}

export interface Op { type: 'eq' | 'del' | 'ins'; ai: number; bi: number }

export const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ── Loading ──────────────────────────────────────────────────────────────────

export interface Chunk {
  start: number; secs: number; text: string; deliveredAt: number;
  /** Whisper's doubtful words for this chunk (MLX recordings made after word probabilities were archived), most doubtful first. */
  uncertain?: Array<{ word: string; p: number }>;
}

export function loadChunks(dir: string, stage: Stage): Chunk[] {
  const chunks: Chunk[] = [];
  for (const f of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    let d: any;
    try { d = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    const m = d.meta;
    if (!m || typeof m.startSample !== 'number') continue;
    const text = stage === 'raw' ? d.rawText
      : stage === 'stripped' ? d.strippedText
      : (d.correctedText ?? d.strippedText);
    // The attempt whose text won (a guard retry can produce a second one); fall back to the last.
    const attempts: any[] = Array.isArray(d.attempts) ? d.attempts : [];
    const winner = attempts.find(a => a?.text === d.rawText) ?? attempts[attempts.length - 1];
    chunks.push({
      start: m.startSample / RATE, secs: (m.samples - (m.prefixSamples ?? 0)) / RATE,
      text: String(text ?? '').trim(), deliveredAt: Date.parse(d.deliveredAt ?? '') || 0,
      uncertain: Array.isArray(winner?.uncertain) ? winner.uncertain : undefined,
    });
  }
  return chunks.sort((a, b) => a.start - b.start);
}

export function tokenize(words: Array<{ raw: string; time: number; segment: number }>, score: (t: string) => string): Token[] {
  const out: Token[] = [];
  words.forEach((w, rawIdx) => {
    for (const norm of score(w.raw).split(' ').filter(Boolean)) out.push({ norm, raw: w.raw, rawIdx, time: w.time, segment: w.segment });
  });
  return out;
}

/** Raw words of tokens[from, to), each raw word once. */
export function render(tokens: Token[], from: number, to: number): string {
  const words: string[] = [];
  let last = -1;
  for (let i = Math.max(0, from); i < Math.min(tokens.length, to); i++) {
    if (tokens[i].rawIdx !== last) words.push(tokens[i].raw);
    last = tokens[i].rawIdx;
  }
  return words.join(' ');
}

// ── Myers diff ───────────────────────────────────────────────────────────────

export function myers(a: string[], b: string[]): Op[] {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length, eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const x0 = a.slice(lo, ea), y0 = b.slice(lo, eb);
  const n = x0.length, m = y0.length, max = n + m, off = max + 1;

  const ops: Op[] = [];
  for (let i = 0; i < lo; i++) ops.push({ type: 'eq', ai: i, bi: i });

  const v = new Int32Array(2 * max + 4);
  const trace: Int32Array[] = [];
  let dFinal = -1;
  for (let d = 0; d <= max && dFinal < 0; d++) {
    if (d > MAX_D) throw new Error(`texts differ by more than ${MAX_D} words — wrong session, or transcript.json belongs to another recording?`);
    trace.push(v.slice(off - d - 1, off + d + 2));   // state before round d, k = -d-1 .. d+1
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && x0[x] === y0[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { dFinal = d; break; }
    }
  }

  const mid: Op[] = [];
  let x = n, y = m;
  for (let d = dFinal; d > 0; d--) {
    const pv = trace[d], k = x - y;
    const prevK = (k === -d || (k !== d && pv[k - 1 + d + 1] < pv[k + 1 + d + 1])) ? k + 1 : k - 1;
    const px = pv[prevK + d + 1], py = px - prevK;
    while (x > px && y > py) { x--; y--; mid.push({ type: 'eq', ai: x + lo, bi: y + lo }); }
    if (x === px) mid.push({ type: 'ins', ai: px + lo, bi: py + lo });
    else mid.push({ type: 'del', ai: px + lo, bi: py + lo });
    x = px; y = py;
  }
  while (x > 0 && y > 0) { x--; y--; mid.push({ type: 'eq', ai: x + lo, bi: y + lo }); }
  ops.push(...mid.reverse());

  for (let i = 0; i < a.length - ea; i++) ops.push({ type: 'eq', ai: ea + i, bi: eb + i });
  return ops;
}

// ── Hunks ────────────────────────────────────────────────────────────────────

export interface Hunk {
  aFrom: number; aTo: number;   // original tokens [from, to)
  bFrom: number; bTo: number;   // edited tokens [from, to)
}

export function hunksFrom(ops: Op[], gap: number): Hunk[] {
  const raw: Hunk[] = [];
  let cur: Hunk | null = null;
  let eqRun = 0;
  for (const op of ops) {
    if (op.type === 'eq') { eqRun++; continue; }
    const aEnd = op.type === 'del' ? op.ai + 1 : op.ai;
    const bEnd = op.type === 'ins' ? op.bi + 1 : op.bi;
    if (cur && eqRun <= gap) { cur.aTo = aEnd; cur.bTo = bEnd; }
    else { cur = { aFrom: op.ai, aTo: aEnd, bFrom: op.bi, bTo: bEnd }; raw.push(cur); }
    eqRun = 0;
  }
  return raw;
}

// ── Building the two word streams ────────────────────────────────────────────

export interface RawWord { raw: string; time: number; segment: number }

/**
 * The original side: every chunk's text in time order, chunk-boundary overlap dropped like the ingest
 * buffer does. A word's `time` is spread evenly over its chunk (there are no word timestamps in the archive).
 */
export function originalWords(chunks: Chunk[]): RawWord[] {
  const words: RawWord[] = [];
  let prev = '';
  for (const c of chunks) {
    const text = dedupeOverlap(tail80(prev), c.text).trim();
    if (c.text) prev = prev ? `${prev} ${text}` : text;
    const list = text.split(/\s+/).filter(Boolean);
    list.forEach((w, k) => words.push({ raw: w, time: c.start + ((k + 0.5) / list.length) * c.secs, segment: -1 }));
  }
  return words;
}

/** The edited side: the on-screen segments' `sourceText`, in order. */
export function editedWords(segments: Array<{ index: number; sourceText: string }>): RawWord[] {
  const words: RawWord[] = [];
  for (const s of [...segments].sort((a, b) => a.index - b.index)) {
    for (const w of String(s.sourceText ?? '').split(/\s+/).filter(Boolean)) words.push({ raw: w, time: 0, segment: s.index });
  }
  return words;
}

/**
 * For every edited token, the recording time it belongs to: an unchanged word takes its ASR word's time,
 * and a word the human changed or added takes the time of the nearest ASR word before it. Lets an edited
 * transcript be cut into time windows next to the audio.
 */
export function editedTimes(ops: Op[], a: Token[], bLength: number): number[] {
  const times = new Array<number>(bLength).fill(0);
  let last = a[0]?.time ?? 0;
  for (const op of ops) {
    if (op.type === 'eq') { last = a[op.ai].time; times[op.bi] = last; }
    else if (op.type === 'del') last = a[op.ai].time;
    else times[op.bi] = last;
  }
  return times;
}


// ── Cutting into windows ─────────────────────────────────────────────────────

export interface TimeWindow { from: number; to: number }

/**
 * Groups consecutive chunks into windows of at least `minSecs`: each window starts at a chunk's start
 * and ends at the end of a chunk, so no window cuts through a recognizer chunk. A last window shorter
 * than `minSecs` is merged into the one before it (or kept if it is the only one).
 */
export function planWindows(chunks: Array<{ start: number; secs: number }>, minSecs: number): TimeWindow[] {
  const sorted = [...chunks].sort((x, y) => x.start - y.start);
  const out: TimeWindow[] = [];
  let from: number | null = null;
  let to = 0;
  for (const c of sorted) {
    if (from === null) from = c.start;
    to = c.start + c.secs;
    if (to - from >= minSecs) { out.push({ from, to }); from = null; }
  }
  if (from !== null) {
    if (out.length) out[out.length - 1].to = to;
    else out.push({ from, to });
  }
  return out;
}

/** Indices [i0, i1) of the entries of a non-decreasing `times` array that lie in [from, to). */
export function indexRange(times: number[], from: number, to: number): [number, number] {
  let i0 = 0;
  while (i0 < times.length && times[i0] < from) i0++;
  let i1 = i0;
  while (i1 < times.length && times[i1] < to) i1++;
  return [i0, i1];
}
