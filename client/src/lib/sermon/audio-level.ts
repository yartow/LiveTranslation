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

/** RMS below this (-70 dBFS) is "no sound at all", e.g. a wireless receiver whose transmitter is off. */
const SOUND_RMS = 10 ** (-70 / 20);

const SILENT: LevelSnapshot = { db: METER_FLOOR_DB, clipping: false };

// ── "Is the level right?" verdict ────────────────────────────────────────────
// Judged on the 90th percentile of the per-frame peaks of the last 10 s, not on RMS: on the
// 28 Oct service the room hiss (-38..-42 dBFS), faint speech (-24..-29) and good speech
// (-12..-17) were cleanly apart in windowed peaks but overlapped in RMS (-63 vs -50).
/** Window the verdict looks at; nothing is said until a full window has been heard. */
const VERDICT_WINDOW_MS = 10_000;
/** A different verdict must hold this long before it is shown (the poll runs once a second). */
const VERDICT_HOLD_MS = 3_000;
/** Below this p90 peak at the microphone (before gain) there is nothing but noise: -33 dBFS. */
const NO_SPEECH_PEAK = 10 ** (-33 / 20);
/** Below this p90 peak after gain, Whisper hears a weak signal: -20 dBFS. */
const QUIET_PEAK = 10 ** (-20 / 20);
/** Above this p90 peak after gain the top of the wave is about to flatten: -3 dBFS. */
const LOUD_PEAK = 10 ** (-3 / 20);
/** +3 dB: how far back past a boundary the level must come before a warning is withdrawn. */
const RELEASE_MARGIN = 10 ** (3 / 20);
/** Same bounds as ChunkBasedTranscription.setNormalizationGain. */
const MIN_GAIN = 0.1;
const MAX_GAIN = 10;

export type SpeechVerdict = 'no-speech' | 'too-quiet' | 'ok' | 'too-loud';

export class LevelStore {
  private snapshot: LevelSnapshot = SILENT;
  private smoothedLinear = 0;
  private clipUntil = 0;
  private lastSoundAt: number | null = null;
  private clockStart = 0;
  private listeners = new Set<() => void>();

  // Verdict state. Peaks are kept before gain so a gain change applies to what was already heard.
  private gain = 1;
  private frames: Array<{ t: number; peak: number }> = [];
  private firstFrameAt: number | null = null;
  private shownVerdict: SpeechVerdict | null = null;
  private candidate: { verdict: SpeechVerdict; since: number } | null = null;

  /** One audio frame. rms/peak are 0-1 linear; `now` is injectable for tests. */
  push(rms: number, peak: number = 0, now: number = Date.now()): void {
    // Instant attack, slow release.
    this.smoothedLinear = rms > this.smoothedLinear ? rms : this.smoothedLinear * (1 - RELEASE) + rms * RELEASE;
    if (peak >= CLIP_PEAK) this.clipUntil = now + CLIP_HOLD_MS;
    if (rms > SOUND_RMS) this.lastSoundAt = now;
    if (this.firstFrameAt === null) this.firstFrameAt = now;
    this.frames.push({ t: now, peak });
    while (this.frames.length && this.frames[0].t < now - VERDICT_WINDOW_MS) this.frames.shift();
    this.publish({ db: rmsToDb(this.smoothedLinear), clipping: now < this.clipUntil });
  }

  /** Start counting "no sound" from `now` (recording started, resumed, or moved to another microphone). */
  restartSilenceClock(now: number = Date.now()): void {
    this.clockStart = now;
    this.lastSoundAt = null;
    this.clearVerdictWindow();
  }

  /** The normalization gain the recording applies before Whisper (settings.audioNormalizationGain). */
  setGain(gain: number): void {
    this.gain = Number.isFinite(gain) ? Math.max(MIN_GAIN, Math.min(MAX_GAIN, gain)) : 1;
  }

  /**
   * Whether the level suits Whisper, or null while still listening (first 10 s after a start,
   * resume or microphone switch). Call about once a second: it also runs the hold-down that keeps
   * the answer from flickering, so it is not a pure getter.
   */
  speechVerdict(now: number = Date.now()): SpeechVerdict | null {
    const raw = this.rawVerdict(now);
    if (raw === null) {
      this.shownVerdict = null;
      this.candidate = null;
      return null;
    }
    if (this.shownVerdict === null) {
      this.shownVerdict = raw;
      this.candidate = null;
    } else if (raw === this.shownVerdict) {
      this.candidate = null;
    } else if (this.candidate?.verdict !== raw) {
      this.candidate = { verdict: raw, since: now };
    } else if (now - this.candidate.since >= VERDICT_HOLD_MS) {
      this.shownVerdict = raw;
      this.candidate = null;
    }
    return this.shownVerdict;
  }

  private rawVerdict(now: number): SpeechVerdict | null {
    if (this.firstFrameAt === null || now - this.firstFrameAt < VERDICT_WINDOW_MS) return null;
    const recent = this.frames.filter(f => f.t >= now - VERDICT_WINDOW_MS);
    if (!recent.length) return 'no-speech'; // frames stopped arriving altogether
    const sorted = recent.map(f => f.peak).sort((a, b) => a - b);
    const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))];
    if (p90 < NO_SPEECH_PEAK) return 'no-speech';
    const afterGain = Math.min(1, p90 * this.gain);
    // Leaving a warning takes a 3 dB margin, so a level sitting right on a boundary stays on one answer.
    const quietLimit = this.shownVerdict === 'too-quiet' ? QUIET_PEAK * RELEASE_MARGIN : QUIET_PEAK;
    const loudLimit = this.shownVerdict === 'too-loud' ? LOUD_PEAK / RELEASE_MARGIN : LOUD_PEAK;
    if (afterGain < quietLimit) return 'too-quiet';
    if (afterGain > loudLimit || sorted[sorted.length - 1] >= CLIP_PEAK) return 'too-loud';
    return 'ok';
  }

  private clearVerdictWindow(): void {
    this.frames = [];
    this.firstFrameAt = null;
    this.shownVerdict = null;
    this.candidate = null;
  }

  /** How long, in ms, no frame has had any sound (see SOUND_RMS) since the clock was last restarted. */
  silentForMs(now: number = Date.now()): number {
    return Math.max(0, now - Math.max(this.clockStart, this.lastSoundAt ?? 0));
  }

  /** Recording stopped or paused. */
  reset(): void {
    this.smoothedLinear = 0;
    this.clipUntil = 0;
    this.clearVerdictWindow();
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
