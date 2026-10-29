import { WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import { transcribeAudio, correctAndTranslateText, correctTranscript, buildWhisperPrompt } from './openai';
import { correctAndTranslateWithClaude, correctTranscriptWithClaude } from './anthropic';
import { correctAndTranslateWithOllama, correctTranscriptWithOllama, DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from './ollama';
import { transcribeWithMlxDetailed, type MlxDiag } from './mlx-whisper';
import { selectLowConfidenceWords, type UncertainWord } from './low-confidence';
import { isAsrArtifact, stripAsrArtifacts } from './asr-artifacts';
import { applyLearnedCorrections, effectiveGlossary } from './asr-corrections';
import { transcribeGuarded, wavDurationSecs } from './whisper-guard';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, unlink, appendFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import { Semaphore } from './semaphore';
import { machineMonitor, type ChunkBacklog } from './machine-monitor';

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
  // Per-recording folder for the ASR_DEBUG_DIR archive; null when disabled.
  archiveDir: string | null;
  // chunk_meta messages from the client, keyed by chunk index (arrive just ahead of the audio frame).
  chunkMeta: Map<number, Record<string, unknown>>;
}

export interface ChunkResult {
  correctedText: string;
  translatedText: string;
  /** Words Whisper was clearly unsure about in this chunk (MLX engine only) — the page offers them for a second look. */
  lowWords?: string[];
  // Called by flushInOrder once this result has actually been sent on (archive timestamps).
  onDelivered?: () => void;
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

// When each chunk of a session was received and has not finished yet, for the machine monitor's backlog
// figures. A WeakMap so ChunkSession (built by hand in tests) needs no extra field.
const inFlightSince = new WeakMap<ChunkSession, Map<number, number>>();

function backlogOf(session: ChunkSession, now = Date.now()): ChunkBacklog {
  const since = inFlightSince.get(session);
  let oldest: number | null = null;
  since?.forEach((t) => { if (oldest === null || t < oldest) oldest = t; });
  return { inFlight: session.pendingChunkPromises.size, waitingForEarlier: session.pendingResults.size, oldestMs: oldest === null ? null : now - oldest };
}

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

// ASR_DEBUG_DIR=<dir> records each recording as a folder <dir>/<timestamp>-<id>/:
//   <idx>.wav + <idx>.json        every chunk sent to Whisper (+ raw/stripped/corrected text, worker diag, timings)
//   discarded-<startSample>.wav/.json   audio the browser's speech gate rejected (never transcribed)
//   telemetry.jsonl               per-frame level / noise floor / VAD / gate timeline from the browser
//   starts.jsonl, client.json     the session's start messages (API keys removed) and browser audio config
//   devices.jsonl                 each microphone switch during the recording (label + sample position)
//   transcript.json              on-screen segments, posted by the sermon page (see routes.ts)
// `scripts/asr-session-audio.ts` joins the WAVs into one full.wav. Off by default.
const ASR_DEBUG_DIR = process.env.ASR_DEBUG_DIR || '';
const archiveDirs = new Map<string, string>();
let currentArchiveDir: string | null = null;

export function archiveEnabled(): boolean { return !!ASR_DEBUG_DIR; }
/** The most recently opened archive folder — the one a transcript snapshot belongs to. */
export function getCurrentArchiveDir(): string | null { return currentArchiveDir; }

// One folder per recording (the client's archiveId), so a mid-recording WebSocket reconnect —
// which sends a fresh 'start' — keeps writing into the same folder.
function resolveArchiveDir(archiveId?: unknown): string | null {
  if (!ASR_DEBUG_DIR) return null;
  const id = typeof archiveId === 'string' ? archiveId.replace(/[^a-z0-9]/gi, '').slice(0, 16) : '';
  const key = id || randomUUID();
  let dir = archiveDirs.get(key);
  if (!dir) {
    dir = join(ASR_DEBUG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}${id ? `-${id}` : ''}`);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn('ASR_DEBUG_DIR unusable — archive disabled:', err);
      return null;
    }
    archiveDirs.set(key, dir);
  }
  currentArchiveDir = dir;
  return dir;
}

// Reports what the MLX worker dropped or left uncovered, so a lost stretch of
// speech shows up in the debug overlay instead of vanishing silently.
function describeDiag(diag: MlxDiag): string[] {
  const lines: string[] = [];
  for (const seg of diag.segments) {
    if (seg.dropped) lines.push(`dropped segment ${seg.start}-${seg.end}s (${seg.dropped}, cr=${seg.compression_ratio}, lp=${seg.avg_logprob}, ns=${seg.no_speech_prob}): "${seg.text.slice(0, 60)}"`);
  }
  for (const [start, end] of diag.uncovered) lines.push(`no speech text for ${start}-${end}s (${(end - start).toFixed(1)}s)`);
  return lines;
}

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
        ...(result.lowWords?.length ? { lowWords: result.lowWords } : {}),
      }));
    }

    result.onDelivered?.();
    session.nextExpectedChunk++;
  }
}

// flushInOrder plus a progress note for the client: "every chunk below `done` has been handled".
// A chunk that produced no text (silence, a caption artifact) sends no 'translation' message, so
// without this the page could not tell an empty chunk from one still in flight (its pipeline-health
// backlog). Kept out of flushInOrder itself, whose message stream is pinned by unit tests.
function deliverInOrder(session: ChunkSessionForTest & { clientWs: { readyState: number; send: (data: string) => void } }): void {
  const before = session.nextExpectedChunk;
  flushInOrder(session);
  if (session.nextExpectedChunk > before && session.clientWs.readyState === 1 /* WS OPEN */) {
    session.clientWs.send(JSON.stringify({ type: 'chunk_progress', done: session.nextExpectedChunk }));
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

// A chunk that yields no text (silence, a caption artifact, an aborted session)
// still gets an entry in pendingResults, so the chunks behind it are not held
// up; `correctedText` is only non-empty when an aborted chunk keeps its raw text.
function deliverEmpty(session: ChunkSession, chunkIndex: number, correctedText = ''): void {
  session.pendingResults.set(chunkIndex, { correctedText, translatedText: '' });
  deliverInOrder(session);
}

// The ASR_DEBUG_DIR record of one chunk: `record` is filled in as the pipeline
// progresses, `write()` flushes it to <idx>.json (a no-op when the archive is off).
interface ChunkArchive {
  record: Record<string, unknown>;
  write(): Promise<void>;
}

function openChunkArchive(session: ChunkSession, chunkIndex: number, audioBuffer: Buffer, isWav: boolean): ChunkArchive {
  const record: Record<string, unknown> = { chunkIndex, bytes: audioBuffer.length, receivedAt: new Date().toISOString(), meta: session.chunkMeta.get(chunkIndex) ?? null };
  session.chunkMeta.delete(chunkIndex);
  if (session.archiveDir) {
    // Written up front so the audio survives even if transcription crashes.
    writeFile(join(session.archiveDir, `${chunkIndex}.${isWav ? 'wav' : 'webm'}`), audioBuffer).catch(() => {});
  }
  return {
    record,
    write: () => session.archiveDir
      ? writeFile(join(session.archiveDir, `${chunkIndex}.json`), JSON.stringify(record, null, 2)).catch(() => {})
      : Promise.resolve(),
  };
}

// Whisper (OpenAI or the local MLX worker), with the truncation guard.
async function transcribeChunk(
  session: ChunkSession,
  audioPath: string,
  audioBuffer: Buffer,
  chunkIndex: number,
  isWav: boolean,
  archive: ChunkArchive,
  signal: AbortSignal,
): Promise<{ rawText: string; uncertainWords?: UncertainWord[] }> {
  // Only the client's WAV frames have a known duration; legacy webm chunks skip the guard.
  const audioDurationSecs = isWav ? wavDurationSecs(audioBuffer.length) : Number.NaN;

  if (session.engine === 'mlx') {
    sendDebug(session, `Chunk #${chunkIndex}: sending to local MLX Whisper (${session.sourceLanguage})…`);
    const initialPrompt = buildWhisperPrompt(effectiveGlossary(session.glossary) || undefined, session.sermonContext || undefined, session.previousTranscript || undefined, session.sourceLanguage);
    const attempts: Array<{ usePrompt: boolean; diag: MlxDiag | null; uncertain?: UncertainWord[]; text?: string; decodeSecs?: number }> = [];
    // The text that wins (first or retry attempt) decides which attempt's uncertain words apply.
    const uncertainByText = new Map<string, UncertainWord[] | undefined>();
    const guarded = await transcribeGuarded(
      async (usePrompt) => {
        const res = await transcribeWithMlxDetailed(audioPath, session.sourceLanguage, usePrompt ? initialPrompt : undefined, signal);
        attempts.push({ usePrompt, diag: res.diag, uncertain: res.uncertain, text: res.text, decodeSecs: res.decodeSecs });
        uncertainByText.set(res.text, res.uncertain);
        return res.text;
      },
      !!initialPrompt, audioDurationSecs,
    );
    archive.record.attempts = attempts;
    archive.record.guardRetried = guarded.retried;
    for (const { usePrompt, diag } of attempts) {
      if (diag) for (const line of describeDiag(diag)) sendDebug(session, `Chunk #${chunkIndex}${usePrompt ? '' : ' (no-prompt retry)'}: ${line}`);
    }
    if (guarded.retried) sendDebug(session, `Chunk #${chunkIndex}: transcript implausibly short for ${audioDurationSecs.toFixed(1)}s of audio — retried without the prompt`);
    archive.record.rawText = guarded.text;
    return { rawText: guarded.text, uncertainWords: uncertainByText.get(guarded.text) };
  }

  const hasOpenAIKey = !!(session.openaiApiKey || process.env.OPENAI_API_KEY);
  if (!hasOpenAIKey) {
    sendDebug(session, `Chunk #${chunkIndex}: ✗ No OpenAI API key — transcription will fail`);
  } else {
    sendDebug(session, `Chunk #${chunkIndex}: sending to Whisper (${session.sourceLanguage})…`);
  }
  const hasPrompt = !!buildWhisperPrompt(effectiveGlossary(session.glossary) || undefined, session.sermonContext || undefined, session.previousTranscript || undefined, session.sourceLanguage);
  const guarded = await transcribeGuarded(
    (usePrompt) => transcribeAudio(
      audioPath, session.sourceLanguage, session.openaiApiKey || undefined,
      usePrompt ? effectiveGlossary(session.glossary) || undefined : undefined,
      usePrompt ? session.sermonContext || undefined : undefined,
      signal,
      usePrompt ? session.previousTranscript || undefined : undefined,
    ),
    hasPrompt, audioDurationSecs,
  );
  if (guarded.retried) sendDebug(session, `Chunk #${chunkIndex}: transcript implausibly short for ${audioDurationSecs.toFixed(1)}s of audio — retried without the prompt`);
  return { rawText: guarded.text };
}

// Filters Whisper's output before any LLM sees it. Returns the text to carry
// on with, or null when nothing real is left (the caller then marks the chunk empty).
function cleanTranscript(session: ChunkSession, rawText: string, chunkIndex: number, archive: ChunkArchive): string | null {
  // Whisper caption hallucination ("MUZIEK", "***", foreign-script
  // garbage) during silence/noise — see server/lib/asr-artifacts.ts's
  // header comment for why this can't be caught via no_speech_prob.
  // Must run before stripAsteriskArtifacts below, which would otherwise
  // strip the very asterisks that mark e.g. "*ZANG EN MUZIEK*" as an
  // annotation, leaving the hallucinated words behind.
  if (isAsrArtifact(rawText, session.sourceLanguage)) {
    sendDebug(session, `Chunk #${chunkIndex}: discarded — ASR artifact ("${rawText.slice(0, 40)}")`);
    return null;
  }

  // Partial artifacts mixed into real speech ("[Muziek] Goedemorgen",
  // trailing "Ondertiteling door …", decoder loops) — isAsrArtifact above
  // only catches a chunk that is ENTIRELY an artifact.
  const strippedText = stripAsrArtifacts(rawText, session.sourceLanguage);
  if (!strippedText) {
    sendDebug(session, `Chunk #${chunkIndex}: discarded — nothing left after artifact stripping ("${rawText.slice(0, 40)}")`);
    return null;
  }
  if (strippedText !== rawText.trim()) {
    sendDebug(session, `Chunk #${chunkIndex}: stripped ASR artifacts ("${rawText.slice(0, 40)}" → "${strippedText.slice(0, 40)}")`);
  }
  // Operator-learned fixes ("ik lees je logie" -> "ecclesiologie", see asr-corrections.ts):
  // deterministic, so they hold even when the per-chunk LLM correction is off.
  const learnedText = applyLearnedCorrections(strippedText);
  if (learnedText !== strippedText) {
    sendDebug(session, `Chunk #${chunkIndex}: applied learned corrections ("${strippedText.slice(0, 40)}" → "${learnedText.slice(0, 40)}")`);
  }
  archive.record.strippedText = strippedText;
  archive.record.transcribedAt = new Date().toISOString();
  return learnedText;
}

// Sermon mode: correct the chunk, never translate it. Per-sentence
// translation with context happens later via /api/sermon/translate —
// see server/lib/sermon-translate.ts.
async function correctSermonChunk(session: ChunkSession, rawText: string, chunkIndex: number, signal: AbortSignal): Promise<string> {
  try {
    if (session.translationProvider === 'none') {
      return rawText;
    } else if (session.translationProvider === 'ollama') {
      sendDebug(session, `Chunk #${chunkIndex}: correcting via Ollama (${session.ollamaModel})…`);
      return (await correctTranscriptWithOllama(
        rawText, session.targetLanguage, session.ollamaModel, session.ollamaBaseUrl,
        effectiveGlossary(session.glossary) || undefined, session.previousTranscript || undefined, signal, session.sourceLanguage,
      )).correctedText;
    } else if (session.translationProvider === 'claude') {
      const hasAnthropicKey = !!(session.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
      if (!hasAnthropicKey) sendDebug(session, `Chunk #${chunkIndex}: ✗ No Anthropic API key`);
      else sendDebug(session, `Chunk #${chunkIndex}: correcting via Claude Haiku…`);
      return (await correctTranscriptWithClaude(
        rawText, session.targetLanguage, session.anthropicApiKey,
        effectiveGlossary(session.glossary) || undefined, session.previousTranscript || undefined, signal, session.sourceLanguage,
      )).correctedText;
    }
    sendDebug(session, `Chunk #${chunkIndex}: correcting via GPT-4o-mini…`);
    return (await correctTranscript(
      rawText, session.targetLanguage, session.openaiApiKey || undefined,
      effectiveGlossary(session.glossary) || undefined, session.previousTranscript || undefined, signal, session.sourceLanguage,
    )).correctedText;
  } catch (correctionError) {
    if (correctionError instanceof Error && correctionError.name === 'AbortError') throw correctionError;
    // Correction is only polish: Whisper already produced the speech, so a failing
    // (or overloaded/offline) LLM must not erase this stretch of the sermon.
    console.error(`Chunk ${chunkIndex} correction failed — keeping the raw transcript:`, correctionError);
    sendDebug(session, `Chunk #${chunkIndex}: ✗ correction failed (${classifyError(correctionError)}) — using the raw transcript`);
    return rawText;
  }
}

// Live mode: correct and translate the chunk in one call.
async function translateChunk(
  session: ChunkSession,
  rawText: string,
  chunkIndex: number,
  signal: AbortSignal,
): Promise<{ correctedText: string; translatedText: string }> {
  if (session.translationProvider === 'none') {
    sendDebug(session, `Chunk #${chunkIndex}: translation disabled — using raw text`);
    return { correctedText: rawText, translatedText: '' };
  }
  if (session.translationProvider === 'ollama') {
    return correctAndTranslateWithOllama(
      rawText, session.targetLanguage, session.detectSpeakers,
      session.ollamaModel, session.ollamaBaseUrl,
      effectiveGlossary(session.glossary) || undefined, session.sermonContext || undefined, signal,
    );
  }
  if (session.translationProvider === 'claude') {
    const hasAnthropicKey = !!(session.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
    if (!hasAnthropicKey) sendDebug(session, `Chunk #${chunkIndex}: ✗ No Anthropic API key`);
    else sendDebug(session, `Chunk #${chunkIndex}: sending to Claude Haiku (→ ${session.targetLanguage})…`);
    return correctAndTranslateWithClaude(
      rawText,
      session.targetLanguage,
      session.detectSpeakers,
      session.anthropicApiKey,
      effectiveGlossary(session.glossary) || undefined,
      session.sermonContext || undefined,
      signal,
    );
  }
  sendDebug(session, `Chunk #${chunkIndex}: sending to GPT-4o-mini (→ ${session.targetLanguage})…`);
  return correctAndTranslateText(
    rawText,
    session.targetLanguage,
    session.detectSpeakers,
    session.openaiApiKey || undefined,
    effectiveGlossary(session.glossary) || undefined,
    session.sermonContext || undefined,
    signal,
  );
}

// Pipeline per chunk: convert audio → Whisper → filter → correct (+ translate).
// Chunks are processed concurrently; results are buffered and delivered in order.
// Exported for unit testing (tests/unit/chunk-pipeline.test.ts); not part of the public API.
export async function processChunk(
  session: ChunkSession,
  audioBuffer: Buffer,
  chunkIndex: number,
  isWav = false,
): Promise<void> {
  const { signal } = session.abortController;
  let audioPath: string | null = null;
  const semaphore = session.engine === 'mlx' ? mlxSemaphore : whisperSemaphore;
  const archive = openChunkArchive(session, chunkIndex, audioBuffer, isWav);

  sendDebug(session, `Chunk #${chunkIndex}: received (${audioBuffer.length} bytes, ${isWav ? 'WAV' : 'webm'}) — waiting for slot`);
  const receivedAt = Date.now();
  let since = inFlightSince.get(session);
  if (!since) inFlightSince.set(session, since = new Map());
  since.set(chunkIndex, receivedAt);
  await semaphore.acquire();
  // Time spent queued behind other chunks for the Whisper slot — the first thing to grow when the machine can't keep up.
  archive.record.slotWaitMs = Date.now() - receivedAt;
  // The session was aborted (drain timeout after 'stop', or the socket closed) before this chunk got an answer:
  // the archive says so, otherwise it looks like a chunk Whisper heard nothing in.
  const deliverAborted = (text = ''): void => { archive.record.aborted = true; deliverEmpty(session, chunkIndex, text); };
  try {
    if (isWav) {
      sendDebug(session, `Chunk #${chunkIndex}: writing WAV file…`);
      audioPath = await writeWavFile(audioBuffer);
    } else {
      sendDebug(session, `Chunk #${chunkIndex}: converting audio to MP3…`);
      audioPath = await convertAudioToMp3(audioBuffer);
    }
    await simulateLatency();

    if (signal.aborted) return deliverAborted();

    const { rawText: whisperText, uncertainWords } = await transcribeChunk(session, audioPath, audioBuffer, chunkIndex, isWav, archive, signal);

    if (!whisperText.trim()) {
      if (signal.aborted) return deliverAborted(); // an aborted transcription comes back empty too
      sendDebug(session, `Chunk #${chunkIndex}: silent — no speech detected`);
      return deliverEmpty(session, chunkIndex);
    }

    const rawText = cleanTranscript(session, whisperText, chunkIndex, archive);
    if (rawText === null) return deliverEmpty(session, chunkIndex);

    sendDebug(session, `Chunk #${chunkIndex}: Whisper → "${rawText.slice(0, 60)}${rawText.length > 60 ? '…' : ''}"`);

    // Send raw Whisper output immediately as a preview while correction runs
    if (session.clientWs.readyState === WsWebSocket.OPEN) {
      session.clientWs.send(JSON.stringify({
        type: 'raw_transcript',
        text: rawText,
        chunkIndex,
      }));
    }

    if (signal.aborted) return deliverAborted(rawText);

    let correctedText: string;
    let translatedText: string;
    if (session.outputMode === 'correct-only') {
      correctedText = await correctSermonChunk(session, rawText, chunkIndex, signal);
      translatedText = '';
    } else {
      ({ correctedText, translatedText } = await translateChunk(session, rawText, chunkIndex, signal));
    }

    correctedText = stripAsteriskArtifacts(correctedText);
    translatedText = stripAsteriskArtifacts(translatedText);
    archive.record.correctedText = correctedText;
    archive.record.correctedAt = new Date().toISOString();

    sendDebug(session, `Chunk #${chunkIndex}: ✓ done`);
    session.pendingResults.set(chunkIndex, {
      correctedText, translatedText,
      lowWords: selectLowConfidenceWords(uncertainWords),
      // A chunk finished early can wait behind a slower earlier one — record when it actually left.
      onDelivered: session.archiveDir ? () => { archive.record.deliveredAt = new Date().toISOString(); void archive.write(); } : undefined,
    });
    deliverInOrder(session);

  } catch (error) {
    // The session's own signal too: the OpenAI SDK rejects an aborted request with APIUserAbortError, not AbortError.
    if (session.abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return deliverAborted();
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
    deliverEmpty(session, chunkIndex);
  } finally {
    semaphore.release();
    since.delete(chunkIndex);
    if (audioPath) await safeUnlink(audioPath);
    await archive.write();
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
            if (session) machineMonitor.unregister(session);
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
              ollamaBaseUrl: message.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
              ollamaModel: message.ollamaModel || DEFAULT_OLLAMA_MODEL,
              glossary: message.glossary || '',
              sermonContext: message.sermonContext || '',
              debugMode: message.debugMode ?? false,
              previousTranscript: message.previousTranscript || '',
              nextExpectedChunk: resolveStartChunkIndex(message),
              pendingResults: new Map(),
              abortController: new AbortController(),
              pendingChunkPromises: new Set(),
              archiveDir: resolveArchiveDir(message.archiveId),
              chunkMeta: new Map(),
            };
            activeSessions.set(clientWs, session);
            if (session.archiveDir) {
              const started = session;
              machineMonitor.register(started, session.archiveDir, () => backlogOf(started));
              // API keys are never written to disk.
              const safe = { ...message, openaiApiKey: undefined, anthropicApiKey: undefined };
              appendFile(join(session.archiveDir, 'starts.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...safe }) + '\n').catch(() => {});
            }
            clientWs.send(JSON.stringify({ type: 'ready', archive: !!session.archiveDir }));

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

          } else if (message.type === 'chunk_meta') {
            if (session?.archiveDir) {
              if (message.discarded) {
                writeFile(join(session.archiveDir, `discarded-${Number(message.startSample)}.json`), JSON.stringify({ ...message, receivedAt: new Date().toISOString() }, null, 2)).catch(() => {});
              } else if (typeof message.chunkIndex === 'number') {
                session.chunkMeta.set(message.chunkIndex, message);
              }
            }

          } else if (message.type === 'telemetry') {
            if (session?.archiveDir && Array.isArray(message.rows) && message.rows.length) {
              appendFile(join(session.archiveDir, 'telemetry.jsonl'), message.rows.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n').catch(() => {});
            }

          } else if (message.type === 'perf') {
            // The page's own load (long tasks, timer drift, heap), every few seconds — see client/src/lib/sermon/perf-monitor.ts.
            if (session?.archiveDir && Array.isArray(message.rows) && message.rows.length) {
              appendFile(join(session.archiveDir, 'browser.jsonl'), message.rows.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n').catch(() => {});
            }

          } else if (message.type === 'client_info') {
            if (session?.archiveDir) {
              writeFile(join(session.archiveDir, 'client.json'), JSON.stringify(message, null, 2)).catch(() => {});
            }

          } else if (message.type === 'device_switch') {
            if (session?.archiveDir) {
              appendFile(join(session.archiveDir, 'devices.jsonl'), JSON.stringify({ at: new Date().toISOString(), label: String(message.label ?? '').slice(0, 200), fellBack: !!message.fellBack, startSample: Number(message.startSample) || 0 }) + '\n').catch(() => {});
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
                machineMonitor.unregister(stoppingSession); // after the drain, so the tail of the backlog is still logged
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

          // Archive-only frame (flag bit 0x02): audio the browser's speech gate rejected, shipped
          // so the recording has no holes. Its 4-byte header field is the start sample, not a chunk
          // index — written to disk and nothing else; it must never reach pendingResults/flushInOrder.
          if (buf.length > 5 && (buf[4] & 0x02)) {
            if (activeSession.archiveDir) {
              writeFile(join(activeSession.archiveDir, `discarded-${buf.readUInt32BE(0)}.wav`), buf.subarray(5)).catch(() => {});
            }
            return;
          }

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
            deliverInOrder(activeSession);
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
      if (session) { session.abortController.abort(); machineMonitor.unregister(session); }
      activeSessions.delete(clientWs);
      session = null;
    });

    clientWs.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });
}
