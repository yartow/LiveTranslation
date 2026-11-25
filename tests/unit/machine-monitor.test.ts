import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  MachineMonitor, parsePsOutput, parseCpuTime, currentLoads, parseBatt, parseTherm, parseLowPowerMode, parsePowerMode, cpuPercent,
  type MachineMonitorDeps,
} from '../../server/lib/machine-monitor.js';

// Shapes copied from `ps -Ao pid=,pcpu=,rss=,time=,comm=` on macOS (TIME is minutes:seconds.centiseconds).
const PS = `
    1   0.0  14336     0:25.31 /sbin/launchd
  412  38.5 912340  1769:21.42 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/155/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)
  977  21.0 2201344  300:49.67 /Users/andrewyong/miniconda3/bin/python3.11
  530   4.2   88000   12:00.00 /Applications/Typinator.app/Contents/MacOS/Typinator
 1203   0.4   51200    0:00.40 /usr/sbin/cfprefsd
garbage line that is not a process
`;

describe('parseCpuTime', () => {
  it('reads the TIME formats ps uses', () => {
    expect(parseCpuTime('769:21.42')).toBeCloseTo(46161.42); // 769 × 60 + 21.42
    expect(parseCpuTime('0:00.05')).toBeCloseTo(0.05);
    expect(parseCpuTime('1:02:03')).toBe(3723);
    expect(parseCpuTime('2-01:02:03')).toBe(2 * 86400 + 3723);
    expect(parseCpuTime('12')).toBe(12);
  });
  it('gives null for anything else', () => {
    expect(parseCpuTime('')).toBeNull();
    expect(parseCpuTime('abc')).toBeNull();
    expect(parseCpuTime('-')).toBeNull();
  });
});

describe('parsePsOutput', () => {
  it('reads every process row, with short names, and skips lines that are not one', () => {
    const rows = parsePsOutput(PS);
    expect(rows.map(r => r.pid)).toEqual([1, 412, 977, 530, 1203]);
    expect(rows[1]).toMatchObject({ name: 'Google Chrome Helper (Renderer)', avgCpuPct: 38.5, rssMB: 891 });
    expect(rows[1].cpuSecs).toBeCloseTo(106161.42);
    expect(rows[2]).toMatchObject({ name: 'python3.11', rssMB: 2150 });
  });
  it('copes with empty output', () => {
    expect(parsePsOutput('')).toEqual([]);
  });
});

describe('currentLoads', () => {
  const rows = parsePsOutput(PS);
  it('uses the CPU time used since the previous sample, not the decayed average', () => {
    // Over the last 5 s Chrome used 7.5 CPU-seconds (150 %), Typinator nothing, the python worker 2.5 s (50 %).
    const prev = new Map<number, number>([[412, rows[1].cpuSecs - 7.5], [530, rows[3].cpuSecs], [977, rows[2].cpuSecs - 2.5]]);
    const loads = currentLoads(rows, prev, 5);
    expect(loads.find(l => l.pid === 412)!.cpuPct).toBe(150);
    expect(loads.find(l => l.pid === 530)!.cpuPct).toBe(0);
    expect(loads.find(l => l.pid === 977)!.cpuPct).toBe(50);
  });
  it('falls back to ps\'s average on the first sample and for processes it has not seen', () => {
    expect(currentLoads(rows, null, 5).find(l => l.pid === 412)!.cpuPct).toBe(38.5);
    expect(currentLoads(rows, new Map(), 5).find(l => l.pid === 977)!.cpuPct).toBe(21);
  });
  it('never goes negative when a pid was reused', () => {
    const loads = currentLoads(rows, new Map([[412, rows[1].cpuSecs + 100]]), 5);
    expect(loads.find(l => l.pid === 412)!.cpuPct).toBe(0);
  });
});

describe('pmset parsing', () => {
  it('reads the power source and charge', () => {
    expect(parseBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t83%; discharging; 4:12 remaining present: true"))
      .toEqual({ source: 'Battery', batteryPct: 83 });
    expect(parseBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true"))
      .toEqual({ source: 'AC', batteryPct: 100 });
    expect(parseBatt('')).toEqual({ source: null, batteryPct: null });
  });
  it('reports a CPU speed limit only when macOS recorded throttling', () => {
    expect(parseTherm('Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded')).toBeNull();
    expect(parseTherm('CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 70')).toBe(70);
  });
  it('reads low power mode: present when on, absent when off', () => {
    expect(parseLowPowerMode('System-wide power settings:\nCurrently in use:\n sleep                 1\n lowpowermode         1\n')).toBe(true);
    expect(parseLowPowerMode('Currently in use:\n powermode            1\n')).toBe(true);
    // Real output of an M-series MacBook with it off (no lowpowermode line at all):
    expect(parseLowPowerMode('System-wide power settings:\nCurrently in use:\n standby              1\n sleep                30 (sleep prevented by caffeinate, powerd)\n powermode            2\n')).toBe(false);
    expect(parseLowPowerMode('')).toBeNull();
    expect(parseLowPowerMode('nothing here')).toBeNull();
  });
  it('reads the macOS power mode', () => {
    expect(parsePowerMode(' standby              1\n powermode            2\n womp  0')).toBe(2);
    expect(parsePowerMode(' lowpowermode 1')).toBeNull();
  });
});

describe('cpuPercent', () => {
  it('is the busy share of the elapsed CPU time across all cores', () => {
    const a = [{ idle: 100, total: 200 }, { idle: 100, total: 200 }];
    const b = [{ idle: 150, total: 300 }, { idle: 100, total: 300 }]; // core 1 half idle, core 2 fully busy
    expect(cpuPercent(a, b)).toBe(75);
  });
  it('gives null when it cannot tell', () => {
    expect(cpuPercent([], [])).toBeNull();
    expect(cpuPercent([{ idle: 1, total: 2 }], [{ idle: 1, total: 2 }])).toBeNull();
    expect(cpuPercent([{ idle: 1, total: 2 }], [])).toBeNull();
  });
});

function fakeDeps(over: Partial<MachineMonitorDeps> = {}, psText: () => string = () => PS): MachineMonitorDeps & { written: Array<{ file: string; row: any }>; run: ReturnType<typeof vi.fn> } {
  const written: Array<{ file: string; row: any }> = [];
  let tick = 0;
  const run = vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === 'ps') return psText();
    if (cmd === 'sysctl') return '42\n';
    if (args.join(' ') === '-g batt') return "Now drawing from 'Battery Power'\n -InternalBattery-0\t55%; discharging";
    if (args.join(' ') === '-g therm') return 'CPU_Speed_Limit \t= 80';
    if (cmd === 'pmset') return 'Currently in use:\n lowpowermode         1\n powermode            1\n';
    throw new Error(`unexpected ${cmd}`);
  });
  return {
    run,
    append: async (file, text) => { written.push({ file, row: JSON.parse(text) }); },
    now: () => 1_000_000 + 5000 * tick++,
    isMac: true,
    cpuTimes: () => [{ idle: 10 * tick, total: 20 * tick + 20 }],
    loadavg: () => [3.14, 2.5, 1],
    freememMB: () => 800,
    rssMB: () => 300,
    loopDelayP99Ms: () => 12.5,
    mlxStats: () => ({ pid: 977, ready: true, busy: true, queued: 2, spawns: 1 }),
    setup: () => {},
    teardown: () => {},
    written,
    ...over,
  } as MachineMonitorDeps & { written: Array<{ file: string; row: any }>; run: ReturnType<typeof vi.fn> };
}

describe('MachineMonitor', () => {
  afterEach(() => vi.useRealTimers());

  it('writes one full row per registered folder', async () => {
    const deps = fakeDeps();
    const monitor = new MachineMonitor(deps);
    const key = {};
    monitor.register(key, '/tmp/session-a', () => ({ inFlight: 4, waitingForEarlier: 1, oldestMs: 9000 }));
    await monitor.sampleOnce();
    monitor.unregister(key);

    expect(deps.written).toHaveLength(1);
    const { file, row } = deps.written[0];
    expect(file).toBe('/tmp/session-a/machine.jsonl');
    expect(row.sys).toEqual({ cpuPct: 50, load1: 3.1, load5: 2.5, freeMemMB: 800, memFreePct: 42 });
    expect(row.node).toEqual({ rssMB: 300, loopDelayP99Ms: 12.5 });
    expect(row.mlx).toMatchObject({ pid: 977, busy: true, queued: 2, spawns: 1, cpuPct: 21, rssMB: 2150 });
    expect(row.top).toHaveLength(5); // the five parseable processes of the sample (the garbage line is skipped)
    expect(row.top[0].name).toBe('Google Chrome Helper (Renderer)');
    expect(row.topBasis).toBe('ps-average'); // nothing to take a difference against yet
    expect(row.chunks).toEqual({ inFlight: 4, waitingForEarlier: 1, oldestMs: 9000 });
    expect(row.power).toEqual({ source: 'Battery', batteryPct: 55, lowPowerMode: true, powerMode: 1, cpuSpeedLimit: 80 });
    expect(row.sinceLastMs).toBeNull();
  });

  it('ranks processes by what they used since the previous sample', async () => {
    // Between the two samples (5 s apart) Typinator burns 10 CPU-seconds; Chrome, busiest by ps's average, idles.
    let second = false;
    const deps = fakeDeps({}, () => second
      ? PS.replace('1769:21.42', '1769:21.42').replace('12:00.00', '12:10.00')
      : PS);
    const monitor = new MachineMonitor(deps);
    const key = {};
    monitor.register(key, '/tmp/s', () => ({ inFlight: 0, waitingForEarlier: 0, oldestMs: null }));
    await monitor.sampleOnce();
    second = true;
    await monitor.sampleOnce();
    monitor.unregister(key);
    const row = deps.written[1].row;
    expect(row.topBasis).toBe('delta');
    expect(row.top[0]).toMatchObject({ name: 'Typinator', cpuPct: 200 });
    expect(row.top.find((t: any) => t.name.startsWith('Google Chrome'))!.cpuPct).toBe(0);
    expect(row.mlx.cpuPct).toBe(0);
  });

  it('writes to every folder that is being recorded, each with its own backlog', async () => {
    const deps = fakeDeps();
    const monitor = new MachineMonitor(deps);
    const a = {}; const b = {};
    monitor.register(a, '/tmp/a', () => ({ inFlight: 1, waitingForEarlier: 0, oldestMs: null }));
    monitor.register(b, '/tmp/b', () => ({ inFlight: 9, waitingForEarlier: 3, oldestMs: 60_000 }));
    await monitor.sampleOnce();
    const byFile = Object.fromEntries(deps.written.map(w => [w.file, w.row.chunks.inFlight]));
    expect(byFile).toEqual({ '/tmp/a/machine.jsonl': 1, '/tmp/b/machine.jsonl': 9 });
    monitor.unregister(a);
    expect(monitor.isRunning()).toBe(true); // b is still recording
    monitor.unregister(b);
    expect(monitor.isRunning()).toBe(false);
  });

  it('refreshes power and thermal state only every 30 s, and reports the gaps in between as null', async () => {
    const deps = fakeDeps();
    const monitor = new MachineMonitor(deps);
    const key = {};
    monitor.register(key, '/tmp/s', () => ({ inFlight: 0, waitingForEarlier: 0, oldestMs: null }));
    for (let i = 0; i < 8; i++) await monitor.sampleOnce(); // 5 s apart on the fake clock
    const withPower = deps.written.map(w => w.row.power !== null);
    expect(withPower).toEqual([true, false, false, false, false, false, true, false]);
    expect(deps.written[1].row.sinceLastMs).toBe(5000);
    monitor.unregister(key);
  });

  it('keeps going when ps, sysctl and pmset all fail, and when a write fails', async () => {
    const deps = fakeDeps({ run: vi.fn(async () => { throw new Error('boom'); }), append: async () => { throw new Error('disk full'); } });
    const monitor = new MachineMonitor(deps);
    const key = {};
    monitor.register(key, '/tmp/s', () => { throw new Error('backlog failed'); });
    await expect(monitor.sampleOnce()).resolves.toBeUndefined();
    monitor.unregister(key);
  });

  it('leaves out the Mac-only probes elsewhere', async () => {
    const deps = fakeDeps({ isMac: false });
    const monitor = new MachineMonitor(deps);
    const key = {};
    monitor.register(key, '/tmp/s', () => ({ inFlight: 0, waitingForEarlier: 0, oldestMs: null }));
    await monitor.sampleOnce();
    expect(deps.written[0].row.power).toBeNull();
    expect(deps.written[0].row.sys.memFreePct).toBeNull();
    expect(deps.run.mock.calls.map(c => c[0])).toEqual(['ps']);
    monitor.unregister(key);
  });

  it('does not stack samples behind a slow one', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const deps = fakeDeps({ run: vi.fn(async (cmd: string) => { if (cmd === 'ps') await gate; return ''; }) });
    const monitor = new MachineMonitor(deps);
    const key = {};
    monitor.register(key, '/tmp/s', () => ({ inFlight: 0, waitingForEarlier: 0, oldestMs: null }));
    const first = monitor.sampleOnce();
    await monitor.sampleOnce(); // returns at once: the first is still waiting on ps
    release();
    await first;
    expect(deps.written).toHaveLength(1);
    monitor.unregister(key);
  });

  it('samples on a timer while a recording is registered, and stops when the last one ends', async () => {
    vi.useFakeTimers();
    const deps = fakeDeps();
    const monitor = new MachineMonitor(deps);
    const key = {};
    monitor.register(key, '/tmp/s', () => ({ inFlight: 0, waitingForEarlier: 0, oldestMs: null }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deps.written.length).toBe(3);
    monitor.unregister(key);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(deps.written.length).toBe(3);
  });
});
