import { describe, it, expect } from 'vitest';
import {
  summarizeLoad, formatLoadTable, notesFor, recordingStartWall,
  type MachineRow, type BrowserRow, type TelemetryRow, type ChunkTiming, type LoadMinute,
} from '../../scripts/lib/load-summary.js';

const START = 1_000_000_000;
const at = (secs: number) => START + secs * 1000;

const machine = (secs: number, over: Partial<MachineRow> = {}): MachineRow => ({
  w: at(secs),
  sys: { cpuPct: 30, load1: 2, memFreePct: 60 },
  mlx: { cpuPct: 20, busy: true, queued: 0 },
  top: [{ name: 'Google Chrome Helper', cpuPct: 45 }],
  power: null,
  chunks: { inFlight: 1, oldestMs: 3000 },
  ...over,
});
const chunk = (startSecs: number, over: Partial<ChunkTiming> = {}): ChunkTiming => ({
  startSecs, decodeSecs: 1.5, slotWaitSecs: 0.1, lagSecs: 2, fallbackSegments: 0, aborted: false, ...over,
});

describe('recordingStartWall', () => {
  it('works back from the first telemetry row, else uses the page start time', () => {
    expect(recordingStartWall([{ t: 0.256, w: at(10.256) }], 5)).toBeCloseTo(at(10));
    expect(recordingStartWall([], 1234)).toBe(1234);
    expect(recordingStartWall([], null)).toBeNull();
  });
});

describe('summarizeLoad', () => {
  it('groups everything by recording minute', () => {
    const minutes = summarizeLoad({
      startWall: START,
      machine: [
        machine(5, { sys: { cpuPct: 20, load1: 1, memFreePct: 70 } }),
        machine(35, { sys: { cpuPct: 60, load1: 5.5, memFreePct: 40 } }),
        machine(65, { sys: { cpuPct: 95, load1: 9, memFreePct: 8 } }),
      ],
      browser: [], telemetry: [], chunks: [],
    });
    expect(minutes.map(m => m.minute)).toEqual([0, 1]);
    expect(minutes[0]).toMatchObject({ samples: 2, cpuAvg: 40, cpuMax: 60, load1Max: 5.5, memFreeMin: 40 });
    expect(minutes[1]).toMatchObject({ cpuMax: 95, memFreeMin: 8 });
    expect(minutes[1].notes).toEqual(expect.arrayContaining(['CPU-SATURATED', 'LOW-MEMORY']));
  });

  it('ignores machine rows from before the recording started', () => {
    const minutes = summarizeLoad({ startWall: START, machine: [machine(-30), machine(10)], browser: [], telemetry: [], chunks: [] });
    expect(minutes).toHaveLength(1);
    expect(minutes[0].samples).toBe(1);
  });

  it('reports the busiest process, the worker, the queue and the power state', () => {
    const [m] = summarizeLoad({
      startWall: START,
      machine: [
        machine(5, { top: [{ name: 'python3.11', cpuPct: 80 }], mlx: { cpuPct: 80, busy: true, queued: 3 }, chunks: { inFlight: 4, oldestMs: 9000 } }),
        machine(10, { top: [{ name: 'Google Chrome Helper', cpuPct: 90 }], mlx: { cpuPct: 5, busy: false, queued: 0 }, chunks: { inFlight: 2, oldestMs: 45_000 } }),
        machine(15, { top: [{ name: 'Google Chrome Helper', cpuPct: 60 }], power: { source: 'Battery', cpuSpeedLimit: 70, lowPowerMode: true } }),
      ],
      browser: [], telemetry: [], chunks: [],
    });
    expect(m).toMatchObject({ topName: 'Google Chrome Helper', topCpu: 90, mlxCpuMax: 80, inFlightMax: 4, oldestMaxSecs: 45, battery: true, lowPower: true, speedLimitMin: 70 });
    expect(m.mlxBusyPct).toBe(67);
    expect(m.notes).toEqual(expect.arrayContaining(['BATTERY', 'LOW-POWER-MODE', 'THROTTLED-70%']));
  });

  it('puts decode time, slot wait, lateness, decode retries and aborted chunks on the minute the chunk started', () => {
    const minutes = summarizeLoad({
      startWall: START, machine: [], browser: [], telemetry: [],
      chunks: [
        chunk(10), chunk(70, { decodeSecs: 40, slotWaitSecs: 55, lagSecs: 90, fallbackSegments: 2 }),
        chunk(75, { lagSecs: 100, aborted: true }), chunk(80, { decodeSecs: null, slotWaitSecs: null, lagSecs: null, aborted: true }),
      ],
    });
    expect(minutes[0]).toMatchObject({ decodeMaxSecs: 1.5, lagMaxSecs: 2, abortedChunks: 0, notes: [] });
    expect(minutes[1]).toMatchObject({ decodeMaxSecs: 40, slotWaitMaxSecs: 55, lagMaxSecs: 100, fallbackSegments: 2, abortedChunks: 2 });
    expect(minutes[1].notes).toEqual(expect.arrayContaining(['DECODE-RETRIES-2', 'BEHIND-100s', 'ABORTED-2']));
  });

  it('finds page stalls two ways: the biggest gap between audio frames, and late timers (visible tabs only)', () => {
    const telemetry: TelemetryRow[] = [
      { t: 0, w: at(0) }, { t: 0.256, w: at(0.26) }, { t: 0.512, w: at(0.52) }, { t: 0.768, w: at(2.3) }, // a 1.8 s stall
    ];
    const browser: BrowserRow[] = [
      { w: at(5), visible: true, longTaskMs: 300, maxDriftMs: 120 },
      { w: at(10), visible: false, longTaskMs: 0, maxDriftMs: 59_000 }, // hidden tab: throttled, not load
      { w: at(15), visible: true, longTaskMs: 150, maxDriftMs: 80 },
    ];
    const [m] = summarizeLoad({ startWall: START, machine: [], browser, telemetry, chunks: [] });
    expect(m.frameGapMaxMs).toBe(1780);
    expect(m.pageDriftMaxMs).toBe(120);
    expect(m.longTaskMs).toBe(450);
    expect(m.notes).toContain('PAGE-STALLED');
  });

  it('flags minutes where chunks waited for a worker that was still loading its model', () => {
    const [m0, m1] = summarizeLoad({
      startWall: START,
      machine: [
        machine(10, { mlx: { cpuPct: 5, busy: false, queued: 0, ready: false, pid: 4242 }, chunks: { inFlight: 3, oldestMs: 20_000 } }),
        machine(70, { mlx: { cpuPct: 5, busy: false, queued: 0, ready: false, pid: 4242 }, chunks: { inFlight: 0, oldestMs: null } }), // loading, but nothing waiting
      ],
      browser: [], telemetry: [], chunks: [],
    });
    expect(m0.workerLoading).toBe(true);
    expect(m0.notes).toContain('WORKER-LOADING');
    expect(m1.workerLoading).toBe(false);
  });

  it('does not blame a worker that was never started (OpenAI engine)', () => {
    const [m] = summarizeLoad({
      startWall: START,
      machine: [machine(10, { mlx: { cpuPct: null, busy: false, queued: 0, ready: false, pid: null }, chunks: { inFlight: 3, oldestMs: 2_000 } })],
      browser: [], telemetry: [], chunks: [],
    });
    expect(m.workerLoading).toBe(false);
  });

  it('does not count the pause before a resumed row as a page stall', () => {
    const telemetry = [
      { t: 10, w: START + 10_000 },
      { t: 10.256, w: START + 130_000, resumed: true }, // paused for two minutes
      { t: 10.512, w: START + 130_256 },
    ];
    const [m] = summarizeLoad({ startWall: START, machine: [], browser: [], telemetry, chunks: [] });
    expect(m.frameGapMaxMs).toBe(256);
    expect(m.notes).not.toContain('PAGE-STALLED');
  });

  it('leaves unknown figures empty rather than inventing zeros', () => {
    const [m] = summarizeLoad({ startWall: START, machine: [], browser: [], telemetry: [], chunks: [chunk(5)] });
    expect(m).toMatchObject({ samples: 0, cpuAvg: null, memFreeMin: null, mlxBusyPct: null, topName: null, longTaskMs: null, pageDriftMaxMs: null, frameGapMaxMs: null });
  });
});

describe('notesFor', () => {
  const quiet = summarizeLoad({ startWall: START, machine: [machine(1)], browser: [], telemetry: [], chunks: [chunk(1)] })[0];
  it('is silent for a healthy minute', () => {
    expect(notesFor(quiet)).toEqual([]);
  });
  it('does not call a throttle limit of 100 % throttling', () => {
    expect(notesFor({ ...quiet, speedLimitMin: 100 })).toEqual([]);
  });
});

describe('formatLoadTable', () => {
  it('prints a header and one line per minute, with notes at the end', () => {
    const minutes: LoadMinute[] = summarizeLoad({
      startWall: START,
      machine: [machine(5), machine(65, { sys: { cpuPct: 99, load1: 12, memFreePct: 5 }, power: { source: 'Battery', cpuSpeedLimit: null, lowPowerMode: false } })],
      browser: [], telemetry: [], chunks: [chunk(70, { lagSecs: 150 })],
    });
    const lines = formatLoadTable(minutes);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^min\s+cpu/);
    expect(lines[1]).not.toMatch(/BATTERY/);
    expect(lines[2]).toMatch(/BATTERY.*CPU-SATURATED|CPU-SATURATED.*BATTERY/);
    expect(lines[2]).toMatch(/BEHIND-150s/);
    expect(lines[2]).toMatch(/Google Chrome Helper \(45\)/);
  });
});
