import { WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import { transcribeAudio, correctAndTranslateText } from './openai';
import { correctAndTranslateWithClaude } from './anthropic';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import ffmpeg from 'fluent-ffmpeg';

type TranslationProvider = 'openai' | 'claude' | 'none';

interface ChunkSession {
  clientWs: WsWebSocket;
  targetLanguage: string;
  sourceLanguage: string;
  detectSpeakers: boolean;
  translationProvider: TranslationProvider;
  openaiApiKey: string;
  anthropicApiKey: string;
  glossary: string;
  sermonContext: string;
  // Tracks which chunk index to send to the client next (ordered delivery)
  nextExpectedChunk: number;
  // Stores completed results waiting for earlier chunks to finish
  pendingResults: Map<number, ChunkResult>;
  // Aborted when the session ends so in-flight LLM calls are cancelled
  abortController: AbortController;
}

export interface ChunkResult {
  correctedText: string;
  translatedText: string;
}

export interface ChunkSessionForTest {
  clientWs: { readyState: number; send: (msg: string) => void };
  nextExpectedChunk: number;
  pendingResults: Map<number, ChunkResult>;
}

const activeSessions = new Map<WsWebSocket, ChunkSession>();

// Safety limit: reject chunk indexes that are unreasonably far ahead to
// prevent unbounded memory growth in pendingResults.
const MAX_CHUNK_QUEUE_DEPTH = 200;

// When SIMULATE_LATENCY_MS is set, each chunk waits this many ms after the
// audio is converted before sending to Whisper. Simulates the time a mobile
// device needs to upload the audio blob over a real network connection.
const SIM_LATENCY_MS = parseInt(process.env.SIMULATE_LATENCY_MS || '0', 10);
const simulateLatency = (): Promise<void> =>
  SIM_LATENCY_MS > 0 ? new Promise(r => setTimeout(r, SIM_LATENCY_MS)) : Promise.resolve();

// Reject individual audio chunks larger than 10 MB.
const MAX_CHUNK_SIZE = 10 * 1024 * 1024;

class Semaphore {
  private slots: number;
  private queue: Array<() => void> = [];
  constructor(max: number) { this.slots = max; }
  acquire(): Promise<void> {
    if (this.slots > 0) { this.slots--; return Promise.resolve(); }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next(); else this.slots++;
  }
}
const whisperSemaphore = new Semaphore(3);

async function safeUnlink(path: string): Promise<void> {
  try {
    if (existsSync(path)) await unlink(path);
  } catch {}
}

async function convertAudioToMp3(inputBuffer: Buffer): Promise<string> {
  const id = randomUUID();
  const inputPath = join(tmpdir(), `audio-in-${id}.webm`);
  const outputPath = join(tmpdir(), `audio-out-${id}.mp3`);

  await writeFile(inputPath, inputBuffer);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions([
          '-err_detect', 'ignore_err',
          '-fflags', '+genpts+igndts+ignidx+discardcorrupt',
          '-analyzeduration', '0',
          '-probesize', '32',
          '-max_error_rate', '1.0',
        ])
        .toFormat('mp3')
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .audioChannels(1)
        .audioFrequency(16000)
        .outputOptions(['-write_xing', '0', '-id3v2_version', '0'])
        .on('end', () => resolve())
        .on('error', (err, _stdout, stderr) => {
          console.error('FFmpeg error:', err.message, stderr);
          reject(new Error(`Audio conversion failed: ${err.message}`));
        })
        .save(outputPath);
    });
  } finally {
    // Always clean up the input temp file, even if ffmpeg fails
    await safeUnlink(inputPath);
  }

  return outputPath;
}

// Flush completed results to the client in strict recording order.
// A chunk is only delivered after all lower-indexed chunks have been sent.
// Exported for unit testing; not part of the public API.
export function flushInOrder(session: ChunkSessionForTest): void {
  while (session.pendingResults.has(session.nextExpectedChunk)) {
    const result = session.pendingResults.get(session.nextExpectedChunk)!;
    session.pendingResults.delete(session.nextExpectedChunk);

    if (result.correctedText && session.clientWs.readyState === 1 /* WS OPEN */) {
      session.clientWs.send(JSON.stringify({
        type: 'translation',
        original: result.correctedText,
        translated: result.translatedText,
        chunkIndex: session.nextExpectedChunk,
        isFinal: true,
      }));
    }

    session.nextExpectedChunk++;
  }
}

// Pipeline per chunk: ffmpeg convert → Whisper → GPT/Claude correct+translate.
// Chunks are processed concurrently; results are buffered and delivered in order.
async function processChunk(
  session: ChunkSession,
  audioBuffer: Buffer,
  chunkIndex: number,
): Promise<void> {
  const { signal } = session.abortController;
  let mp3Path: string | null = null;

  await whisperSemaphore.acquire();
  try {
    mp3Path = await convertAudioToMp3(audioBuffer);
    await simulateLatency(); // emulate mobile audio-upload delay when enabled

    if (signal.aborted) {
      session.pendingResults.set(chunkIndex, { correctedText: '', translatedText: '' });
      flushInOrder(session);
      return;
    }

    const rawText = await transcribeAudio(mp3Path, session.sourceLanguage, session.openaiApiKey || undefined, session.glossary || undefined, session.sermonContext || undefined, signal);

    if (!rawText.trim()) {
      // Silent chunk — register empty result so ordering can advance
      session.pendingResults.set(chunkIndex, { correctedText: '', translatedText: '' });
      flushInOrder(session);
      return;
    }

    // Send raw Whisper output immediately as a preview while correction runs
    if (session.clientWs.readyState === WsWebSocket.OPEN) {
      session.clientWs.send(JSON.stringify({
        type: 'raw_transcript',
        text: rawText,
        chunkIndex,
      }));
    }

    if (signal.aborted) {
      session.pendingResults.set(chunkIndex, { correctedText: rawText, translatedText: '' });
      flushInOrder(session);
      return;
    }

    let correctedText: string;
    let translatedText: string;

    if (session.translationProvider === 'none') {
      // Skip LLM call entirely — return raw Whisper text as-is
      correctedText = rawText;
      translatedText = '';
    } else if (session.translationProvider === 'claude') {
      ({ correctedText, translatedText } = await correctAndTranslateWithClaude(
        rawText,
        session.targetLanguage,
        session.detectSpeakers,
        session.anthropicApiKey,
        session.glossary || undefined,
        session.sermonContext || undefined,
        signal,
      ));
    } else {
      // Default: OpenAI GPT-4o-mini
      ({ correctedText, translatedText } = await correctAndTranslateText(
        rawText,
        session.targetLanguage,
        session.detectSpeakers,
        session.openaiApiKey || undefined,
        session.glossary || undefined,
        session.sermonContext || undefined,
        signal,
      ));
    }

    session.pendingResults.set(chunkIndex, { correctedText, translatedText });
    flushInOrder(session);

  } catch (error) {
    // Don't log or surface errors from intentional aborts
    if (error instanceof Error && error.name === 'AbortError') {
      session.pendingResults.set(chunkIndex, { correctedText: '', translatedText: '' });
      flushInOrder(session);
      return;
    }
    console.error(`Chunk ${chunkIndex} error:`, error);
    if (session.clientWs.readyState === WsWebSocket.OPEN) {
      session.clientWs.send(JSON.stringify({
        type: 'chunk_error',
        message: error instanceof Error ? error.message : 'Unknown error',
        chunkIndex,
      }));
    }
    // Register empty so ordering is not permanently blocked
    session.pendingResults.set(chunkIndex, { correctedText: '', translatedText: '' });
    flushInOrder(session);
  } finally {
    whisperSemaphore.release();
    if (mp3Path) await safeUnlink(mp3Path);
  }
}

export function setupChunkTranscriptionWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (clientWs: WsWebSocket) => {
    console.log('Client connected for chunk-based transcription');
    let session: ChunkSession | null = null;

    clientWs.on('message', (data: Buffer | string, isBinary: boolean) => {
      try {
        if (!isBinary && typeof data === 'string') {
          const message = JSON.parse(data);

          if (message.type === 'start') {
            session = {
              clientWs,
              targetLanguage: message.targetLanguage || 'nl',
              sourceLanguage: message.sourceLanguage || 'en',
              detectSpeakers: message.detectSpeakers ?? false,
              translationProvider: (message.translationProvider as TranslationProvider) || 'openai',
              openaiApiKey: message.openaiApiKey || '',
              anthropicApiKey: message.anthropicApiKey || '',
              glossary: message.glossary || '',
              sermonContext: message.sermonContext || '',
              nextExpectedChunk: 0,
              pendingResults: new Map(),
              abortController: new AbortController(),
            };
            activeSessions.set(clientWs, session);
            clientWs.send(JSON.stringify({ type: 'ready' }));

          } else if (message.type === 'config') {
            if (session) {
              if (message.targetLanguage) session.targetLanguage = message.targetLanguage;
              if (message.sourceLanguage) session.sourceLanguage = message.sourceLanguage;
              if (message.detectSpeakers !== undefined) session.detectSpeakers = message.detectSpeakers;
              if (message.translationProvider) session.translationProvider = message.translationProvider;
              if (message.openaiApiKey !== undefined) session.openaiApiKey = message.openaiApiKey;
              if (message.anthropicApiKey !== undefined) session.anthropicApiKey = message.anthropicApiKey;
              if (message.glossary !== undefined) session.glossary = message.glossary;
              if (message.sermonContext !== undefined) session.sermonContext = message.sermonContext;
            }

          } else if (message.type === 'stop') {
            if (session) session.abortController.abort();
            activeSessions.delete(clientWs);
            session = null;
          }

        } else if (isBinary || data instanceof Buffer) {
          if (!session) return;

          // Binary protocol: first 4 bytes = chunk index (big-endian uint32),
          // remaining bytes = raw audio (webm/opus from MediaRecorder)
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
          if (buf.length < 5) return;

          const audioBuffer = buf.subarray(4);

          // Reject oversized chunks to prevent memory/disk exhaustion
          if (audioBuffer.length > MAX_CHUNK_SIZE) {
            console.warn(`Chunk audio exceeds ${MAX_CHUNK_SIZE} bytes; discarding`);
            return;
          }

          const chunkIndex = buf.readUInt32BE(0);

          // Reject unreasonably large indexes to prevent memory exhaustion
          if (chunkIndex > session.nextExpectedChunk + MAX_CHUNK_QUEUE_DEPTH) {
            console.warn(`Chunk index ${chunkIndex} exceeds queue depth limit; discarding`);
            return;
          }

          // Fire-and-forget: chunks are processed concurrently.
          // flushInOrder() ensures the client receives results in recording order.
          processChunk(session, audioBuffer, chunkIndex).catch((err) => {
            console.error('Unhandled chunk error:', err);
          });
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });

    clientWs.on('close', () => {
      console.log('Client disconnected');
      if (session) session.abortController.abort();
      activeSessions.delete(clientWs);
      session = null;
    });

    clientWs.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });
}
