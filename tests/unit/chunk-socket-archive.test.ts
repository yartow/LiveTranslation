// The session archive over a real WebSocket: a recording with ASR_DEBUG_DIR set gets its machine-load log started
// and stopped with the session, and the page's `perf` rows end up in browser.jsonl. No audio is sent, so no
// provider is involved.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocket, WebSocketServer } from 'ws';

type Machine = typeof import('../../server/lib/machine-monitor.js');

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting for condition');
    await new Promise(r => setTimeout(r, 15));
  }
}

describe('chunk socket: session archive', () => {
  let archiveRoot: string;
  let server: Server;
  let wss: WebSocketServer;
  let machine: Machine;
  let clients: WebSocket[];

  beforeEach(async () => {
    archiveRoot = mkdtempSync(join(tmpdir(), 'chunk-socket-'));
    vi.stubEnv('ASR_DEBUG_DIR', archiveRoot); // read once at module load, so import after stubbing
    vi.resetModules();
    machine = await import('../../server/lib/machine-monitor.js');
    const { setupChunkTranscriptionWebSocket } = await import('../../server/lib/chunk-transcription.js');
    server = createServer();
    wss = new WebSocketServer({ server });
    setupChunkTranscriptionWebSocket(wss);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    clients = [];
  });

  afterEach(async () => {
    clients.forEach(c => c.terminate());
    wss.close();
    await new Promise<void>(r => server.close(() => r()));
    vi.unstubAllEnvs();
    rmSync(archiveRoot, { recursive: true, force: true });
  });

  /** Connects, sends `start` and waits for `ready`; resolves with the socket and everything it receives. */
  async function startRecording(archiveId: string): Promise<{ ws: WebSocket; received: any[] }> {
    const { port } = server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(ws);
    const received: any[] = [];
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'start', engine: 'mlx', outputMode: 'correct-only', sourceLanguage: 'nl', targetLanguage: 'en', archiveId }));
    await waitFor(() => received.some(m => m.type === 'ready'));
    return { ws, received };
  }

  const sessionDir = () => join(archiveRoot, readdirSync(archiveRoot)[0]);

  it('logs machine load for the length of the recording, and stops when it ends', async () => {
    expect(machine.machineMonitor.isRunning()).toBe(false);
    const { ws, received } = await startRecording('abc123');
    expect(received.find(m => m.type === 'ready')).toMatchObject({ archive: true });
    expect(machine.machineMonitor.isRunning()).toBe(true);

    await machine.machineMonitor.sampleOnce();
    const file = join(sessionDir(), 'machine.jsonl');
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').trim().length > 0);
    const row = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]);
    expect(row.chunks).toEqual({ inFlight: 0, waitingForEarlier: 0, oldestMs: null });
    expect(row.sys.load1).toBeTypeOf('number');
    expect(row.node.rssMB).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => received.some(m => m.type === 'stop_complete'));
    await waitFor(() => !machine.machineMonitor.isRunning());
  });

  it('writes the page\'s perf rows to browser.jsonl', async () => {
    const { ws } = await startRecording('perf1');
    const rows = [
      { w: 1, visible: true, longTasks: 2, longTaskMs: 130, maxLongTaskMs: 90, maxDriftMs: 40, heapMB: 100 },
      { w: 2, visible: true, longTasks: 0, longTaskMs: 0, maxLongTaskMs: 0, maxDriftMs: 5, heapMB: 101 },
    ];
    ws.send(JSON.stringify({ type: 'perf', rows }));
    const file = join(sessionDir(), 'browser.jsonl');
    await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').trim().split('\n').length === 2);
    expect(readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))).toEqual(rows);
  });

  it('ignores a perf message that is not rows', async () => {
    const { ws } = await startRecording('perf2');
    ws.send(JSON.stringify({ type: 'perf', rows: 'nope' }));
    ws.send(JSON.stringify({ type: 'perf', rows: [] }));
    await new Promise(r => setTimeout(r, 100));
    expect(existsSync(join(sessionDir(), 'browser.jsonl'))).toBe(false);
  });

  it('stops monitoring when the page just disconnects', async () => {
    const { ws } = await startRecording('gone');
    expect(machine.machineMonitor.isRunning()).toBe(true);
    ws.close();
    await waitFor(() => !machine.machineMonitor.isRunning());
  });

  it('does not leak a registration when a second start replaces the first on the same socket', async () => {
    const { ws, received } = await startRecording('twice');
    ws.send(JSON.stringify({ type: 'start', engine: 'mlx', outputMode: 'correct-only', sourceLanguage: 'nl', targetLanguage: 'en', archiveId: 'twice' }));
    await waitFor(() => received.filter(m => m.type === 'ready').length === 2);
    ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => received.some(m => m.type === 'stop_complete'));
    await waitFor(() => !machine.machineMonitor.isRunning());
  });

  it('monitors two recordings at once, each in its own folder, and keeps going until the last one ends', async () => {
    const a = await startRecording('first');
    const b = await startRecording('second');
    expect(readdirSync(archiveRoot)).toHaveLength(2);
    await machine.machineMonitor.sampleOnce();
    await waitFor(() => readdirSync(archiveRoot).every(d => existsSync(join(archiveRoot, d, 'machine.jsonl'))));
    a.ws.close();
    await new Promise(r => setTimeout(r, 100));
    expect(machine.machineMonitor.isRunning()).toBe(true);
    b.ws.close();
    await waitFor(() => !machine.machineMonitor.isRunning());
  });
});
