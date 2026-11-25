import { describe, it, expect } from 'vitest';
import { PerfMonitor, type PerfMonitorEnv, type PerfRow } from '../../client/src/lib/sermon/perf-monitor.js';

/** A fake clock and timer: `advance(ms, lateBy)` fires the 1 s tick, optionally late. */
function fakeEnv() {
  let now = 1_000_000;
  let tick: (() => void) | null = null;
  let longTaskCb: ((ms: number) => void) | null = null;
  let observing = false;
  let visible = true;
  let heap: number | null = 120;
  const env: PerfMonitorEnv = {
    now: () => now,
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => { tick = null; },
    observeLongTasks: (cb) => { longTaskCb = cb; observing = true; return () => { observing = false; longTaskCb = null; }; },
    heapMB: () => heap,
    isVisible: () => visible,
  };
  return {
    env,
    second(lateByMs = 0) { now += 1000 + lateByMs; tick?.(); },
    longTask(ms: number) { longTaskCb?.(ms); },
    setVisible(v: boolean) { visible = v; },
    setHeap(h: number | null) { heap = h; },
    get observing() { return observing; },
    get running() { return tick !== null; },
  };
}

describe('PerfMonitor', () => {
  it('sends one row every 5 s with the window\'s long tasks and worst timer lateness', () => {
    const fake = fakeEnv();
    const rows: PerfRow[] = [];
    const monitor = new PerfMonitor((r) => rows.push(...r), fake.env);
    monitor.start();
    fake.second(); fake.longTask(80); fake.second(400); fake.longTask(120); fake.longTask(60); fake.second(); fake.second(150);
    expect(rows).toHaveLength(0);
    fake.second();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ visible: true, longTasks: 3, longTaskMs: 260, maxLongTaskMs: 120, maxDriftMs: 400, heapMB: 120 });
    expect(rows[0].w).toBe(1_000_000 + 5 * 1000 + 550);
  });

  it('starts every window from zero', () => {
    const fake = fakeEnv();
    const rows: PerfRow[] = [];
    new PerfMonitor((r) => rows.push(...r), fake.env).start();
    fake.longTask(90); fake.second(900);
    for (let i = 0; i < 4; i++) fake.second();
    for (let i = 0; i < 5; i++) fake.second();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ longTasks: 1, maxDriftMs: 900 });
    expect(rows[1]).toMatchObject({ longTasks: 0, longTaskMs: 0, maxLongTaskMs: 0, maxDriftMs: 0 });
  });

  it('does not read a hidden tab\'s throttled timers as load', () => {
    const fake = fakeEnv();
    const rows: PerfRow[] = [];
    new PerfMonitor((r) => rows.push(...r), fake.env).start();
    fake.second();
    fake.setVisible(false);
    fake.second(59_000); // Chrome throttles a background tab hard
    fake.setVisible(true);
    fake.second(); fake.second(); fake.second();
    expect(rows[0]).toMatchObject({ visible: false, maxDriftMs: 0 });
  });

  it('reports a missing heap figure as null', () => {
    const fake = fakeEnv();
    const rows: PerfRow[] = [];
    new PerfMonitor((r) => rows.push(...r), fake.env).start();
    fake.setHeap(null);
    for (let i = 0; i < 5; i++) fake.second();
    expect(rows[0].heapMB).toBeNull();
  });

  it('stops its timer and observer, can start again, and ignores a second start', () => {
    const fake = fakeEnv();
    const monitor = new PerfMonitor(() => {}, fake.env);
    monitor.start();
    monitor.start();
    expect(fake.running && fake.observing).toBe(true);
    monitor.stop();
    expect(fake.running || fake.observing).toBe(false);
    monitor.stop(); // harmless twice
    monitor.start();
    expect(fake.running && fake.observing).toBe(true);
  });

  it('survives a send that throws', () => {
    const fake = fakeEnv();
    new PerfMonitor(() => { throw new Error('socket closed'); }, fake.env).start();
    expect(() => { for (let i = 0; i < 5; i++) fake.second(); }).not.toThrow();
  });
});
