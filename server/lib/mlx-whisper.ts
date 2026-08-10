// Local transcription via mlx-whisper (Apple Silicon only), run as a
// long-lived Python sidecar so the model stays loaded between chunks.
//
// The sidecar (server/python/mlx_worker.py) speaks JSON-lines over
// stdin/stdout: one request in, one {id, text} or {id, error} response out,
// correlated by id. See that file for the exact protocol.
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { join } from 'path';

const WORKER_PATH = join(import.meta.dirname, '..', 'python', 'mlx_worker.py');
const REQUEST_TIMEOUT_MS = 30_000;
const RESTART_BACKOFF_MS = 2_000;

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

class MlxWorkerManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private lastSpawnError: string | null = null;
  private restarting = false;

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
      this.failAllPending(new Error('MLX worker exited unexpectedly'));
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.restarting) return;
    this.restarting = true;
    setTimeout(() => {
      this.restarting = false;
      this.spawnWorker();
    }, RESTART_BACKOFF_MS);
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
      for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
      return;
    }

    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timeout);
    if (typeof msg.error === 'string') {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(typeof msg.text === 'string' ? msg.text : '');
    }
  }

  private failAllPending(err: Error): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(err);
    });
    this.pending.clear();
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
    if (signal?.aborted) return '';

    await this.waitUntilReady(REQUEST_TIMEOUT_MS);
    if (!this.proc) throw new Error('MLX worker unavailable');

    const id = this.nextId++;
    const normalizedLanguage = language && language !== 'auto' ? language.split('-')[0] : null;

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timeout);
        resolve('');
      };
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error('MLX transcription timed out'));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (text) => { signal?.removeEventListener('abort', onAbort); resolve(text); },
        reject: (err) => { signal?.removeEventListener('abort', onAbort); reject(err); },
        timeout,
      });

      signal?.addEventListener('abort', onAbort, { once: true });

      const req = JSON.stringify({
        id,
        path: audioFilePath,
        language: normalizedLanguage,
        initial_prompt: initialPrompt || null,
      });
      this.proc!.stdin.write(req + '\n');
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
