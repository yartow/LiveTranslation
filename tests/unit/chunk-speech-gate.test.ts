import { describe, it, expect } from 'vitest';
import {
  updateNoiseFloor, isFrameVoiced, shouldKeepChunk,
} from '../../client/src/lib/chunk-based-transcription';

// Frame duration used by these simulations — matches the corrected native
// rate (~48kHz) computation in startAudioCapture(), NOT the old buggy
// 256ms-per-frame value. See chunk-based-transcription.ts's frameDurationMs
// field comment.
const FRAME_MS = 4096 / 48000 * 1000; // ~85.3ms

/** Simulates a chunk: feeds a sequence of per-frame mean-abs amplitudes
 *  through the noise-floor/voiced-run/total-voiced tracking exactly as
 *  onaudioprocess does, and reports whether the resulting chunk would be
 *  kept. */
function simulateChunk(frameAmplitudes: number[], startingNoiseFloor = 0) {
  let noiseFloor = startingNoiseFloor;
  let voicedRunMs = 0;
  let longestVoicedRunMs = 0;
  let totalVoicedMs = 0;

  for (const meanAbs of frameAmplitudes) {
    noiseFloor = updateNoiseFloor(noiseFloor, meanAbs);
    if (isFrameVoiced(meanAbs, noiseFloor)) {
      voicedRunMs += FRAME_MS;
      longestVoicedRunMs = Math.max(longestVoicedRunMs, voicedRunMs);
      totalVoicedMs += FRAME_MS;
    } else {
      voicedRunMs = 0;
    }
  }

  return { noiseFloor, longestVoicedRunMs, totalVoicedMs, kept: shouldKeepChunk(longestVoicedRunMs, totalVoicedMs) };
}

describe('shouldKeepChunk', () => {
  it('keeps a chunk with one long continuous voiced run', () => {
    expect(shouldKeepChunk(300, 300)).toBe(true);
  });

  it('discards a chunk with only an isolated single-frame tick', () => {
    // One ~85ms frame can never reach either threshold.
    expect(shouldKeepChunk(FRAME_MS, FRAME_MS)).toBe(false);
  });

  it('keeps a chunk with several short bursts that together clear the total-voiced bar', () => {
    expect(shouldKeepChunk(150, 450)).toBe(true);
  });

  it('discards pure silence', () => {
    expect(shouldKeepChunk(0, 0)).toBe(false);
  });
});

describe('speech-presence gate simulation', () => {
  it('discards a tick train — isolated transients surrounded by quiet room tone', () => {
    // ~2s of room tone at a low, steady level, with brief loud ticks
    // scattered through it (every ~500ms, one frame each) — the reported
    // "tikgeluid" case. No tick lasts more than one frame.
    const frames: number[] = [];
    const frameCount = Math.round(2000 / FRAME_MS);
    for (let i = 0; i < frameCount; i++) {
      const isTick = i % 6 === 0;
      frames.push(isTick ? 0.3 : 0.003);
    }
    const result = simulateChunk(frames);
    expect(result.kept).toBe(false);
  });

  it('keeps a quiet but continuous, sustained tone clearly above the room noise floor', () => {
    // First establish a quiet noise floor (room tone), then a continuous
    // quiet "speech-like" signal for 500ms — well above the floor via
    // NOISE_FLOOR_RATIO, but far below normal full-volume speech.
    const roomToneFrames = Array(20).fill(0.003);
    const speechFrames = Array(Math.round(500 / FRAME_MS)).fill(0.012);
    const result = simulateChunk([...roomToneFrames, ...speechFrames]);
    expect(result.kept).toBe(true);
  });

  it('discards steady room tone/hum on its own, once the noise floor has settled', () => {
    // A long run of constant-level noise should NOT look "voiced" once the
    // adaptive floor has caught up to it (it starts at 0/uninitialized, so
    // give it a head start matching the tone level).
    const frames = Array(40).fill(0.0025);
    const result = simulateChunk(frames, /* startingNoiseFloor */ 0.0025);
    expect(result.kept).toBe(false);
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
