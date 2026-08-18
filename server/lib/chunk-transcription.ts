import { WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import { transcribeAudio, correctAndTranslateText, correctTranscript, buildWhisperPrompt } from './openai';
import { correctAndTranslateWithClaude, correctTranscriptWithClaude } from './anthropic';
import { correctAndTranslateWithOllama, correctTranscriptWithOllama } from './ollama';
import { transcribeWithMlx } from './mlx-whisper';
import { isAsrArtifact } from './asr-artifacts';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import { Semaphore } from './semaphore';

type TranslationProvider = 'openai' | 'claude' | 'ollama' | 'none';
type TranscriptionEngine = 'openai' | 'mlx';
// 'translate' is the existing chunk pipeline. 'correct-only' is sermon
// mode's ASR path: correct the chunk (punctuation, homophones) but never
// translate it — see client/src/lib/chunk-based-transcription.ts's
// OutputMode and the plan's "correctie-only ASR-pad" section.
type OutputMode = 'translate' | 'correct-only';

interface ChunkSession {
  clientWs: WsWebSocket;
  targetLanguage: string;
  sourceLanguage: string;
  detectSpeakers: boolean;
  engine: TranscriptionEngine;
  outputMode: OutputMode;
  translationProvider: TranslationProvider;
  openaiApiKey: string;
  anthropicApiKey: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
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
  // In-flight processChunk() calls, so 'stop' can wait for them to finish
  // and flush before acking — see the 'stop' handler below.
  pendingChunkPromises: Set<Promise<void>>;
}

export interface ChunkResult {
  correctedText: string;
  translatedText: string;
}

// Whisper occasionally hallucinates literal "***" runs in place of unclear
// or masked-profanity audio (e.g. "*** Er goed uitzien."). Asterisks are
// never legitimate content in a spoken transcript, so strip them outright
// rather than let them leak into segments/translations — no correction
// prompt in this codebase asks the model to insert them (that only happens
// in the unrelated export-formatting prompt, openai.ts's formatForExport),
// so any asterisk reaching here came straight from the ASR output itself.
export function stripAsteriskArtifacts(text: string): string {
  return text.replace(/\*+/g, '').replace(/[ \t]{2,}/g, ' ').trim();
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

// See flushInOrder's gap-recovery guard.
const MAX_PENDING_BEFORE_GAP_SKIP = 8;

// On 'stop', in-flight chunks are drained (allowed to finish and flush)
// rather than aborted, so the speaker's final utterance still reaches the
// client — see the 'stop' handler below. This bounds how long that wait
// can run before falling back to the old abort-immediately behaviour, in
// case a provider call is wedged. Kept below the client's own
// STOP_DRAIN_TIMEOUT_MS fallback (chunk-based-transcription.ts) so the
// server's ack has a chance to arrive first.
const STOP_DRAIN_TIMEOUT_MS = 15_000;

// When SIMULATE_LATENCY_MS is set, each chunk waits this many ms after the
// audio is converted before sending to Whisper. Simulates the time a mobile
// device needs to upload the audio blob over a real network connection.
const SIM_LATENCY_MS = parseInt(process.env.SIMULATE_LATENCY_MS || '0', 10);
const simulateLatency = (): Promise<void> =>
  SIM_LATENCY_MS > 0 ? new Promise(r => setTimeout(r, SIM_LATENCY_MS)) : Promise.resolve();

// Reject individual audio chunks larger than 10 MB.
const MAX_CHUNK_SIZE = 10 * 1024 * 1024;

const whisperSemaphore = new Semaphore(3);
// The MLX worker is a single local process sharing one GPU — running more
// than one transcription at a time would just serialize inside it anyway,
// so cap concurrency at 1 to avoid extra queueing jitter.
const mlxSemaphore = new Semaphore(1);

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
  // Gap recovery: every early-exit in the binary-frame handler below is
  // supposed to insert a pendingResults placeholder before returning, so an
  // index should never go permanently missing — but if one somehow still
  // does (a genuinely lost WebSocket frame, a bug not yet found), don't let
  // it stall every later chunk for the rest of the session. Once enough
  // completed results have piled up waiting behind the missing index, skip
  // ahead to the lowest one actually available.
  if (!session.pendingResults.has(session.nextExpectedChunk) && session.pendingResults.size > MAX_PENDING_BEFORE_GAP_SKIP) {
    const lowest = Math.min(...Array.from(session.pendingResults.keys()));
    console.warn(`Chunk ${session.nextExpectedChunk} never arrived — skipping ahead to ${lowest}`);
    session.nextExpectedChunk = lowest;
  }

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

// Resolves the chunk index a 'start' message wants the session to begin
// expecting from. Normally 0 for a genuinely new session. On a mid-recording
// WebSocket reconnect, the client's chunkIndex has already advanced past 0
// (it never resets across a reconnect — see chunk-based-transcription.ts's
// buildStartMessage/reconnectWs), so a fresh session defaulting to 0 here
// would wait forever for indices that will never arrive again, silently
// swallowing every chunk for the rest of the recording. Exported for
// testing; not part of the public API.
export function resolveStartChunkIndex(message: { nextChunkIndex?: unknown }): number {
  return typeof message.nextChunkIndex === 'number' && message.nextChunkIndex >= 0
    ? message.nextChunkIndex
    : 0;
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
  const semaphore = session.engine === 'mlx' ? mlxSemaphore : whisperSemaphore;

  sendDebug(session, `Chunk #${chunkIndex}: received (${audioBuffer.length} bytes, ${isWav ? 'WAV' : 'webm'}) — waiting for slot`);
  await semaphore.acquire();
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

    let rawText: string;
    if (session.engine === 'mlx') {
      sendDebug(session, `Chunk #${chunkIndex}: sending to local MLX Whisper (${session.sourceLanguage})…`);
      const initialPrompt = buildWhisperPrompt(session.glossary || undefined, session.sermonContext || undefined, session.previousTranscript || undefined);
      rawText = await transcribeWithMlx(audioPath, session.sourceLanguage, initialPrompt, signal);
    } else {
      const hasOpenAIKey = !!(session.openaiApiKey || process.env.OPENAI_API_KEY);
      if (!hasOpenAIKey) {
        sendDebug(session, `Chunk #${chunkIndex}: ✗ No OpenAI API key — transcription will fail`);
      } else {
        sendDebug(session, `Chunk #${chunkIndex}: sending to Whisper (${session.sourceLanguage})…`);
      }
      rawText = await transcribeAudio(audioPath, session.sourceLanguage, session.openaiApiKey || undefined, session.glossary || undefined, session.sermonContext || undefined, signal, session.previousTranscript || undefined);
    }

    if (!rawText.trim()) {
      sendDebug(session, `Chunk #${chunkIndex}: silent — no speech detected`);
      session.pendingResults.set(chunkIndex, { correctedText: '', translatedText: '' });
      flushInOrder(session);
      return;
    }

    // Whisper caption hallucination ("MUZIEK", "***", foreign-script
    // garbage) during silence/noise — see server/lib/asr-artifacts.ts's
    // header comment for why this can't be caught via no_speech_prob.
    // Must run before stripAsteriskArtifacts below, which would otherwise
    // strip the very asterisks that mark e.g. "*ZANG EN MUZIEK*" as an
    // annotation, leaving the hallucinated words behind.
    if (isAsrArtifact(rawText, session.sourceLanguage)) {
      sendDebug(session, `Chunk #${chunkIndex}: discarded — ASR artifact ("${rawText.slice(0, 40)}")`);
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

    if (session.outputMode === 'correct-only') {
      // Sermon mode: correct the chunk, never translate it. Per-sentence
      // translation with context happens later via /api/sermon/translate —
      // see server/lib/sermon-translate.ts.
      translatedText = '';
      if (session.translationProvider === 'none') {
        correctedText = rawText;
      } else if (session.translationProvider === 'ollama') {
        sendDebug(session, `Chunk #${chunkIndex}: correcting via Ollama (${session.ollamaModel})…`);
        ({ correctedText } = await correctTranscriptWithOllama(
          rawText, session.targetLanguage, session.ollamaModel, session.ollamaBaseUrl,
          session.glossary || undefined, session.previousTranscript || undefined, signal,
        ));
      } else if (session.translationProvider === 'claude') {
        const hasAnthropicKey = !!(session.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
        if (!hasAnthropicKey) sendDebug(session, `Chunk #${chunkIndex}: ✗ No Anthropic API key`);
        else sendDebug(session, `Chunk #${chunkIndex}: correcting via Claude Haiku…`);
        ({ correctedText } = await correctTranscriptWithClaude(
          rawText, session.targetLanguage, session.anthropicApiKey,
          session.glossary || undefined, session.previousTranscript || undefined, signal,
        ));
      } else {
        sendDebug(session, `Chunk #${chunkIndex}: correcting via GPT-4o-mini…`);
        ({ correctedText } = await correctTranscript(
          rawText, session.targetLanguage, session.openaiApiKey || undefined,
          session.glossary || undefined, session.previousTranscript || undefined, signal,
        ));
      }
    } else if (session.translationProvider === 'none') {
      sendDebug(session, `Chunk #${chunkIndex}: translation disabled — using raw text`);
      correctedText = rawText;
      translatedText = '';
    } else if (session.translationProvider === 'ollama') {
      ({ correctedText, translatedText } = await correctAndTranslateWithOllama(
        rawText, session.targetLanguage, session.detectSpeakers,
        session.ollamaModel, session.ollamaBaseUrl,
        session.glossary || undefined, session.sermonContext || undefined, signal,
      ));
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

    correctedText = stripAsteriskArtifacts(correctedText);
    translatedText = stripAsteriskArtifacts(translatedText);

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
    semaphore.release();
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
              engine: (message.engine as TranscriptionEngine) || 'openai',
              outputMode: (message.outputMode as OutputMode) || 'translate',
              translationProvider: (message.translationProvider as TranslationProvider) || 'openai',
              openaiApiKey: message.openaiApiKey || '',
              anthropicApiKey: message.anthropicApiKey || '',
              ollamaBaseUrl: message.ollamaBaseUrl || 'http://localhost:11434',
              ollamaModel: message.ollamaModel || 'qwen2.5:14b',
              glossary: message.glossary || '',
              sermonContext: message.sermonContext || '',
              debugMode: message.debugMode ?? false,
              previousTranscript: message.previousTranscript || '',
              nextExpectedChunk: resolveStartChunkIndex(message),
              pendingResults: new Map(),
              abortController: new AbortController(),
              pendingChunkPromises: new Set(),
            };
            activeSessions.set(clientWs, session);
            clientWs.send(JSON.stringify({ type: 'ready' }));

          } else if (message.type === 'config') {
            if (session) {
              if (message.targetLanguage) session.targetLanguage = message.targetLanguage;
              if (message.sourceLanguage) session.sourceLanguage = message.sourceLanguage;
              if (message.detectSpeakers !== undefined) session.detectSpeakers = message.detectSpeakers;
              if (message.engine) session.engine = message.engine;
              if (message.outputMode) session.outputMode = message.outputMode;
              if (message.translationProvider) session.translationProvider = message.translationProvider;
              if (message.openaiApiKey !== undefined) session.openaiApiKey = message.openaiApiKey;
              if (message.anthropicApiKey !== undefined) session.anthropicApiKey = message.anthropicApiKey;
              if (message.ollamaBaseUrl !== undefined) session.ollamaBaseUrl = message.ollamaBaseUrl;
              if (message.ollamaModel !== undefined) session.ollamaModel = message.ollamaModel;
              if (message.glossary !== undefined) session.glossary = message.glossary;
              if (message.sermonContext !== undefined) session.sermonContext = message.sermonContext;
              if (message.previousTranscript !== undefined) session.previousTranscript = message.previousTranscript;
            }

          } else if (message.type === 'stop') {
            if (session) {
              const stoppingSession = session;
              activeSessions.delete(clientWs);
              session = null;

              // Drain in-flight chunk processing instead of aborting it
              // outright — the speaker's final utterance is very often
              // still being transcribed/corrected right when 'stop' arrives
              // (see chunk-based-transcription.ts's stop(), which commits
              // one last chunk before sending this message), and aborting
              // it here used to reliably lose that final sentence. Only
              // fall back to aborting if draining takes unreasonably long
              // (e.g. a wedged provider call).
              const drainTimeout = setTimeout(() => stoppingSession.abortController.abort(), STOP_DRAIN_TIMEOUT_MS);
              Promise.allSettled(Array.from(stoppingSession.pendingChunkPromises)).then(() => {
                clearTimeout(drainTimeout);
                if (stoppingSession.clientWs.readyState === WsWebSocket.OPEN) {
                  stoppingSession.clientWs.send(JSON.stringify({ type: 'stop_complete' }));
                }
              });
            }
          }

        } else if (isBinary || data instanceof Buffer) {
          if (!session) return;
          const activeSession = session;

          // Binary protocol: [4-byte big-endian chunk index][1-byte flags][audio data]
          // flags bit 0 (0x01): 1 = PCM16/WAV, 0 = legacy webm/opus
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);

          // Below this length there isn't even a full 4-byte index to
          // attribute a hole to — nothing to reconcile, just drop it. In
          // practice the client never sends a frame this short.
          if (buf.length < 4) return;
          const chunkIndex = buf.readUInt32BE(0);

          // Every exit below THIS point knows chunkIndex, so it must insert
          // a pendingResults placeholder before returning — otherwise that
          // index never arrives, flushInOrder blocks on it forever (short
          // of the gap-recovery guard above), and every later chunk this
          // session sends is silently swallowed for the rest of the
          // recording.
          const dropChunk = (reason: string): void => {
            console.warn(`Chunk ${chunkIndex} dropped: ${reason}`);
            activeSession.pendingResults.set(chunkIndex, { correctedText: '', translatedText: '' });
            flushInOrder(activeSession);
          };

          if (buf.length < 6) { dropChunk('frame too short'); return; }

          const flags = buf[4];
          const audioBuffer = buf.subarray(5);
          const isWav = (flags & 0x01) !== 0;

          // Reject oversized chunks to prevent memory/disk exhaustion
          if (audioBuffer.length > MAX_CHUNK_SIZE) {
            dropChunk(`audio exceeds ${MAX_CHUNK_SIZE} bytes`);
            return;
          }

          // Reject unreasonably large indexes to prevent memory exhaustion
          if (chunkIndex > activeSession.nextExpectedChunk + MAX_CHUNK_QUEUE_DEPTH) {
            dropChunk('exceeds queue depth limit');
            return;
          }

          // Fire-and-forget: chunks are processed concurrently.
          // flushInOrder() ensures the client receives results in recording
          // order. Tracked in pendingChunkPromises so 'stop' can wait for
          // every in-flight chunk to finish before acking — see the 'stop'
          // handler above.
          const chunkPromise: Promise<void> = processChunk(activeSession, audioBuffer, chunkIndex, isWav)
            .catch((err) => { console.error('Unhandled chunk error:', err); })
            .finally(() => { activeSession.pendingChunkPromises.delete(chunkPromise); });
          activeSession.pendingChunkPromises.add(chunkPromise);
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
