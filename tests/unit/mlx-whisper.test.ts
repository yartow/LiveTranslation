import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { execFileSync } from 'child_process';

const FAKE_WORKER = join(__dirname, '..', 'fixtures', 'fake-mlx-worker.mjs');

type MlxModule = typeof import('../../server/lib/mlx-whisper.js');

describe('mlx-whisper worker client', () => {
  let mlx: MlxModule;

  async function load(env: { timeoutMs: number; stuckKillMs?: number }): Promise<void> {
    vi.stubEnv('MLX_PYTHON', process.execPath); // run the fake worker with node
    vi.stubEnv('MLX_WORKER_PATH', FAKE_WORKER);
    vi.stubEnv('MLX_REQUEST_TIMEOUT_MS', String(env.timeoutMs));
    if (env.stuckKillMs) vi.stubEnv('MLX_STUCK_KILL_MS', String(env.stuckKillMs));
    vi.resetModules();
    mlx = await import('../../server/lib/mlx-whisper.js');
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    mlx?._shutdownMlxWorkerForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('transcribes a request', async () => {
    await load({ timeoutMs: 2000 });
    await expect(mlx.transcribeWithMlx('delay:10:a')).resolves.toBe('ok:delay:10:a');
  });

  it('starts a request\'s clock when the worker takes it, not while it waits behind another', async () => {
    // Each takes 250 ms against a 400 ms budget: B finishes ~500 ms after it was submitted,
    // which used to count as a timeout even though B itself was quick.
    await load({ timeoutMs: 400 });
    const [a, b] = await Promise.all([
      mlx.transcribeWithMlx('delay:250:a'),
      mlx.transcribeWithMlx('delay:250:b'),
    ]);
    expect([a, b]).toEqual(['ok:delay:250:a', 'ok:delay:250:b']);
  });

  it('retries a timed-out request once instead of dropping it', async () => {
    await load({ timeoutMs: 200 });
    const started = Date.now();
    // First attempt takes 600 ms (> 200 ms budget); the retry is instant.
    await expect(mlx.transcribeWithMlx('flaky:600:a')).resolves.toBe('ok:flaky:600:a');
    // The retry had to wait for the worker to finish the abandoned attempt first.
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  });

  it('does not let one timeout cascade into the requests behind it', async () => {
    await load({ timeoutMs: 200 });
    const slow = mlx.transcribeWithMlx('flaky:600:slow');
    await new Promise((r) => setTimeout(r, 250)); // let the first attempt time out
    // B arrives while the worker is still busy with the abandoned attempt.
    await expect(mlx.transcribeWithMlx('delay:20:b')).resolves.toBe('ok:delay:20:b');
    await expect(slow).resolves.toBe('ok:flaky:600:slow');
  });

  it('rejects after the single retry also times out', async () => {
    await load({ timeoutMs: 100 });
    await expect(mlx.transcribeWithMlx('delay:400:a')).rejects.toThrow('timed out');
  });

  it('drops an aborted request that is still waiting its turn', async () => {
    await load({ timeoutMs: 2000 });
    const running = mlx.transcribeWithMlx('delay:300:a');
    const controller = new AbortController();
    const waiting = mlx.transcribeWithMlx('delay:10:b', undefined, undefined, controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await expect(waiting).resolves.toBe('');
    await expect(running).resolves.toBe('ok:delay:300:a');
  });

  it('passes the worker\'s own decode time through', async () => {
    await load({ timeoutMs: 2000 });
    const result = await mlx.transcribeWithMlxDetailed('delay:5:a');
    expect(result.decodeSecs).toBe(1.25);
  });

  it('reports what the worker is doing', async () => {
    await load({ timeoutMs: 2000 });
    expect(mlx.getMlxWorkerStats()).toMatchObject({ pid: null, busy: false, queued: 0, spawns: 0 });
    const first = mlx.transcribeWithMlx('delay:150:a');
    const second = mlx.transcribeWithMlx('delay:10:b');
    await new Promise((r) => setTimeout(r, 80));
    expect(mlx.getMlxWorkerStats()).toMatchObject({ ready: true, busy: true, queued: 1, spawns: 1 });
    expect(mlx.getMlxWorkerStats().pid).toBeGreaterThan(0);
    await Promise.all([first, second]);
    expect(mlx.getMlxWorkerStats()).toMatchObject({ busy: false, queued: 0 });
  });

  const niceOf = (pid: number) => Number(execFileSync('ps', ['-o', 'nice=', '-p', String(pid)]).toString().trim());

  it('runs the worker at a lower priority than the browser, 10 by default', async () => {
    await load({ timeoutMs: 2000 });
    await mlx.transcribeWithMlx('delay:5:a');
    expect(niceOf(mlx.getMlxWorkerStats().pid!)).toBe(10);
  });

  it('leaves the priority alone with MLX_NICE=0, and takes another value from MLX_NICE', async () => {
    vi.stubEnv('MLX_NICE', '0');
    await load({ timeoutMs: 2000 });
    await mlx.transcribeWithMlx('delay:5:a');
    const normal = niceOf(mlx.getMlxWorkerStats().pid!);
    mlx._shutdownMlxWorkerForTests();
    expect(normal).toBe(niceOf(process.pid)); // inherited from this process

    vi.stubEnv('MLX_NICE', '15');
    await load({ timeoutMs: 2000 });
    await mlx.transcribeWithMlx('delay:5:b');
    expect(niceOf(mlx.getMlxWorkerStats().pid!)).toBe(15);
  });

  it('parses MLX_NICE defensively', () => {
    // pure function, no worker needed
    return import('../../server/lib/mlx-whisper.js').then(({ parseMlxNice }) => {
      expect(parseMlxNice(undefined)).toBe(10);
      expect(parseMlxNice('')).toBe(10);
      expect(parseMlxNice('abc')).toBe(10);
      expect(parseMlxNice('0')).toBe(0);
      expect(parseMlxNice('5')).toBe(5);
      expect(parseMlxNice('99')).toBe(19);
      expect(parseMlxNice('-4')).toBe(0);
    });
  });

  it('kills and restarts a worker that stays wedged, then keeps serving', async () => {
    await load({ timeoutMs: 100, stuckKillMs: 200 });
    // Never answers (within the test): times out, retries, and the stuck-worker kill kicks in.
    await expect(mlx.transcribeWithMlx('delay:60000:a')).rejects.toThrow();
    // After the restart the worker is usable again.
    await expect(mlx.transcribeWithMlx('delay:10:b')).resolves.toBe('ok:delay:10:b');
  }, 20_000);
});
