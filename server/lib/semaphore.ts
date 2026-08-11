// Simple counting semaphore used to cap concurrency against a shared
// resource (the local MLX sidecar, a per-provider LLM call budget, ...).
// Moved out of server/lib/chunk-transcription.ts so server/lib/sermon-translate.ts
// can reuse it instead of duplicating the class.
export class Semaphore {
  private slots: number;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.slots = max;
  }

  acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.slots++;
  }
}
