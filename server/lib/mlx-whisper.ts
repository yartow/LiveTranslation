// Local transcription via mlx-whisper (Apple Silicon only), run as a
// long-lived Python sidecar so the model stays loaded between chunks.
//
// The sidecar (server/python/mlx_worker.py) speaks JSON-lines over
// stdin/stdout: one request in, one {id, text} or {id, error} response out,
// correlated by id. See that file for the exact protocol.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { join } from 'path';
import { existsSync } from 'fs';

// In dev (tsx running server/index.ts directly), import.meta.dirname here is
// server/lib, so '../python/...' resolves to server/python. In a production
// build, esbuild bundles everything into dist/index.js and import.meta.dirname
// is dist — '../python/...' would resolve outside the repo entirely unless
// the build step copies server/python next to dist (see package.json's
// `build` script), which lands it at dist/python instead. Try both rather
// than hard-coding one layout.
function resolveWorkerPath(): string {
  const devLayout = join(import.meta.dirname, '..', 'python', 'mlx_worker.py');
  if (existsSync(devLayout)) return devLayout;
  const prodLayout = join(import.meta.dirname, 'python', 'mlx_worker.py');
  if (existsSync(prodLayout)) return prodLayout;
  return devLayout; // neither exists — fail with a path in the error message that at least points at the expected dev location
}

// MLX_WORKER_PATH / MLX_REQUEST_TIMEOUT_MS / MLX_STUCK_KILL_MS are test hooks (a fake
// worker + short timeouts in tests/unit/mlx-whisper.test.ts); leave them unset in real use.
const WORKER_PATH = process.env.MLX_WORKER_PATH || resolveWorkerPath();
// Per-request budget, measured from the moment the request is handed to the
// worker (not from when it was queued behind another) — whisper-large-v3 takes
// ~1-2.5 s per chunk normally, so this only trips when the GPU is badly contended.
const REQUEST_TIMEOUT_MS = Number(process.env.MLX_REQUEST_TIMEOUT_MS) || 60_000;
// A request we gave up on is still being computed by the worker (it can't be
// cancelled). If it still hasn't answered this long after we gave up, the worker is
// wedged — kill it so the restart logic gives us a fresh one.
const STUCK_KILL_MS = Number(process.env.MLX_STUCK_KILL_MS) || 90_000;
// The worker's first waitUntilReady() call may need to download the model
// (multi-GB from Hugging Face) in addition to warm-up inference — a much
// longer allowance than any individual transcription request should ever need.
const STARTUP_TIMEOUT_MS = 10 * 60_000;
const RESTART_BACKOFF_MS = 2_000;
const MAX_RESTART_BACKOFF_MS = 60_000;
const MAX_CONSECUTIVE_RESTART_FAILURES = 10;

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

/** A request waiting for the worker to be free. Not on the clock until it is dispatched. */
interface QueuedRequest {
  id: number;
  payload: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

export class MlxTimeoutError extends Error {
  constructor() {
    super('MLX transcription timed out');
    this.name = 'MlxTimeoutError';
  }
}

class MlxWorkerManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private pending = new Map<number, PendingRequest>();
  // The worker handles one request at a time, so we send it one at a time and
  // only start a request's timeout clock when it is actually handed over.
  // Otherwise a request that timed out (but is still being computed by the
  // worker) would leave the next one waiting behind it with its own clock
  // already running — one timeout cascading into a run of dropped chunks.
  private queue: QueuedRequest[] = [];
  private busyId: number | null = null;
  private stuckTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private nextId = 1;
  private lastSpawnError: string | null = null;
  private restarting = false;
  private consecutiveRestartFailures = 0;

  private pythonBin(): string {
    return process.env.MLX_PYTHON || 'python3';
  }

  private spawnWorker(): void {
    const bin = this.pythonBin();
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(bin, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.lastSpawnError = err instanceof Error ? err.message : String(err);
      console.error(`MLX worker: failed to spawn (${bin}):`, this.lastSpawnError);
      this.scheduleRestart();
      return;
    }

    this.proc = proc;
    this.ready = false;

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    proc.stderr.on('data', (chunk: Buffer) => {
      // Worker diagnostics only — never protocol data. Prefixed for clarity in logs.
      const text = chunk.toString('utf8').trimEnd();
      if (text) console.log(`[mlx-worker] ${text}`);
    });

    proc.on('error', (err) => {
      this.lastSpawnError = err.message;
      console.error(`MLX worker: process error (bin=${bin}):`, err.message);
    });

    proc.on('exit', (code, signal) => {
      console.warn(`MLX worker exited (code=${code}, signal=${signal})`);
      this.proc = null;
      this.ready = false;
      this.busyId = null;
      if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = null; }
      this.failAllPending(new Error('MLX worker exited unexpectedly'));
      if (!this.shuttingDown) this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.restarting) return;
    this.consecutiveRestartFailures++;
    if (this.consecutiveRestartFailures > MAX_CONSECUTIVE_RESTART_FAILURES) {
      console.error(`MLX worker: giving up after ${this.consecutiveRestartFailures} consecutive failed restarts — check MLX_PYTHON (currently "${this.pythonBin()}")`);
      this.failAllPending(new Error('MLX worker repeatedly failed to start — check server logs / MLX_PYTHON'));
      return;
    }
    this.restarting = true;
    const backoff = Math.min(RESTART_BACKOFF_MS * 2 ** (this.consecutiveRestartFailures - 1), MAX_RESTART_BACKOFF_MS);
    setTimeout(() => {
      this.restarting = false;
      this.spawnWorker();
    }, backoff);
  }

  private handleLine(line: string): void {
    line = line.trim();
    if (!line) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn(`MLX worker: non-JSON stdout line ignored: ${line.slice(0, 200)}`);
      return;
    }

    if (msg.type === 'ready') {
      this.ready = true;
      this.consecutiveRestartFailures = 0;
      for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
      this.pump();
      return;
    }

    // No pending entry = we already gave up on this request (timeout/abort); its answer is
    // discarded, but it still frees the worker for the next queued request.
    const pending = this.pending.get(msg.id);
    if (pending) {
      this.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      if (typeof msg.error === 'string') {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(typeof msg.text === 'string' ? msg.text : '');
      }
    }
    this.releaseWorker(msg.id);
  }

  private releaseWorker(id: number): void {
    if (this.busyId !== id) return;
    this.busyId = null;
    if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = null; }
    this.pump();
  }

  private pump(): void {
    if (this.busyId !== null || !this.ready || !this.proc) return;
    const next = this.queue.shift();
    if (next) this.dispatch(next);
  }

  private dispatch(req: QueuedRequest): void {
    this.busyId = req.id;
    const timeout = setTimeout(() => {
      if (!this.pending.delete(req.id)) return;
      console.warn(`MLX worker: request ${req.id} still running after ${REQUEST_TIMEOUT_MS} ms — giving up on it (the worker stays busy until it answers)`);
      req.reject(new MlxTimeoutError());
      this.stuckTimer = setTimeout(() => {
        if (this.busyId !== req.id) return;
        console.error(`MLX worker: still stuck on request ${req.id} ${STUCK_KILL_MS} ms later — killing it so it restarts`);
        this.proc?.kill();
      }, STUCK_KILL_MS);
    }, REQUEST_TIMEOUT_MS);
    this.pending.set(req.id, { resolve: req.resolve, reject: req.reject, timeout });

    // The worker can exit between waitUntilReady() resolving and this write
    // (e.g. it crashed the instant after reporting ready) — without an error
    // handler a failed/EPIPE write would sit until the timeout instead of failing at once.
    const fail = (err: Error) => {
      const pending = this.pending.get(req.id);
      if (pending) { this.pending.delete(req.id); clearTimeout(pending.timeout); pending.reject(err); }
      this.releaseWorker(req.id);
    };
    try {
      this.proc!.stdin.write(req.payload + '\n', (err) => {
        if (err) fail(new Error(`MLX worker write failed: ${err.message}`));
      });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Stops the worker without restarting it (tests). */
  shutdown(): void {
    this.shuttingDown = true;
    this.proc?.kill();
  }

  private failAllPending(err: Error): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(err);
    });
    this.pending.clear();
    for (const queued of this.queue.splice(0)) queued.reject(err);
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(err);
  }

  private ensureStarted(): void {
    if (!this.proc && !this.restarting) this.spawnWorker();
  }

  private waitUntilReady(timeoutMs: number): Promise<void> {
    this.ensureStarted();
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.readyWaiters.findIndex((w) => w.resolve === resolveWrapped);
        if (idx !== -1) this.readyWaiters.splice(idx, 1);
        reject(new Error(
          this.lastSpawnError
            ? `MLX worker unavailable — check MLX_PYTHON (currently "${this.pythonBin()}"): ${this.lastSpawnError}`
            : 'MLX worker did not become ready in time'
        ));
      }, timeoutMs);
      const resolveWrapped = () => { clearTimeout(timer); resolve(); };
      this.readyWaiters.push({ resolve: resolveWrapped, reject: (err) => { clearTimeout(timer); reject(err); } });
    });
  }

  async transcribe(
    audioFilePath: string,
    language?: string,
    initialPrompt?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      return await this.transcribeOnce(audioFilePath, language, initialPrompt, signal);
    } catch (err) {
      if (!(err instanceof MlxTimeoutError) || signal?.aborted) throw err;
      // A timeout drops the chunk's speech from the sermon; one more attempt costs little.
      // It goes to the back of the queue, and its clock starts only when the worker is free.
      console.warn('MLX transcription timed out — retrying once');
      return this.transcribeOnce(audioFilePath, language, initialPrompt, signal);
    }
  }

  private async transcribeOnce(
    audioFilePath: string,
    language?: string,
    initialPrompt?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) return '';

    await this.waitUntilReady(STARTUP_TIMEOUT_MS);
    if (!this.proc) throw new Error('MLX worker unavailable');

    const id = this.nextId++;
    const normalizedLanguage = language && language !== 'auto' ? language.split('-')[0] : null;
    const payload = JSON.stringify({
      id,
      path: audioFilePath,
      language: normalizedLanguage,
      initial_prompt: initialPrompt || null,
    });

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        const queuedAt = this.queue.findIndex((q) => q.id === id);
        if (queuedAt !== -1) {
          this.queue.splice(queuedAt, 1);
        } else {
          // Already handed to the worker: stop waiting for it (it finishes on its own).
          const pending = this.pending.get(id);
          if (pending) { this.pending.delete(id); clearTimeout(pending.timeout); }
        }
        resolve('');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push({
        id,
        payload,
        resolve: (text) => { signal?.removeEventListener('abort', onAbort); resolve(text); },
        reject: (err) => { signal?.removeEventListener('abort', onAbort); reject(err); },
      });
      this.pump();
    });
  }
}

const manager = new MlxWorkerManager();

// Mirrors transcribeAudio()'s signature (server/lib/openai.ts) closely enough
// to drop into the same call site in chunk-transcription.ts.
export async function transcribeWithMlx(
  audioFilePath: string,
  language?: string,
  initialPrompt?: string,
  signal?: AbortSignal,
): Promise<string> {
  return manager.transcribe(audioFilePath, language, initialPrompt, signal);
}

/** Stops the worker without restarting it — tests only. */
export function _shutdownMlxWorkerForTests(): void {
  manager.shutdown();
}
