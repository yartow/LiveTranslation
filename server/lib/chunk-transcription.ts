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
  debugMode: boolean;
  previousTranscript: string;
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

async function writeWavFile(inputBuffer: Buffer): Promise<string> {
  const id = randomUUID();
  const wavPath = join(tmpdir(), `audio-${id}.wav`);
  await writeFile(wavPath, inputBuffer);
  return wavPath;
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

function sendDebug(session: ChunkSession, message: string): void {
  if (!session.debugMode || session.clientWs.readyState !== WsWebSocket.OPEN) return;
  session.clientWs.send(JSON.stringify({ type: 'debug', message }));
}

function classifyError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error';
  const msg = error.message;
  const anyErr = error as any;
  if (anyErr.status === 401 || msg.toLowerCase().includes('api key') || msg.toLowerCase().includes('authentication')) {
    return 'API key invalid or missing';
  }
  if (anyErr.status === 429 || msg.toLowerCase().includes('rate limit')) {
    return 'Rate limit exceeded — try again shortly';
  }
  if (msg.toLowerCase().includes('audio conversion failed')) {
    return `Audio conversion failed (ffmpeg error)`;
  }
  return msg;
}

// Pipeline per chunk: convert audio → Whisper → GPT/Claude correct+translate.
// Chunks are processed concurrently; results are buffered and delivered in order.
async function processChunk(
  session: ChunkSession,
  audioBuffer: Buffer,
  chunkIndex: number,
  isWav = false,
): Promise<void> {
  const { signal } = session.abortController;
  let audioPath: string | null = null;

  sendDebug(session, `Chunk #${chunkIndex}: received (${audioBuffer.length} bytes, ${isWav ? 'WAV' : 'webm'}) — waiting for slot`);
  await whisperSemaphore.acquire();
  try {
    if (isWav) {
      sendDebug(session, `Chunk #${chunkIndex}: writing WAV file…`);
      audioPath = await writeWavFile(audioBuffer);
    } else {
      sendDebug(session, `Chunk #${chunkIndex}: converting audio to MP3…`);
      audioPath = await convertAudioToMp3(audioBuffer);
    }
    await simulateLatency();

    if (signal.aborted) {
      session.pendingResults.set(chunkIndex, { correctedText: '', translatedText: '' });
      flushInOrder(session);
      return;
    }

    const hasOpenAIKey = !!(session.openaiApiKey || process.env.OPENAI_API_KEY);
    if (!hasOpenAIKey) {
      sendDebug(session, `Chunk #${chunkIndex}: ✗ No OpenAI API key — transcription will fail`);
    } else {
      sendDebug(session, `Chunk #${chunkIndex}: sending to Whisper (${session.sourceLanguage})…`);
    }

    const rawText = await transcribeAudio(audioPath, session.sourceLanguage, session.openaiApiKey || undefined, session.glossary || undefined, session.sermonContext || undefined, signal, session.previousTranscript || undefined);

    if (!rawText.trim()) {
      sendDebug(session, `Chunk #${chunkIndex}: silent — no speech detected`);
      session.pendingResults.set(chunkIndex, { correctedText: '', translatedText: '' });
      flushInOrder(session);
      return;
    }

    sendDebug(session, `Chunk #${chunkIndex}: Whisper → "${rawText.slice(0, 60)}${rawText.length > 60 ? '…' : ''}"`);

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
      sendDebug(session, `Chunk #${chunkIndex}: translation disabled — using raw text`);
      correctedText = rawText;
      translatedText = '';
    } else if (session.translationProvider === 'claude') {
      const hasAnthropicKey = !!(session.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
      if (!hasAnthropicKey) sendDebug(session, `Chunk #${chunkIndex}: ✗ No Anthropic API key`);
      else sendDebug(session, `Chunk #${chunkIndex}: sending to Claude Haiku (→ ${session.targetLanguage})…`);
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
      sendDebug(session, `Chunk #${chunkIndex}: sending to GPT-4o-mini (→ ${session.targetLanguage})…`);
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

    sendDebug(session, `Chunk #${chunkIndex}: ✓ done`);
    session.pendingResults.set(chunkIndex, { correctedText, translatedText });
    flushInOrder(session);

  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      session.pendingResults.set(chunkIndex, { correctedText: '', translatedText: '' });
      flushInOrder(session);
      return;
    }
    const label = classifyError(error);
    console.error(`Chunk ${chunkIndex} error:`, error);
    sendDebug(session, `Chunk #${chunkIndex}: ✗ ${label}`);
    if (session.clientWs.readyState === WsWebSocket.OPEN) {
      session.clientWs.send(JSON.stringify({
        type: 'chunk_error',
        message: label,
        chunkIndex,
      }));
    }
    session.pendingResults.set(chunkIndex, { correctedText: '', translatedText: '' });
    flushInOrder(session);
  } finally {
    whisperSemaphore.release();
    if (audioPath) await safeUnlink(audioPath);
  }
}

export function setupChunkTranscriptionWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (clientWs: WsWebSocket) => {
    console.log('Client connected for chunk-based transcription');
    let session: ChunkSession | null = null;

    clientWs.on('message', (data: Buffer | string, isBinary: boolean) => {
      try {
        if (!isBinary) {
          const text = Buffer.isBuffer(data) ? (data as Buffer).toString('utf8') : (data as string);
          const message = JSON.parse(text);

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
              debugMode: message.debugMode ?? false,
              previousTranscript: message.previousTranscript || '',
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
              if (message.previousTranscript !== undefined) session.previousTranscript = message.previousTranscript;
            }

          } else if (message.type === 'stop') {
            if (session) session.abortController.abort();
            activeSessions.delete(clientWs);
            session = null;
          }

        } else if (isBinary || data instanceof Buffer) {
          if (!session) return;

          // Binary protocol: [4-byte big-endian chunk index][1-byte flags][audio data]
          // flags bit 0 (0x01): 1 = PCM16/WAV, 0 = legacy webm/opus
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
          if (buf.length < 6) return;

          const chunkIndex = buf.readUInt32BE(0);
          const flags = buf[4];
          const audioBuffer = buf.subarray(5);
          const isWav = (flags & 0x01) !== 0;

          // Reject oversized chunks to prevent memory/disk exhaustion
          if (audioBuffer.length > MAX_CHUNK_SIZE) {
            console.warn(`Chunk audio exceeds ${MAX_CHUNK_SIZE} bytes; discarding`);
            return;
          }

          // Reject unreasonably large indexes to prevent memory exhaustion
          if (chunkIndex > session.nextExpectedChunk + MAX_CHUNK_QUEUE_DEPTH) {
            console.warn(`Chunk index ${chunkIndex} exceeds queue depth limit; discarding`);
            return;
          }

          // Fire-and-forget: chunks are processed concurrently.
          // flushInOrder() ensures the client receives results in recording order.
          processChunk(session, audioBuffer, chunkIndex, isWav).catch((err) => {
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
