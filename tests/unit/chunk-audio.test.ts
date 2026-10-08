import { describe, it, expect } from 'vitest';
import { Resampler, ChunkAssembler } from '../../client/src/lib/chunk-based-transcription';

function sine(freq: number, rate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Peak amplitude, ignoring the filter's start-up transient. */
function steadyPeak(samples: Float32Array): number {
  let peak = 0;
  for (let i = Math.floor(samples.length / 4); i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

/** Runs a signal through the resampler in 4096-sample callbacks, like onaudioprocess. */
function resampleInFrames(signal: Float32Array, inRate: number, outRate: number): Float32Array {
  const r = new Resampler(inRate, outRate);
  const parts: Float32Array[] = [];
  for (let i = 0; i < signal.length; i += 4096) parts.push(r.process(signal.subarray(i, i + 4096)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('Resampler (48 kHz -> 16 kHz)', () => {
  it('passes speech-band content (1 kHz) at near-unity gain', () => {
    const out = resampleInFrames(sine(1000, 48000, 1), 48000, 16000);
    expect(steadyPeak(out)).toBeGreaterThan(0.95);
    expect(steadyPeak(out)).toBeLessThan(1.05);
  });

  it('attenuates content above the output Nyquist instead of aliasing it into the speech band', () => {
    // 10 kHz at a 16 kHz output rate would alias to 6 kHz at FULL amplitude
    // with naive every-3rd-sample decimation.
    const input = sine(10000, 48000, 1);
    const naive = new Float32Array(Math.floor(input.length / 3));
    for (let i = 0; i < naive.length; i++) naive[i] = input[i * 3];
    expect(steadyPeak(naive)).toBeGreaterThan(0.9); // proves the test signal really does alias

    const filtered = resampleInFrames(input, 48000, 16000);
    expect(steadyPeak(filtered)).toBeLessThan(0.05);
  });

  it('produces the right output length across frame boundaries', () => {
    const out = resampleInFrames(sine(500, 48000, 2), 48000, 16000);
    expect(Math.abs(out.length - 32000)).toBeLessThan(40);
  });

  it('is seamless across frame boundaries: framed output matches one-shot output', () => {
    const signal = sine(700, 48000, 0.5);
    const framed = resampleInFrames(signal, 48000, 16000);
    const oneShot = new Resampler(48000, 16000).process(signal);
    const n = Math.min(framed.length, oneShot.length);
    for (let i = 0; i < n; i++) expect(framed[i]).toBeCloseTo(oneShot[i], 4);
  });

  it('is a pass-through copy when the rates already match', () => {
    const input = sine(300, 16000, 0.1);
    const out = new Resampler(16000, 16000).process(input);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it('handles a non-integer ratio (44.1 kHz)', () => {
    const out = resampleInFrames(sine(1000, 44100, 1), 44100, 16000);
    expect(Math.abs(out.length - 16000)).toBeLessThan(40);
    expect(steadyPeak(out)).toBeGreaterThan(0.95);
  });
});

describe('ChunkAssembler overlap prefix', () => {
  const frame = (value: number, n: number) => new Float32Array(n).fill(value);

  it('has no prefix on the first chunk', () => {
    const a = new ChunkAssembler(4);
    a.push(frame(1, 10));
    const out = a.commit();
    expect(out.length).toBe(10);
    expect(Array.from(out)).toEqual(Array(10).fill(1));
  });

  it("prefixes the next chunk with the PREVIOUS chunk's tail, not its own", () => {
    const a = new ChunkAssembler(4);
    a.push(frame(1, 10));
    a.commit();
    a.push(frame(2, 10));
    const out = a.commit();
    expect(out.length).toBe(14);
    expect(Array.from(out.subarray(0, 4))).toEqual([1, 1, 1, 1]); // previous chunk's tail
    expect(Array.from(out.subarray(4))).toEqual(Array(10).fill(2)); // this chunk, once
  });

  it('chains: the third chunk is prefixed with the second chunk only', () => {
    const a = new ChunkAssembler(3);
    a.push(frame(1, 8)); a.commit();
    a.push(frame(2, 8)); a.commit();
    a.push(frame(3, 8));
    const out = a.commit();
    expect(Array.from(out.subarray(0, 3))).toEqual([2, 2, 2]);
  });

  it('discard drops the audio and the stale prefix', () => {
    const a = new ChunkAssembler(4);
    a.push(frame(1, 10)); a.commit();
    a.push(frame(9, 10));
    a.discard();
    expect(a.sampleCount).toBe(0);
    a.push(frame(2, 10));
    const out = a.commit();
    expect(out.length).toBe(10);
    expect(Array.from(out)).toEqual(Array(10).fill(2));
  });

  it('with zero overlap, chunks are sent as-is', () => {
    const a = new ChunkAssembler(0);
    a.push(frame(1, 5)); a.commit();
    a.push(frame(2, 5));
    expect(a.commit().length).toBe(5);
  });
});
