import { describe, it, expect } from 'vitest';
import { createSerialRunner } from '../../client/src/lib/serial-runner.js';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('createSerialRunner', () => {
  it('runs jobs in request order even when an earlier one finishes later', async () => {
    const run = createSerialRunner();
    const order: string[] = [];
    const slow = deferred<void>();
    const first = run(async () => { await slow.promise; order.push('first'); });
    const second = run(async () => { order.push('second'); });
    // The second job must not start while the first is still pending.
    await Promise.resolve();
    expect(order).toEqual([]);
    slow.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('still runs the next job after one fails, and reports each result to its own caller', async () => {
    const run = createSerialRunner();
    const failing = run(async () => { throw new Error('boom'); });
    const ok = run(async () => 42);
    await expect(failing).rejects.toThrow('boom');
    await expect(ok).resolves.toBe(42);
  });
});
