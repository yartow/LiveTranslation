// Live health of the transcribe -> translate pipeline, for the "Pipeline" popover in the audio bar:
// how long chunks take to come back, how many are waiting, how translation calls are doing. Pure and
// DOM-free (the clock is a parameter) so the maths is unit-testable. Not an external store: the
// popover polls snapshot(now) once a second, because "how long has the oldest chunk been waiting"
// changes with time alone, with no event to subscribe to.

export type HealthLevel = 'ok' | 'warn' | 'bad';

export interface PipelineSnapshot {
  /** Commit -> delivered delay of the last chunk / median of the recent ones (ms); null before the first. */
  chunkDelayLastMs: number | null;
  chunkDelayMedianMs: number | null;
  /** Chunks sent and not yet reported done, and how long the oldest has been waiting. */
  backlog: number;
  oldestPendingMs: number;
  reconnects: number;
  translateLastMs: number | null;
  translateMedianMs: number | null;
  /** Translate failures in the last 10 minutes, of which rate-limit (429) ones. */
  translateErrors: number;
  rateLimited: number;
  level: HealthLevel;
  /** Why the level is not 'ok', in words (empty when ok). */
  reason: string;
}

const SAMPLES = 20;
const WINDOW_MS = 10 * 60_000;
const RECENT_ERRORS_MS = 2 * 60_000;

// Thresholds. A chunk is 4-15 s of speech and Whisper takes 1-2.5 s on the M1 (CLAUDE.md), so a healthy
// delay is a few seconds; many seconds more, or chunks piling up, means the worker or the network is behind.
const WARN_BACKLOG = 3;
const BAD_BACKLOG = 6;
const WARN_DELAY_MS = 12_000;
const BAD_DELAY_MS = 25_000;
const BAD_RECENT_TRANSLATE_ERRORS = 3;

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export class PipelineStats {
  private pending = new Map<number, number>(); // chunkIndex -> sent at
  private delays: number[] = [];
  private reconnectCount = 0;
  private translateMs: number[] = [];
  private errors: Array<{ at: number; rateLimited: boolean }> = [];

  /** A chunk was handed to the server. */
  chunkSent(chunkIndex: number, now: number): void {
    this.pending.set(chunkIndex, now);
  }

  /** The server says every chunk below `done` has been handled (text delivered, or nothing to deliver). */
  chunkProgress(done: number, now: number): void {
    this.pending.forEach((sentAt, index) => {
      if (index >= done) return;
      this.delays.push(Math.max(0, now - sentAt));
      if (this.delays.length > SAMPLES) this.delays.shift();
      this.pending.delete(index);
    });
  }

  reconnecting(): void { this.reconnectCount++; }

  translateOk(ms: number): void {
    this.translateMs.push(ms);
    if (this.translateMs.length > SAMPLES) this.translateMs.shift();
  }

  translateError(rateLimited: boolean, now: number): void {
    this.errors.push({ at: now, rateLimited });
  }

  /** A new recording: nothing from the last one is still pending. */
  resetPending(): void { this.pending.clear(); }

  snapshot(now: number): PipelineSnapshot {
    this.errors = this.errors.filter(e => now - e.at <= WINDOW_MS);
    const backlog = this.pending.size;
    let oldestPendingMs = 0;
    this.pending.forEach(sentAt => { oldestPendingMs = Math.max(oldestPendingMs, now - sentAt); });
    const lastDelay = this.delays.length ? this.delays[this.delays.length - 1] : null;
    const recentErrors = this.errors.filter(e => now - e.at <= RECENT_ERRORS_MS).length;

    let level: HealthLevel = 'ok';
    let reason = '';
    const raise = (to: HealthLevel, why: string) => {
      if (to === 'bad' || (to === 'warn' && level === 'ok')) { level = to; reason = why; }
    };
    if (backlog >= WARN_BACKLOG) raise('warn', `${backlog} chunks waiting for the server`);
    if (oldestPendingMs > WARN_DELAY_MS || (lastDelay ?? 0) > WARN_DELAY_MS) raise('warn', 'transcription is running behind');
    if (backlog >= BAD_BACKLOG) raise('bad', `${backlog} chunks waiting for the server`);
    if (oldestPendingMs > BAD_DELAY_MS || (lastDelay ?? 0) > BAD_DELAY_MS) raise('bad', 'transcription is far behind');
    if (recentErrors >= BAD_RECENT_TRANSLATE_ERRORS) raise('bad', `${recentErrors} translation errors in the last 2 minutes`);

    return {
      chunkDelayLastMs: lastDelay,
      chunkDelayMedianMs: median(this.delays),
      backlog,
      oldestPendingMs,
      reconnects: this.reconnectCount,
      translateLastMs: this.translateMs.length ? this.translateMs[this.translateMs.length - 1] : null,
      translateMedianMs: median(this.translateMs),
      translateErrors: this.errors.length,
      rateLimited: this.errors.filter(e => e.rateLimited).length,
      level,
      reason,
    };
  }
}
