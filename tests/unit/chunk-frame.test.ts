import { describe, it, expect } from 'vitest';
import { analyzeFrame, isVadSilent, decideCommit, type CommitState } from '../../client/src/lib/chunk-based-transcription';

describe('analyzeFrame', () => {
  it('measures rms and peak on the raw input, whatever the gain', () => {
    const input = Float32Array.from([0.5, -0.5, 0.5, -0.5]);
    const a = analyzeFrame(input, 1);
    expect(a.rms).toBeCloseTo(0.5);
    expect(a.peak).toBeCloseTo(0.5);
    const b = analyzeFrame(input, 4);
    expect(b.rms).toBeCloseTo(0.5);
    expect(b.peak).toBeCloseTo(0.5);
  });

  it('applies the gain and clamps to [-1, 1] instead of clipping past it', () => {
    const { gained, meanAbs } = analyzeFrame(Float32Array.from([0.1, -0.4, 0.6]), 2);
    expect(Array.from(gained)).toEqual([expect.closeTo(0.2), expect.closeTo(-0.8), 1]);
    expect(meanAbs).toBeCloseTo((0.2 + 0.8 + 1) / 3);
  });

  it('does not modify the input buffer', () => {
    const input = Float32Array.from([0.3, -0.3]);
    analyzeFrame(input, 3);
    expect(Array.from(input)).toEqual([expect.closeTo(0.3), expect.closeTo(-0.3)]);
  });

  it('reports digital silence as zero', () => {
    const a = analyzeFrame(new Float32Array(256), 1);
    expect(a).toMatchObject({ rms: 0, peak: 0, meanAbs: 0 });
  });
});

describe('isVadSilent', () => {
  it('uses the 0.005 absolute floor when the room is quiet', () => {
    expect(isVadSilent(0.004, 0)).toBe(true);
    expect(isVadSilent(0.006, 0)).toBe(false);
  });

  it('follows a noisy room: below 2x the tracked noise floor still counts as a pause', () => {
    expect(isVadSilent(0.05, 0.03)).toBe(true); // < 0.06
    expect(isVadSilent(0.07, 0.03)).toBe(false);
  });
});

describe('decideCommit', () => {
  const base: CommitState = {
    useVAD: true,
    vadSilenceMs: 0,
    vadSilenceThresholdMs: 700,
    sampleCount: 16_000, // 1 s
    minSamples: 64_000,  // 4 s
    maxSamples: 240_000, // 15 s
  };

  it('keeps collecting while nothing triggers', () => {
    expect(decideCommit(base)).toBeNull();
  });

  it('cuts on a long enough pause once the minimum length is reached', () => {
    expect(decideCommit({ ...base, sampleCount: 64_000, vadSilenceMs: 700 })).toBe('vad');
  });

  it('does not cut on a pause before the minimum length', () => {
    expect(decideCommit({ ...base, sampleCount: 63_999, vadSilenceMs: 5_000 })).toBeNull();
  });

  it('does not cut on a pause shorter than the threshold', () => {
    expect(decideCommit({ ...base, sampleCount: 100_000, vadSilenceMs: 699 })).toBeNull();
  });

  it('cuts at the hard cap even without a pause', () => {
    expect(decideCommit({ ...base, sampleCount: 240_000 })).toBe('cap');
  });

  it('with VAD off, only the cap cuts (fixed-length chunks)', () => {
    const fixed = { ...base, useVAD: false, vadSilenceMs: 9_000 };
    expect(decideCommit({ ...fixed, sampleCount: 100_000 })).toBeNull();
    expect(decideCommit({ ...fixed, sampleCount: 240_000 })).toBe('cap');
  });

  it('reports a pause as "vad" even when the cap is reached at the same time', () => {
    expect(decideCommit({ ...base, sampleCount: 240_000, vadSilenceMs: 700 })).toBe('vad');
  });
});
