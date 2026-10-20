// Input-level metering for the sermon audio bar. Pure and DOM-free (like the rest
// of lib/sermon) so the maths is unit-testable; the React side subscribes through
// useSyncExternalStore, which keeps the ~4-12 updates/s of audio frames out of
// SermonMode's own render path.

/** Meter floor: anything quieter reads as silence. */
export const METER_FLOOR_DB = -60;
/** A peak this high means samples are being clipped by the input stage. */
export const CLIP_PEAK = 0.95;
const CLIP_HOLD_MS = 1500;
/** Release time: how fast the bar falls (it rises instantly, so a shout is never missed). */
const RELEASE = 0.15;

export function rmsToDb(rms: number): number {
  if (!(rms > 0)) return METER_FLOOR_DB;
  return Math.max(METER_FLOOR_DB, 20 * Math.log10(rms));
}

/** 0-1 bar fill for a dBFS value on the -60..0 scale. */
export function dbToFraction(db: number): number {
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

export type LevelZone = 'silent' | 'low' | 'good' | 'hot' | 'clipping';

/**
 * Speech through Whisper is happiest with peaks around -18..-6 dBFS: below that
 * the speech gate starts missing words, above it the top of the wave flattens.
 */
export function levelZone(db: number, clipping: boolean): LevelZone {
  if (clipping) return 'clipping';
  if (db <= -55) return 'silent';
  if (db < -30) return 'low';
  if (db < -6) return 'good';
  return 'hot';
}

export interface LevelSnapshot {
  /** Smoothed RMS in dBFS (-60 = silence). */
  db: number;
  /** True for ~1.5 s after a frame peaked at/above CLIP_PEAK. */
  clipping: boolean;
}

const SILENT: LevelSnapshot = { db: METER_FLOOR_DB, clipping: false };

export class LevelStore {
  private snapshot: LevelSnapshot = SILENT;
  private smoothedLinear = 0;
  private clipUntil = 0;
  private listeners = new Set<() => void>();

  /** One audio frame. rms/peak are 0-1 linear; `now` is injectable for tests. */
  push(rms: number, peak: number = 0, now: number = Date.now()): void {
    // Instant attack, slow release.
    this.smoothedLinear = rms > this.smoothedLinear ? rms : this.smoothedLinear * (1 - RELEASE) + rms * RELEASE;
    if (peak >= CLIP_PEAK) this.clipUntil = now + CLIP_HOLD_MS;
    this.publish({ db: rmsToDb(this.smoothedLinear), clipping: now < this.clipUntil });
  }

  /** Recording stopped or paused. */
  reset(): void {
    this.smoothedLinear = 0;
    this.clipUntil = 0;
    this.publish(SILENT);
  }

  private publish(next: LevelSnapshot): void {
    // Keep the snapshot reference stable when nothing visible changed (useSyncExternalStore requirement).
    if (Math.round(next.db) === Math.round(this.snapshot.db) && next.clipping === this.snapshot.clipping) return;
    this.snapshot = next;
    this.listeners.forEach(l => l());
  }

  getSnapshot = (): LevelSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}
