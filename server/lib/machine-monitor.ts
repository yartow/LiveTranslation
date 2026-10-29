// Machine-load log for `dev:record` sessions: every few seconds one JSON line in
// <session folder>/machine.jsonl saying how busy the Mac, Node and the MLX worker were, what else was
// eating CPU, whether the laptop was on battery or throttling, and how far behind the chunk queue was.
//
// Why: on 28 Oct the transcription fell 170 s behind from minute 25 and nothing recorded why. Read this
// next to telemetry.jsonl (same wall clock, `w`) and the chunk files' `decodeSecs` / `slotWaitMs`.
//
// Only runs while a session with an archive folder is registered, so it costs nothing in normal use.
// Everything is best effort: a failing `ps`/`pmset`/`sysctl` leaves that field null, a failing write is
// ignored — a debugging aid must never break a service.

import { execFile } from 'child_process';
import { appendFile } from 'fs/promises';
import { cpus, freemem, loadavg, platform } from 'os';
import { basename, join } from 'path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import { getMlxWorkerStats, type MlxWorkerStats } from './mlx-whisper';

const SAMPLE_EVERY_MS = 5_000;
/** Power and thermal state change slowly and each is a subprocess, so they are sampled less often. */
const POWER_EVERY_MS = 30_000;
const TOP_PROCESSES = 6;
const EXEC_TIMEOUT_MS = 3_000;

// ── Pure parsing (unit-tested; no Mac needed) ────────────────────────────────

export interface ProcessRow {
  pid: number;
  name: string;
  rssMB: number;
  /** ps's own %CPU, a slowly decaying average (macOS) — lags what the process is doing right now. */
  avgCpuPct: number;
  /** Cumulative CPU seconds, from ps's TIME column; two samples of it give the current load. */
  cpuSecs: number;
}

/** ps TIME: "769:21.42" on macOS, but also "1:02:03" and "2-01:02:03" elsewhere. Null if unreadable. */
export function parseCpuTime(text: string): number | null {
  const m = /^(?:(\d+)-)?((?:\d+:)*\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  const parts = m[2].split(':').map(Number).reverse(); // seconds, minutes, hours
  const weights = [1, 60, 3600];
  let secs = (m[1] ? Number(m[1]) * 86400 : 0);
  for (let i = 0; i < parts.length; i++) secs += parts[i] * (weights[i] ?? 0);
  return Number.isFinite(secs) ? secs : null;
}

/**
 * Parses `ps -Ao pid=,pcpu=,rss=,time=,comm=` (rss in KB). `comm` can hold spaces on macOS
 * ("/Applications/Google Chrome.app/…/Google Chrome Helper"), so everything after the fourth column is the
 * name, shortened to its last path segment. Lines that are not a process row are skipped.
 */
export function parsePsOutput(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    const cpuSecs = m ? parseCpuTime(m[4]) : null;
    if (!m || cpuSecs === null) continue;
    rows.push({ pid: Number(m[1]), avgCpuPct: Number(m[2]), rssMB: Math.round(Number(m[3]) / 1024), cpuSecs, name: basename(m[5]) });
  }
  return rows;
}

export interface ProcessLoad { pid: number; name: string; cpuPct: number; rssMB: number }

/**
 * Current CPU use per process: the change in cumulative CPU time since the previous sample over the wall time
 * between them (100 = one core fully busy). A process not seen before — and everything on the first sample —
 * falls back to ps's decayed average. `prev` maps pid -> cumulative seconds at the previous sample.
 */
export function currentLoads(rows: ProcessRow[], prev: Map<number, number> | null, elapsedSecs: number): ProcessLoad[] {
  return rows.map(r => {
    const before = prev?.get(r.pid);
    const cpuPct = before !== undefined && elapsedSecs > 0 ? Math.max(0, ((r.cpuSecs - before) / elapsedSecs) * 100) : r.avgCpuPct;
    return { pid: r.pid, name: r.name, cpuPct: round1(cpuPct), rssMB: r.rssMB };
  });
}

export interface PowerState {
  /** 'AC' | 'Battery' | null when unknown. */
  source: string | null;
  batteryPct: number | null;
  lowPowerMode: boolean | null;
  /** macOS "powermode": 0 automatic, 1 low, 2 high (Apple Silicon Pro/Max); null when not reported. */
  powerMode: number | null;
  /** macOS's CPU_Speed_Limit (100 = not throttled); null when it has recorded no throttling. */
  cpuSpeedLimit: number | null;
}

/** `pmset -g batt`: "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=…)\t83%; discharging; …". */
export function parseBatt(text: string): Pick<PowerState, 'source' | 'batteryPct'> {
  const source = /drawing from '(AC|Battery)/i.exec(text)?.[1] ?? null;
  const pct = /(\d+)%/.exec(text)?.[1];
  return { source: source ? (/^ac/i.test(source) ? 'AC' : 'Battery') : null, batteryPct: pct === undefined ? null : Number(pct) };
}

/** `pmset -g therm`: only mentions CPU_Speed_Limit when macOS is (or was) throttling. */
export function parseTherm(text: string): number | null {
  const m = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * `pmset -g`: Low Power Mode shows as "lowpowermode 1" (or "powermode 1") and the line is simply absent
 * when it is off, so a readable listing without it means off. Null only when pmset gave nothing.
 */
export function parseLowPowerMode(text: string): boolean | null {
  if (!/currently in use|powermode|sleep/i.test(text)) return null;
  return /\blowpowermode\s+1\b/.test(text) || /\bpowermode\s+1\b/.test(text);
}

export function parsePowerMode(text: string): number | null {
  const m = /^\s*powermode\s+(\d)/m.exec(text);
  return m ? Number(m[1]) : null;
}

/** Whole-machine CPU use (0-100) between two `os.cpus()` snapshots, summed over all cores. */
export function cpuPercent(prev: Array<{ idle: number; total: number }>, cur: Array<{ idle: number; total: number }>): number | null {
  if (prev.length !== cur.length || !cur.length) return null;
  let idle = 0;
  let total = 0;
  for (let i = 0; i < cur.length; i++) {
    idle += cur[i].idle - prev[i].idle;
    total += cur[i].total - prev[i].total;
  }
  return total > 0 ? Math.round((1000 * (total - idle)) / total) / 10 : null;
}

// ── Sampling ─────────────────────────────────────────────────────────────────

/** What a registered recording says about its own queue. */
export interface ChunkBacklog {
  /** Chunks received and not finished yet. */
  inFlight: number;
  /** Finished chunks held back because an earlier one is not done. */
  waitingForEarlier: number;
  /** Age of the oldest chunk still being processed, ms; null when none. */
  oldestMs: number | null;
}

export interface MachineMonitorDeps {
  run: (cmd: string, args: string[]) => Promise<string>;
  append: (file: string, text: string) => Promise<void>;
  now: () => number;
  isMac: boolean;
  cpuTimes: () => Array<{ idle: number; total: number }>;
  loadavg: () => number[];
  freememMB: () => number;
  rssMB: () => number;
  loopDelayP99Ms: () => number | null;
  mlxStats: () => MlxWorkerStats;
  /** Starts/stops whatever backs `loopDelayP99Ms`. */
  setup: () => void;
  teardown: () => void;
}

function execText(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function defaultDeps(): MachineMonitorDeps {
  let histogram: IntervalHistogram | null = null;
  return {
    run: execText,
    append: (file, text) => appendFile(file, text),
    now: () => Date.now(),
    isMac: platform() === 'darwin',
    cpuTimes: () => cpus().map(c => {
      const t = c.times;
      return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
    }),
    loadavg,
    freememMB: () => Math.round(freemem() / 1024 / 1024),
    rssMB: () => Math.round(process.memoryUsage().rss / 1024 / 1024),
    loopDelayP99Ms: () => {
      if (!histogram) return null;
      const ms = histogram.percentile(99) / 1e6;
      histogram.reset();
      return Math.round(ms * 10) / 10;
    },
    mlxStats: getMlxWorkerStats,
    setup: () => { histogram = monitorEventLoopDelay({ resolution: 20 }); histogram.enable(); },
    teardown: () => { histogram?.disable(); histogram = null; },
  };
}

interface Registration { dir: string; backlog: () => ChunkBacklog }

export class MachineMonitor {
  private regs = new Map<object, Registration>();
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private prevCpu: Array<{ idle: number; total: number }> | null = null;
  private lastSampleAt: number | null = null;
  private lastPowerAt = 0;
  private lastPower: PowerState | null = null;
  private prevProcCpu: Map<number, number> | null = null;
  private prevProcAt = 0;

  constructor(private readonly deps: MachineMonitorDeps = defaultDeps()) {}

  isRunning(): boolean { return this.timer !== null; }

  /** Starts sampling (if not already) and writes rows to `<dir>/machine.jsonl` until unregistered. `key` identifies the recording. */
  register(key: object, dir: string, backlog: () => ChunkBacklog): void {
    this.regs.set(key, { dir, backlog });
    if (this.timer) return;
    try { this.deps.setup(); } catch { /* optional */ }
    this.prevCpu = this.deps.cpuTimes();
    this.timer = setInterval(() => { void this.sampleOnce(); }, SAMPLE_EVERY_MS);
    this.timer.unref(); // never keeps the server alive
  }

  unregister(key: object): void {
    this.regs.delete(key);
    if (this.regs.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.lastSampleAt = null;
    this.lastPowerAt = 0;
    this.prevProcCpu = null;
    try { this.deps.teardown(); } catch { /* optional */ }
  }

  /** One row to every registered folder. Exposed for tests; the timer calls it. Never throws. */
  async sampleOnce(): Promise<void> {
    // A slow `ps` on an overloaded machine must not pile up samples behind itself.
    if (this.sampling || !this.regs.size) return;
    this.sampling = true;
    try {
      const d = this.deps;
      const now = d.now();
      const cpuNow = d.cpuTimes();
      const cpuPct = this.prevCpu ? cpuPercent(this.prevCpu, cpuNow) : null;
      this.prevCpu = cpuNow;
      const [load1, load5] = d.loadavg();
      const mlx = d.mlxStats();

      const ps = await this.tryRun('ps', ['-Ao', 'pid=,pcpu=,rss=,time=,comm=']);
      const rows = ps ? parsePsOutput(ps) : null;
      const delta = this.prevProcCpu !== null && rows !== null;
      const loads = rows ? currentLoads(rows, this.prevProcCpu, (now - this.prevProcAt) / 1000) : null;
      if (rows) {
        this.prevProcCpu = new Map(rows.map(r => [r.pid, r.cpuSecs] as [number, number]));
        this.prevProcAt = now;
      }
      const memLevel = d.isMac ? await this.tryRun('sysctl', ['-n', 'kern.memorystatus_level']) : null;
      const power = await this.power(now);

      const worker = mlx.pid !== null ? loads?.find(l => l.pid === mlx.pid) : undefined;
      const base = {
        w: now,
        at: new Date(now).toISOString(),
        sinceLastMs: this.lastSampleAt === null ? null : now - this.lastSampleAt,
        sys: {
          cpuPct,
          load1: round1(load1),
          load5: round1(load5),
          freeMemMB: d.freememMB(),
          /** macOS "memory free" percentage (kern.memorystatus_level); low = memory pressure. */
          memFreePct: memLevel !== null && /^\d+$/.test(memLevel.trim()) ? Number(memLevel.trim()) : null,
        },
        node: { rssMB: d.rssMB(), loopDelayP99Ms: d.loopDelayP99Ms() },
        mlx: { ...mlx, cpuPct: worker?.cpuPct ?? null, rssMB: worker?.rssMB ?? null },
        // Busiest processes right now. The first sample only has ps's decayed average to go on ('ps-average').
        top: loads ? [...loads].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, TOP_PROCESSES) : null,
        topBasis: loads ? (delta ? 'delta' : 'ps-average') : null,
        power,
      };
      this.lastSampleAt = now;

      await Promise.all(Array.from(this.regs.values()).map(async ({ dir, backlog }) => {
        let chunks: ChunkBacklog | null = null;
        try { chunks = backlog(); } catch { /* leave null */ }
        try { await d.append(join(dir, 'machine.jsonl'), JSON.stringify({ ...base, chunks }) + '\n'); } catch { /* folder gone, disk full… */ }
      }));
    } catch {
      /* a sample that cannot be taken is just missing */
    } finally {
      this.sampling = false;
    }
  }

  /** Power and thermal state, refreshed every POWER_EVERY_MS; in between rows carry `null` (unchanged since the last full one). */
  private async power(now: number): Promise<PowerState | null> {
    if (!this.deps.isMac || (this.lastPower && now - this.lastPowerAt < POWER_EVERY_MS)) return null;
    const [batt, therm, all] = await Promise.all([
      this.tryRun('pmset', ['-g', 'batt']),
      this.tryRun('pmset', ['-g', 'therm']),
      this.tryRun('pmset', ['-g']),
    ]);
    this.lastPowerAt = now;
    this.lastPower = {
      ...(batt ? parseBatt(batt) : { source: null, batteryPct: null }),
      lowPowerMode: all ? parseLowPowerMode(all) : null,
      powerMode: all ? parsePowerMode(all) : null,
      cpuSpeedLimit: therm ? parseTherm(therm) : null,
    };
    return this.lastPower;
  }

  private async tryRun(cmd: string, args: string[]): Promise<string | null> {
    try { return await this.deps.run(cmd, args); } catch { return null; }
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The process-wide monitor used by the chunk pipeline. */
export const machineMonitor = new MachineMonitor();
