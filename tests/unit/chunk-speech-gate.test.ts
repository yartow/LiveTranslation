import { describe, it, expect } from 'vitest';
import {
  updateNoiseFloor, shouldKeepChunk, SpeechGate, windowMeanAbs,
} from '../../client/src/lib/chunk-based-transcription';

const WIN_MS = 20;

/** Feeds a signal described as per-20ms-window mean-abs amplitudes through a SpeechGate. */
function simulate(windows: number[], startingNoiseFloor = 0) {
  const gate = new SpeechGate();
  gate.noiseFloor = startingNoiseFloor;
  for (const w of windows) gate.push(w, WIN_MS);
  return { gate, kept: gate.keepChunk() };
}

const ms = (n: number) => Math.round(n / WIN_MS);
const tone = (level: number, durationMs: number) => Array(ms(durationMs)).fill(level);

describe('shouldKeepChunk', () => {
  it('keeps a chunk whose longest voiced run reaches 250ms', () => {
    expect(shouldKeepChunk(250)).toBe(true);
  });

  it('discards a chunk whose longest run is a single click', () => {
    expect(shouldKeepChunk(WIN_MS)).toBe(false);
    // A whole 256ms frame at the 16 kHz context must not be treated as 256ms of speech:
    // the gate works on 20ms windows, so one click is one or two windows.
    expect(shouldKeepChunk(2 * WIN_MS)).toBe(false);
  });

  it('discards pure silence', () => {
    expect(shouldKeepChunk(0)).toBe(false);
  });
});

describe('windowMeanAbs', () => {
  it('splits a frame into windows and averages each', () => {
    const frame = new Float32Array([1, -1, 0, 0, 0.5, 0.5, 0.25]);
    expect(windowMeanAbs(frame, 2)).toEqual([1, 0, 0.5, 0.25]);
  });
});

describe('speech-presence gate simulation', () => {
  it('discards typing: key clicks every ~170ms over room tone, for a whole 10s chunk', () => {
    const windows: number[] = [];
    for (let t = 0; t < 10_000; t += WIN_MS) {
      // a ~40ms click (2 windows) every 8-9 windows
      const inClick = (t / WIN_MS) % 9 < 2;
      windows.push(inClick ? 0.2 : 0.003);
    }
    expect(simulate(windows).kept).toBe(false);
  });

  it('discards a single keystroke even when the chunk is otherwise silent', () => {
    expect(simulate([...tone(0.003, 3000), ...tone(0.3, 40), ...tone(0.003, 3000)]).kept).toBe(false);
  });

  it('keeps a quiet but sustained signal clearly above the room noise floor', () => {
    const result = simulate([...tone(0.003, 400), ...tone(0.012, 500)]);
    expect(result.kept).toBe(true);
  });

  it('keeps a short word whose voiced windows have brief plosive gaps', () => {
    // ~"A-men": voiced 120ms, 60ms gap, voiced 200ms
    const result = simulate([...tone(0.003, 400), ...tone(0.02, 120), ...tone(0.003, 60), ...tone(0.02, 200)]);
    expect(result.kept).toBe(true);
  });

  it('does not bridge a gap longer than the bridge limit', () => {
    const result = simulate([...tone(0.003, 400), ...tone(0.02, 160), ...tone(0.003, 200), ...tone(0.02, 160)]);
    expect(result.kept).toBe(false);
  });

  it('discards steady room tone/hum on its own, once the noise floor has settled', () => {
    expect(simulate(tone(0.0025, 4000), /* startingNoiseFloor */ 0.0025).kept).toBe(false);
  });

  it('resetChunk clears the run but keeps the noise floor', () => {
    const { gate } = simulate([...tone(0.003, 400), ...tone(0.02, 400)]);
    const floor = gate.noiseFloor;
    gate.resetChunk();
    expect(gate.keepChunk()).toBe(false);
    expect(gate.noiseFloor).toBe(floor);
  });
});

describe('updateNoiseFloor', () => {
  it('tracks down instantly to a quieter frame', () => {
    expect(updateNoiseFloor(0.01, 0.002)).toBe(0.002);
  });

  it('rises only slowly toward a louder frame', () => {
    const next = updateNoiseFloor(0.002, 0.5);
    expect(next).toBeGreaterThan(0.002);
    expect(next).toBeLessThan(0.01); // far short of jumping straight to 0.5
  });

  it('initializes from the very first frame when starting at the 0 sentinel', () => {
    expect(updateNoiseFloor(0, 0.004)).toBe(0.004);
  });
});
