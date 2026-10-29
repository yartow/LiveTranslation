// Joins a session archive folder (see ASR_DEBUG_DIR in server/lib/chunk-transcription.ts)
// into one listenable recording plus a timeline of what happened to each stretch.
//
//   npx tsx scripts/asr-session-audio.ts data/asr-debug/<session>
//
// Writes <session>/full.wav (16 kHz mono; chunks the Whisper pipeline saw AND stretches the
// browser's speech gate discarded, in recording order; holes filled with silence) and
// <session>/timeline.txt, and prints the timeline. The timeline is the thing to read first
// after a service: a stretch you remember being spoken but that shows as DISCARDED, a gap, or
// a chunk with few words / uncovered spans tells you which stage lost it.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  summarizeLoad, formatLoadTable, recordingStartWall,
  type BrowserRow, type ChunkTiming, type MachineRow, type TelemetryRow,
} from './lib/load-summary';

const RATE = 16_000;

interface Piece {
  startSample: number;
  samples: Int16Array;
  kind: 'chunk' | 'discarded';
  label: string;
  meta: Record<string, any>;
  info: Record<string, any> | null; // the chunk's .json (null for discarded)
}

function readWavSamples(path: string): Int16Array {
  const buf = readFileSync(path);
  // The client always writes a plain 44-byte-header 16 kHz mono PCM16 WAV.
  const data = buf.subarray(44, 44 + Math.floor((buf.length - 44) / 2) * 2);
  return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

function readJson(path: string): Record<string, any> | null {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** One JSON object per line; a torn last line (the page was closed mid-write) is skipped, not fatal. */
function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const rows: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}

/** Where the time went for one chunk, from its .json (fields added with the load logs; absent in older sessions). */
function chunkTiming(p: Piece): ChunkTiming {
  const info = p.info ?? {};
  const attempts: any[] = info.attempts ?? [];
  const decode = attempts.map(a => a.decodeSecs).filter((x: unknown): x is number => typeof x === 'number');
  const received = Date.parse(info.receivedAt ?? '');
  const done = Date.parse(info.deliveredAt ?? info.transcribedAt ?? '');
  return {
    startSecs: p.startSample / RATE,
    decodeSecs: decode.length ? decode.reduce((a, b) => a + b, 0) : null,
    slotWaitSecs: typeof info.slotWaitMs === 'number' ? info.slotWaitMs / 1000 : null,
    lagSecs: Number.isFinite(received) && Number.isFinite(done) ? (done - received) / 1000 : null,
    fallbackSegments: attempts.flatMap(a => a.diag?.segments ?? []).filter((x: any) => (x.temperature ?? 0) > 0).length,
    aborted: info.aborted === true,
  };
}

function wavBuffer(samples: Int16Array): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.byteLength, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

function mmss(sample: number): string {
  const s = sample / RATE;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

function main() {
  const dir = process.argv[2];
  if (!dir || !existsSync(dir)) { console.error('usage: npx tsx scripts/asr-session-audio.ts <session folder>'); process.exit(1); }

  const pieces: Piece[] = [];
  for (const file of readdirSync(dir)) {
    const chunk = /^(\d+)\.wav$/.exec(file);
    const discarded = /^discarded-(\d+)\.wav$/.exec(file);
    if (chunk) {
      const info = readJson(join(dir, `${chunk[1]}.json`));
      const meta = info?.meta;
      if (!meta || typeof meta.startSample !== 'number') { console.warn(`chunk ${chunk[1]}: no chunk_meta — skipped in full.wav`); continue; }
      const all = readWavSamples(join(dir, file));
      // Drop the overlap prefix so the same audio isn't laid down twice.
      pieces.push({ startSample: meta.startSample, samples: all.subarray(meta.prefixSamples ?? 0), kind: 'chunk', label: `#${chunk[1]}`, meta, info });
    } else if (discarded) {
      const meta = readJson(join(dir, `discarded-${discarded[1]}.json`)) ?? {};
      pieces.push({ startSample: Number(discarded[1]), samples: readWavSamples(join(dir, file)), kind: 'discarded', label: 'gate', meta, info: null });
    }
  }
  if (!pieces.length) { console.error('no audio found in', dir); process.exit(1); }
  pieces.sort((a, b) => a.startSample - b.startSample);

  const end = Math.max(...pieces.map(p => p.startSample + p.samples.length));
  const full = new Int16Array(end);
  const lines: string[] = [];
  let cursor = 0;
  let discardedSamples = 0;
  let gapSamples = 0;

  for (const p of pieces) {
    if (p.startSample > cursor + RATE * 0.05) {
      lines.push(`[${mmss(cursor)}-${mmss(p.startSample)}] GAP      ${((p.startSample - cursor) / RATE).toFixed(1)}s of audio never reached the archive (connection down?)`);
      gapSamples += p.startSample - cursor;
    }
    full.set(p.samples, p.startSample);
    cursor = Math.max(cursor, p.startSample + p.samples.length);
    const range = `[${mmss(p.startSample)}-${mmss(p.startSample + p.samples.length)}]`;
    const secs = (p.samples.length / RATE).toFixed(1).padStart(5);
    if (p.kind === 'discarded') {
      discardedSamples += p.samples.length;
      lines.push(`${range} DISCARDED ${secs}s  gate longest voiced run ${Math.round(p.meta.gateRunMs ?? 0)}ms, noise floor ${(p.meta.noiseFloor ?? 0).toFixed?.(5)}  (browser gate: "no sustained speech")`);
    } else {
      const text: string = p.info?.strippedText ?? p.info?.rawText ?? '';
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const attempts: any[] = p.info?.attempts ?? [];
      const dropped = attempts.flatMap(a => a.diag?.segments ?? []).filter((x: any) => x.dropped);
      const uncovered = attempts.flatMap(a => a.diag?.uncovered ?? []);
      const timing = chunkTiming(p);
      const flags = [
        p.info?.guardRetried ? 'guard-retried' : '',
        dropped.length ? `dropped-segments=${dropped.length}` : '',
        uncovered.length ? `uncovered=${uncovered.map((u: number[]) => `${u[0]}-${u[1]}s`).join(',')}` : '',
        // Whisper heard nothing, or the server gave up on the chunk (stop with a backlog): not the same thing.
        !text.trim() ? (p.info?.aborted ? 'ABORTED-NOT-TRANSCRIBED' : 'NO-TEXT') : '',
        timing.lagSecs !== null && timing.lagSecs >= 10 ? `late=${Math.round(timing.lagSecs)}s` : '',
        timing.decodeSecs !== null && timing.decodeSecs >= 8 ? `decode=${timing.decodeSecs.toFixed(1)}s` : '',
        timing.slotWaitSecs !== null && timing.slotWaitSecs >= 10 ? `slot-wait=${Math.round(timing.slotWaitSecs)}s` : '',
      ].filter(Boolean).join(' ');
      lines.push(`${range} CHUNK ${p.label.padEnd(4)} ${secs}s  cut=${p.meta.cut ?? '?'} ${(words / (p.samples.length / RATE)).toFixed(1)}w/s ${flags}  "${text.slice(0, 70)}"`);
      for (const d of dropped) lines.push(`             └ dropped ${d.start}-${d.end}s (${d.dropped}): "${String(d.text).slice(0, 60)}"`);
    }
  }

  const summary = [
    `Session: ${dir}`,
    `Recording: ${mmss(end)} total; ${pieces.filter(p => p.kind === 'chunk').length} chunks sent to Whisper, ` +
      `${pieces.filter(p => p.kind === 'discarded').length} discarded by the gate (${(discardedSamples / RATE).toFixed(1)}s), ${(gapSamples / RATE).toFixed(1)}s gaps`,
    '',
  ];
  // Was the machine (or the page) overloaded? Needs machine.jsonl / browser.jsonl, written by sessions recorded
  // after the load logs were added.
  const machine = readJsonl<MachineRow>(join(dir, 'machine.jsonl'));
  const browser = readJsonl<BrowserRow>(join(dir, 'browser.jsonl'));
  const telemetry = readJsonl<TelemetryRow>(join(dir, 'telemetry.jsonl'));
  const startWall = recordingStartWall(telemetry, readJson(join(dir, 'client.json'))?.startedAt ?? null);
  const load: string[] = [''];
  if ((machine.length || browser.length) && startWall !== null) {
    load.push('Load per minute (machine.jsonl = this Mac, browser.jsonl = the page; "late" = chunk received -> delivered):');
    load.push(...formatLoadTable(summarizeLoad({
      startWall, machine, browser, telemetry,
      chunks: pieces.filter(p => p.kind === 'chunk').map(chunkTiming),
    })));
  } else {
    load.push('(no machine.jsonl / browser.jsonl in this session: it was recorded before the load logs existed, so there is no CPU, memory or power data)');
  }

  const out = [...summary, ...lines, ...load].join('\n');
  writeFileSync(join(dir, 'timeline.txt'), out + '\n');
  writeFileSync(join(dir, 'full.wav'), wavBuffer(full));
  console.log(out);
  console.log(`\nWrote ${join(dir, 'full.wav')} and ${join(dir, 'timeline.txt')}`);
}

main();
