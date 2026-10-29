// How busy the browser's main thread was during a recording, for `dev:record` sessions: one row every
// 5 s (the server writes them to <session>/browser.jsonl, next to machine.jsonl and telemetry.jsonl —
// all three carry the same wall clock `w`).
//
// Why: on 28 Oct the audio callbacks stalled for up to 1.6 s late in the service while nothing said whether
// the page, the machine or the worker was to blame. Long tasks and timer lateness separate "the page was
// busy" from "the whole Mac was". Only started when the server says the archive is on.
//
// The environment is injectable so the windowing logic is unit-testable without a DOM.

export interface PerfRow {
  /** Wall clock, ms since epoch — the same clock as telemetry.jsonl's `w`. */
  w: number;
  /** The page was visible for the whole window. Hidden tabs have their timers throttled, so no drift is counted for them. */
  visible: boolean;
  /** Main-thread tasks over 50 ms (Long Tasks API) in this window. */
  longTasks: number;
  longTaskMs: number;
  maxLongTaskMs: number;
  /** How late the 1 s timer fired, at worst (0 = on time). */
  maxDriftMs: number;
  /** JS heap in use, MB (Chrome only). */
  heapMB: number | null;
}

export interface PerfMonitorEnv {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  /** Calls `cb(durationMs)` for each long task; returns the function that stops observing. */
  observeLongTasks(cb: (durationMs: number) => void): () => void;
  heapMB(): number | null;
  isVisible(): boolean;
}

const TICK_MS = 1000;
const WINDOW_TICKS = 5;

export function browserPerfEnv(): PerfMonitorEnv {
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    observeLongTasks: (cb) => {
      try {
        const observer = new PerformanceObserver((list) => list.getEntries().forEach(e => cb(e.duration)));
        observer.observe({ entryTypes: ['longtask'] });
        return () => observer.disconnect();
      } catch {
        return () => {}; // not supported (Safari, Firefox): the drift figure still works
      }
    },
    heapMB: () => {
      const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
      return memory?.usedJSHeapSize ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : null;
    },
    isVisible: () => document.visibilityState === 'visible',
  };
}

export class PerfMonitor {
  private timer: unknown = null;
  private stopObserving: (() => void) | null = null;
  private lastTickAt = 0;
  private ticks = 0;
  private longTasks = 0;
  private longTaskMs = 0;
  private maxLongTaskMs = 0;
  private maxDriftMs = 0;
  private visibleAllWindow = true;

  constructor(private readonly send: (rows: PerfRow[]) => void, private readonly env: PerfMonitorEnv = browserPerfEnv()) {}

  start(): void {
    if (this.timer !== null) return;
    this.resetWindow();
    this.lastTickAt = this.env.now();
    this.stopObserving = this.env.observeLongTasks((ms) => {
      this.longTasks++;
      this.longTaskMs += ms;
      this.maxLongTaskMs = Math.max(this.maxLongTaskMs, ms);
    });
    this.timer = this.env.setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    this.env.clearInterval(this.timer);
    this.timer = null;
    this.stopObserving?.();
    this.stopObserving = null;
  }

  private tick(): void {
    const now = this.env.now();
    const visible = this.env.isVisible();
    if (!visible) this.visibleAllWindow = false;
    // A hidden tab's timers are throttled by the browser, which says nothing about load.
    if (visible) this.maxDriftMs = Math.max(this.maxDriftMs, now - this.lastTickAt - TICK_MS);
    this.lastTickAt = now;
    if (++this.ticks < WINDOW_TICKS) return;
    try {
      this.send([{
        w: now,
        visible: this.visibleAllWindow,
        longTasks: this.longTasks,
        longTaskMs: Math.round(this.longTaskMs),
        maxLongTaskMs: Math.round(this.maxLongTaskMs),
        maxDriftMs: Math.round(this.maxDriftMs),
        heapMB: this.env.heapMB(),
      }]);
    } catch { /* socket gone: a missing row is fine */ }
    this.resetWindow();
  }

  private resetWindow(): void {
    this.ticks = 0;
    this.longTasks = 0;
    this.longTaskMs = 0;
    this.maxLongTaskMs = 0;
    this.maxDriftMs = 0;
    this.visibleAllWindow = true;
  }
}
