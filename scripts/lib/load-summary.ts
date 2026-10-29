// Per-minute "was the machine overloaded?" table for a `dev:record` session, built from machine.jsonl
// (server/lib/machine-monitor.ts), browser.jsonl (client/src/lib/sermon/perf-monitor.ts), telemetry.jsonl and the
// chunk files. Pure, so it is unit-tested; scripts/asr-session-audio.ts reads the files and prints the table.

export interface MachineRow {
  w: number;
  sys?: { cpuPct: number | null; load1: number; memFreePct: number | null };
  mlx?: { cpuPct: number | null; busy: boolean; queued: number; ready?: boolean };
  top?: Array<{ name: string; cpuPct: number }> | null;
  power?: { source: string | null; cpuSpeedLimit: number | null; lowPowerMode: boolean | null } | null;
  chunks?: { inFlight: number; oldestMs: number | null } | null;
}

export interface BrowserRow { w: number; visible: boolean; longTaskMs: number; maxDriftMs: number }

export interface TelemetryRow { t: number; w: number }

export interface ChunkTiming {
  /** Where the chunk starts in the recording, in seconds. */
  startSecs: number;
  decodeSecs: number | null;
  slotWaitSecs: number | null;
  /** received -> delivered, seconds; null when it never was. */
  lagSecs: number | null;
  /** Segments Whisper decoded again at a higher temperature (the slow path). */
  fallbackSegments: number;
  aborted: boolean;
}

export interface LoadMinute {
  minute: number;
  samples: number;
  cpuAvg: number | null;
  cpuMax: number | null;
  load1Max: number | null;
  memFreeMin: number | null;
  mlxCpuMax: number | null;
  mlxBusyPct: number | null;
  /** Chunks were waiting while the worker had not finished loading its model (cold start, or a restart). */
  workerLoading: boolean;
  /** The process most often busiest this minute, and its highest CPU. */
  topName: string | null;
  topCpu: number | null;
  battery: boolean;
  lowPower: boolean;
  speedLimitMin: number | null;
  inFlightMax: number | null;
  oldestMaxSecs: number | null;
  decodeMaxSecs: number | null;
  slotWaitMaxSecs: number | null;
  lagMaxSecs: number | null;
  fallbackSegments: number;
  abortedChunks: number;
  longTaskMs: number | null;
  pageDriftMaxMs: number | null;
  frameGapMaxMs: number | null;
  notes: string[];
}

const max = (xs: number[]): number | null => (xs.length ? Math.max(...xs) : null);
const min = (xs: number[]): number | null => (xs.length ? Math.min(...xs) : null);
const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const nums = (xs: Array<number | null | undefined>): number[] => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

/** Wall-clock time of sample 0 of the recording: from the first telemetry row, else the page's start time. */
export function recordingStartWall(telemetry: TelemetryRow[], clientStartedAt: number | null): number | null {
  const first = telemetry[0];
  if (first) return first.w - first.t * 1000;
  return clientStartedAt;
}

export interface LoadInput {
  startWall: number;
  machine: MachineRow[];
  browser: BrowserRow[];
  telemetry: TelemetryRow[];
  chunks: ChunkTiming[];
}

export function summarizeLoad({ startWall, machine, browser, telemetry, chunks }: LoadInput): LoadMinute[] {
  const minuteOfWall = (w: number) => Math.floor((w - startWall) / 60_000);
  const buckets = new Map<number, { machine: MachineRow[]; browser: BrowserRow[]; chunks: ChunkTiming[]; frameGaps: number[] }>();
  const bucket = (m: number) => {
    let b = buckets.get(m);
    if (!b) buckets.set(m, b = { machine: [], browser: [], chunks: [], frameGaps: [] });
    return b;
  };
  for (const r of machine) if (minuteOfWall(r.w) >= 0) bucket(minuteOfWall(r.w)).machine.push(r);
  for (const r of browser) if (minuteOfWall(r.w) >= 0) bucket(minuteOfWall(r.w)).browser.push(r);
  for (const c of chunks) bucket(Math.floor(c.startSecs / 60)).chunks.push(c);
  // Audio callbacks arrive every ~256 ms; a long gap between two is the page (or the machine) stalling.
  for (let i = 1; i < telemetry.length; i++) bucket(Math.floor(telemetry[i].t / 60)).frameGaps.push(telemetry[i].w - telemetry[i - 1].w);

  return Array.from(buckets.keys()).sort((a, b) => a - b).map((minute) => {
    const b = buckets.get(minute)!;
    const cpu = nums(b.machine.map(r => r.sys?.cpuPct));
    const mlxSamples = b.machine.filter(r => r.mlx);
    const winners = new Map<string, { n: number; cpu: number }>();
    for (const r of b.machine) {
      const t = r.top?.[0];
      if (!t) continue;
      const w = winners.get(t.name) ?? { n: 0, cpu: 0 };
      winners.set(t.name, { n: w.n + 1, cpu: Math.max(w.cpu, t.cpuPct) });
    }
    const [busiest, busiestStat] = Array.from(winners.entries()).sort((a, b) => b[1].n - a[1].n)[0] ?? [null, null];

    const row: LoadMinute = {
      minute,
      samples: b.machine.length,
      cpuAvg: avg(cpu),
      cpuMax: max(cpu),
      load1Max: max(nums(b.machine.map(r => r.sys?.load1))),
      memFreeMin: min(nums(b.machine.map(r => r.sys?.memFreePct))),
      mlxCpuMax: max(nums(b.machine.map(r => r.mlx?.cpuPct))),
      workerLoading: b.machine.some(r => r.mlx?.ready === false && (r.chunks?.inFlight ?? 0) > 0),
      mlxBusyPct: mlxSamples.length ? Math.round((100 * mlxSamples.filter(r => r.mlx!.busy).length) / mlxSamples.length) : null,
      topName: busiest,
      topCpu: busiestStat?.cpu ?? null,
      battery: b.machine.some(r => r.power?.source === 'Battery'),
      lowPower: b.machine.some(r => r.power?.lowPowerMode === true),
      speedLimitMin: min(nums(b.machine.map(r => r.power?.cpuSpeedLimit))),
      inFlightMax: max(nums(b.machine.map(r => r.chunks?.inFlight))),
      oldestMaxSecs: (() => { const m = max(nums(b.machine.map(r => r.chunks?.oldestMs))); return m === null ? null : m / 1000; })(),
      decodeMaxSecs: max(nums(b.chunks.map(c => c.decodeSecs))),
      slotWaitMaxSecs: max(nums(b.chunks.map(c => c.slotWaitSecs))),
      lagMaxSecs: max(nums(b.chunks.map(c => c.lagSecs))),
      fallbackSegments: b.chunks.reduce((n, c) => n + c.fallbackSegments, 0),
      abortedChunks: b.chunks.filter(c => c.aborted).length,
      longTaskMs: b.browser.length ? b.browser.reduce((n, r) => n + r.longTaskMs, 0) : null,
      pageDriftMaxMs: max(nums(b.browser.filter(r => r.visible).map(r => r.maxDriftMs))),
      frameGapMaxMs: max(b.frameGaps),
      notes: [],
    };
    row.notes = notesFor(row);
    return row;
  });
}

/** The short flags that tell the story at a glance. Thresholds are rules of thumb, not measured limits. */
export function notesFor(r: LoadMinute): string[] {
  const notes: string[] = [];
  if (r.battery) notes.push('BATTERY');
  if (r.lowPower) notes.push('LOW-POWER-MODE');
  if (r.speedLimitMin !== null && r.speedLimitMin < 100) notes.push(`THROTTLED-${r.speedLimitMin}%`);
  if (r.memFreeMin !== null && r.memFreeMin < 15) notes.push('LOW-MEMORY');
  if (r.cpuMax !== null && r.cpuMax >= 90) notes.push('CPU-SATURATED');
  if ((r.pageDriftMaxMs !== null && r.pageDriftMaxMs >= 500) || (r.frameGapMaxMs !== null && r.frameGapMaxMs >= 600)) notes.push('PAGE-STALLED');
  if (r.workerLoading) notes.push('WORKER-LOADING');
  if (r.fallbackSegments > 0) notes.push(`DECODE-RETRIES-${r.fallbackSegments}`);
  if (r.lagMaxSecs !== null && r.lagMaxSecs >= 20) notes.push(`BEHIND-${Math.round(r.lagMaxSecs)}s`);
  if (r.abortedChunks > 0) notes.push(`ABORTED-${r.abortedChunks}`);
  return notes;
}

const f = (n: number | null, digits = 0, pad = 0) => (n === null ? '—' : n.toFixed(digits)).padStart(pad);

/** Fixed-width text table; one line per minute. */
export function formatLoadTable(minutes: LoadMinute[]): string[] {
  const header = 'min  cpu avg/max  load  memFree%  mlx cpu  busy%  busiest process (max cpu%)              queue(max/oldest)  decode  slotwait  late  page: tasks/drift  frame gap  notes';
  const lines = minutes.map(m => [
    String(m.minute).padStart(3),
    `${f(m.cpuAvg, 0, 5)}/${f(m.cpuMax, 0, 3)}  `,
    f(m.load1Max, 1, 5),
    f(m.memFreeMin, 0, 8) + '  ',
    f(m.mlxCpuMax, 0, 7),
    f(m.mlxBusyPct, 0, 6),
    '  ' + `${m.topName ? m.topName.slice(0, 30) : '—'}${m.topCpu !== null ? ` (${Math.round(m.topCpu)})` : ''}`.padEnd(38),
    `${f(m.inFlightMax, 0, 6)}/${f(m.oldestMaxSecs, 0, 4)}s     `,
    f(m.decodeMaxSecs, 1, 6) + 's',
    f(m.slotWaitMaxSecs, 1, 8) + 's',
    f(m.lagMaxSecs, 0, 5) + 's',
    `  ${f(m.longTaskMs, 0, 5)}ms/${f(m.pageDriftMaxMs, 0, 4)}ms`,
    f(m.frameGapMaxMs, 0, 9) + 'ms',
    '  ' + m.notes.join(' '),
  ].join(' ').trimEnd());
  return [header, ...lines];
}
