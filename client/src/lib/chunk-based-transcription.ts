import { createSerialRunner } from './serial-runner';
import { PerfMonitor } from './sermon/perf-monitor';
import type { TranscriptionBackend } from './transcription-backend';

export interface ChunkTranscriptionEvents {
  onReady: () => void;
  onRawTranscript: (text: string, chunkIndex: number) => void;
  /** `lowWords`: words Whisper was clearly unsure about in this chunk (MLX engine only). */
  onTranslation: (original: string, translated: string, chunkIndex: number, lowWords?: string[]) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onStreamReady?: (stream: MediaStream) => void;
  onDebug?: (message: string) => void;
  /** `peak` (0-1, max |sample| in the frame) lets a meter flag clipping, which RMS alone hides. */
  onAudioLevel?: (rms: number, peak?: number) => void;
  /** A non-fatal heads-up for the operator (e.g. the chosen microphone was missing and the default was used). */
  onNotice?: (message: string) => void;
  /** A chunk was committed and sent to the server (pipeline health: the start of its delay). */
  onChunkSent?: (chunkIndex: number) => void;
  /** The server has handled every chunk below `done` — with or without text (pipeline health: the end of the delay). */
  onChunkProgress?: (done: number) => void;
  /** The connection dropped mid-recording and a reconnect was scheduled. */
  onReconnecting?: () => void;
}

export type TranslationProvider = 'openai' | 'claude' | 'ollama' | 'none';
// Which service actually runs the speech-to-text step. 'mlx' is the local
// mlx-whisper sidecar (Apple Silicon only) — same wire protocol as 'openai',
// just routed to a different engine server-side.
export type TranscriptionEngine = 'openai' | 'mlx';
// 'translate' is the existing behaviour (correct + translate each chunk).
// 'correct-only' is sermon mode's ASR path: correct punctuation/homophones
// but never translate — translation happens later, per-sentence, with
// context (see server/lib/sermon-translate.ts).
export type OutputMode = 'translate' | 'correct-only';

export interface ChunkStartOptions {
  sourceLanguage: string;
  targetLanguage: string;
  detectSpeakers: boolean;
  translationProvider?: TranslationProvider;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  glossary?: string;
  sermonContext?: string;
  debugMode?: boolean;
  normalizationGain?: number;
  chunkOverlapMs?: number;
  useVADChunking?: boolean;
  vadSilenceThresholdMs?: number;
  engine?: TranscriptionEngine;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

// Circular ring buffer keeping the last `capacity` float32 samples for overlap.
class OverlapBuffer {
  private buf: Float32Array;
  private writePos = 0;
  private filled = false;

  constructor(private capacity: number) {
    this.buf = new Float32Array(Math.max(1, capacity));
  }

  push(samples: Float32Array): void {
    if (this.capacity === 0) return;
    if (samples.length >= this.capacity) {
      this.buf.set(samples.subarray(samples.length - this.capacity));
      this.writePos = 0;
      this.filled = true;
      return;
    }
    const end = this.writePos + samples.length;
    if (end <= this.capacity) {
      this.buf.set(samples, this.writePos);
    } else {
      const firstPart = this.capacity - this.writePos;
      this.buf.set(samples.subarray(0, firstPart), this.writePos);
      this.buf.set(samples.subarray(firstPart), 0);
    }
    this.writePos = end % this.capacity;
    this.filled = this.filled || end >= this.capacity;
  }

  snapshot(): Float32Array {
    if (this.capacity === 0) return new Float32Array(0);
    if (!this.filled) return this.buf.slice(0, this.writePos);
    const result = new Float32Array(this.capacity);
    result.set(this.buf.subarray(this.writePos));
    result.set(this.buf.subarray(0, this.writePos), this.capacity - this.writePos);
    return result;
  }

  clear(): void {
    this.writePos = 0;
    this.filled = false;
  }

  resize(newCapacity: number): void {
    const old = this.snapshot();
    this.capacity = Math.max(0, newCapacity);
    this.buf = new Float32Array(Math.max(1, this.capacity));
    this.writePos = 0;
    this.filled = false;
    if (old.length > 0 && this.capacity > 0) {
      const take = Math.min(old.length, this.capacity);
      this.buf.set(old.subarray(old.length - take));
      this.writePos = take % this.capacity;
      this.filled = take >= this.capacity;
    }
  }
}

/**
 * Streaming band-limited resampler (windowed-sinc low-pass + decimate), fed
 * one audio callback at a time. The previous implementation picked every Nth
 * sample with no filtering, which folds everything above 8 kHz back into the
 * speech band (aliasing) and smears sibilants. State (filter history and
 * fractional position) carries across process() calls so frame boundaries
 * are seamless.
 */
export class Resampler {
  private readonly ratio: number;
  private readonly half: number;
  private readonly fc: number;
  private history: Float32Array;
  // Centre of the next output sample, in coordinates of (history ++ next input).
  private t: number;

  constructor(inRate: number, outRate: number) {
    this.ratio = inRate / outRate;
    // Low-pass just below the output Nyquist so the transition band finishes before 8 kHz.
    this.fc = (outRate * 0.45) / inRate;
    this.half = Math.max(1, Math.round(8 * this.ratio));
    this.history = new Float32Array(2 * this.half);
    this.t = 2 * this.half;
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input.slice();
    const { half, fc, ratio } = this;
    const buf = new Float32Array(this.history.length + input.length);
    buf.set(this.history);
    buf.set(input, this.history.length);

    const out: number[] = [];
    let t = this.t;
    while (Math.floor(t + half) < buf.length) {
      const first = Math.ceil(t - half);
      let acc = 0;
      for (let i = first; i <= Math.floor(t + half); i++) {
        const x = i - t;
        const u = 2 * fc * x;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
        const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / half) + 0.08 * Math.cos((2 * Math.PI * x) / half);
        acc += buf[i] * 2 * fc * sinc * w;
      }
      out.push(acc);
      t += ratio;
    }

    const shift = buf.length - 2 * half;
    this.history = buf.slice(shift);
    this.t = t - shift;
    return Float32Array.from(out);
  }
}

/**
 * Accumulates 16 kHz frames into a chunk and produces the audio to send on
 * commit: [overlap prefix][chunk audio]. The prefix is the tail of the
 * PREVIOUS committed chunk. (It used to be snapshotted from a ring buffer
 * that was fed every incoming frame, so by commit time it held the tail of
 * the SAME chunk — Whisper heard the last 0.5 s, then the whole chunk again.)
 */
export class ChunkAssembler {
  private segments: Float32Array[] = [];
  private count = 0;
  private overlap: OverlapBuffer;

  constructor(overlapSamples: number) {
    this.overlap = new OverlapBuffer(overlapSamples);
  }

  get sampleCount(): number {
    return this.count;
  }

  push(samples: Float32Array): void {
    this.segments.push(samples);
    this.count += samples.length;
  }

  resizeOverlap(samples: number): void {
    this.overlap.resize(samples);
  }

  /** The accumulated audio (without any overlap prefix), leaving the assembler untouched. */
  peek(): Float32Array {
    const out = new Float32Array(this.count);
    let offset = 0;
    for (const seg of this.segments) {
      out.set(seg, offset);
      offset += seg.length;
    }
    return out;
  }

  /** Returns prefix + accumulated audio, then keeps only the accumulated audio's tail as the next prefix. */
  commit(): Float32Array {
    const prefix = this.overlap.snapshot();
    const chunk = new Float32Array(this.count);
    let offset = 0;
    for (const seg of this.segments) {
      chunk.set(seg, offset);
      offset += seg.length;
    }
    const total = new Float32Array(prefix.length + chunk.length);
    total.set(prefix);
    total.set(chunk, prefix.length);
    this.overlap.push(chunk);
    this.segments = [];
    this.count = 0;
    return total;
  }

  /** Drops the accumulated audio and the (now stale) overlap prefix — used when a chunk is rejected as non-speech. */
  discard(): void {
    this.segments = [];
    this.count = 0;
    this.overlap.clear();
  }
}

function floatToPCM16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

// Builds a minimal 44-byte WAV header for 16-bit mono PCM at 16 kHz.
function buildWavBuffer(pcm16: Int16Array): ArrayBuffer {
  const dataBytes = pcm16.byteLength;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);        // chunk size
  view.setUint16(20, 1, true);         // PCM
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, 16000, true);     // sample rate
  view.setUint32(28, 32000, true);     // byte rate (16000 * 1 * 2)
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(pcm16);
  return buf;
}

const TARGET_RATE = 16_000;
const SCRIPT_PROCESSOR_FRAMES = 4096;
// A frame counts as VAD-silent below this multiple of the tracked noise floor
// (or the 0.005 absolute floor, whichever is higher) — see onaudioprocess.
const VAD_SILENCE_FLOOR_RATIO = 2.0;

// Speech-presence gate (see commitChunk). A frame counts as "voiced" once its
// mean-abs amplitude clears whichever is higher: an absolute floor (so a
// completely quiet/muted mic never counts), or a multiple of the room's
// recently observed noise floor (so a chunk isn't kept alive by steady room
// tone/hum). ABS_MIN_VOICED is set well below real speech at low gain —
// measured against actual quiet speech and background noise — see
// chunk-transcription.ts's header comment / CLAUDE.md for the measurements
// that produced these numbers.
const ABS_MIN_VOICED = 0.0012;
const NOISE_FLOOR_RATIO = 2.5;
// A chunk is kept only if its longest voiced run reaches MIN_SPEECH_RUN_MS.
// The gate analyses the audio in GATE_WINDOW_MS windows, NOT per
// ScriptProcessor frame: a frame is 4096 samples, i.e. 256 ms at the 16 kHz
// AudioContext the capture now requests, so counting "one voiced frame" as a
// frame's worth of speech let a single keystroke (a ~20 ms click) clear the
// 250 ms bar and ship a chunk of room noise to Whisper, which then invents
// text — in random languages — for it. Within a word the voiced windows are
// separated by brief plosive/fricative gaps; SPEECH_GAP_BRIDGE_MS lets a run
// continue across such a gap, so a short word ("Amen", "Ja") still forms one
// run, while clicks a few hundred ms apart (typing) stay separate ~20-40 ms
// runs. This replaces an earlier "OR total voiced time >= 400 ms" rule: summed
// over a 6-20 s chunk, scattered key clicks easily reach 400 ms.
const MIN_SPEECH_RUN_MS = 250;
const GATE_WINDOW_MS = 20;
const SPEECH_GAP_BRIDGE_MS = 80;
// The floor-rise rate below is defined per this much audio.
const NOISE_FLOOR_RISE_REFERENCE_MS = 85;
// Rate at which the adaptive noise floor is allowed to rise per frame when
// the current frame is louder than the tracked floor. The floor tracks
// DOWN instantly (any quieter frame becomes the new floor immediately) but
// rises slowly, so a burst of speech doesn't drag the floor up with it —
// only sustained loud room noise does, over several seconds.
const NOISE_FLOOR_RISE_RATE = 0.01;
// Fallback if the server's `stop_complete` ack (see stop() below) never
// arrives — e.g. a wedged provider call. Comfortably above any single
// chunk's transcription+correction timeouts server-side.
const STOP_DRAIN_TIMEOUT_MS = 20_000;

// Pure decision functions for the speech-presence gate, extracted and
// exported so the gate logic is testable without a real AudioContext/
// getUserMedia (this file otherwise only runs in a browser). See the
// constants above for the rationale behind each threshold.

/** Tracks the noise floor down instantly, up slowly (see NOISE_FLOOR_RISE_RATE). `rise` overrides the per-call rise rate. */
export function updateNoiseFloor(current: number, meanAbs: number, rise: number = NOISE_FLOOR_RISE_RATE): number {
  if (current === 0 || meanAbs < current) return meanAbs;
  return current + (meanAbs - current) * rise;
}

/** Whether one frame's mean-abs amplitude counts as voiced against the current noise floor. */
export function isFrameVoiced(meanAbs: number, noiseFloor: number): boolean {
  return meanAbs > Math.max(ABS_MIN_VOICED, noiseFloor * NOISE_FLOOR_RATIO);
}

/** Whether a whole chunk has enough speech to keep, given its longest (gap-bridged) voiced run. */
export function shouldKeepChunk(longestVoicedRunMs: number): boolean {
  return longestVoicedRunMs >= MIN_SPEECH_RUN_MS;
}

/**
 * The speech-presence gate: feed it consecutive GATE_WINDOW_MS windows of
 * mean-abs amplitude (see `windowMeanAbs`) and it tracks the room's noise
 * floor plus the chunk's longest voiced run. Pure and DOM-free so the gate can
 * be tested against synthetic key-click / speech / hum signals.
 */
export class SpeechGate {
  /** Persists for the whole session — a property of the room, not of one chunk. */
  noiseFloor = 0;
  longestRunMs = 0;
  private runMs = 0;
  private gapMs = 0;

  push(meanAbs: number, windowMs: number): void {
    const rise = NOISE_FLOOR_RISE_RATE * Math.min(1, windowMs / NOISE_FLOOR_RISE_REFERENCE_MS);
    this.noiseFloor = updateNoiseFloor(this.noiseFloor, meanAbs, rise);
    if (isFrameVoiced(meanAbs, this.noiseFloor)) {
      // A short gap that the run continues across counts as part of the run.
      this.runMs += this.gapMs + windowMs;
      this.gapMs = 0;
      this.longestRunMs = Math.max(this.longestRunMs, this.runMs);
    } else if (this.runMs > 0) {
      this.gapMs += windowMs;
      if (this.gapMs > SPEECH_GAP_BRIDGE_MS) { this.runMs = 0; this.gapMs = 0; }
    }
  }

  keepChunk(): boolean { return shouldKeepChunk(this.longestRunMs); }

  /** Start a new chunk; the noise floor is kept. */
  resetChunk(): void { this.runMs = 0; this.gapMs = 0; this.longestRunMs = 0; }
}

/** Mean absolute amplitude of `frame` over consecutive windows of `windowSamples` (the last one may be shorter). */
export function windowMeanAbs(frame: Float32Array, windowSamples: number): number[] {
  const out: number[] = [];
  for (let start = 0; start < frame.length; start += windowSamples) {
    const end = Math.min(frame.length, start + windowSamples);
    let sum = 0;
    for (let i = start; i < end; i++) sum += Math.abs(frame[i]);
    out.push(sum / (end - start));
  }
  return out;
}

/**
 * Level measurements for one audio frame. `rms`/`peak` are taken from the raw
 * input (what the input stage delivers, for the level meter); `gained` is the
 * input times the normalization gain, clamped to [-1, 1] so a high gain
 * cannot clip; `meanAbs` is the mean absolute value of `gained`, which the
 * silence gate and the VAD work from.
 */
export function analyzeFrame(input: Float32Array, gain: number): { rms: number; peak: number; gained: Float32Array; meanAbs: number } {
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < input.length; i++) {
    sumSq += input[i] * input[i];
    const a = Math.abs(input[i]);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSq / input.length);

  const gained = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    gained[i] = Math.max(-1, Math.min(1, input[i] * gain));
  }

  let sumAbs = 0;
  for (let i = 0; i < gained.length; i++) sumAbs += Math.abs(gained[i]);
  return { rms, peak, gained, meanAbs: sumAbs / gained.length };
}

/**
 * VAD "silence" for chunk cutting. Relative to the tracked noise floor: with
 * the browser's noise suppression off, a room's ambient level can sit above
 * any fixed threshold, in which case pauses would never be seen and every
 * chunk would run to the hard cap, cutting mid-word.
 */
export function isVadSilent(meanAbs: number, noiseFloor: number): boolean {
  return meanAbs < Math.max(0.005, noiseFloor * VAD_SILENCE_FLOOR_RATIO);
}

export interface CommitState {
  useVAD: boolean;
  vadSilenceMs: number;
  vadSilenceThresholdMs: number;
  /** Samples (16 kHz) buffered in the chunk being built. */
  sampleCount: number;
  minSamples: number;
  maxSamples: number;
}

/**
 * Whether the chunk being built should be cut now: 'vad' on a pause once
 * enough audio has accumulated, 'cap' at the hard maximum (also the only
 * trigger when VAD is off, i.e. fixed-length chunks), else null.
 */
export function decideCommit(s: CommitState): 'vad' | 'cap' | null {
  if (s.useVAD && s.vadSilenceMs >= s.vadSilenceThresholdMs && s.sampleCount >= s.minSamples) return 'vad';
  if (s.sampleCount >= s.maxSamples) return 'cap';
  return null;
}

/**
 * The deviceId the stream really opened ('' for the system default, which Chrome reports as
 * 'default'/'communications'), so callers compare against what is recording, not what was asked for.
 */
export function realDeviceId(stream: MediaStream): string {
  const id = stream.getAudioTracks()[0]?.getSettings?.().deviceId ?? '';
  return id === 'default' || id === 'communications' ? '' : id;
}

/** A microphone switch was requested but the recording is (or just got) stopped — not a device problem. */
export class RecordingStoppedError extends Error {
  constructor(message = 'Recording stopped') {
    super(message);
    this.name = 'RecordingStoppedError';
  }
}

export class ChunkBasedTranscription implements TranscriptionBackend {
  private ws: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;

  private events: ChunkTranscriptionEvents;
  private targetLanguage: string;
  private sourceLanguage: string;
  private detectSpeakers: boolean;
  private chunkDurationMs: number;
  private chunkIndex = 0;
  private isRecording = false;
  // True between pause() and resume(): the mic and socket stay open, but audio frames are dropped.
  private paused = false;
  private engine: TranscriptionEngine;
  private translationProvider: TranslationProvider;
  private openaiApiKey: string;
  private ollamaBaseUrl: string;
  private ollamaModel: string;
  private anthropicApiKey: string;
  private glossary: string;
  private sermonContext: string;
  private debugMode: boolean;
  private previousTranscript: string = '';
  // 'correct-only' skips the translation step server-side and returns
  // corrected-but-untranslated text via onTranslation(text, '', chunkIndex).
  // Used by sermon mode — see server/lib/chunk-transcription.ts.
  private outputMode: OutputMode = 'translate';

  // Audio pipeline config (runtime-adjustable)
  private normalizationGain: number = 1.0;
  private useVAD: boolean = false;
  private vadSilenceThresholdMs: number = 800;
  private overlapMs: number = 500;
  // Chunk length limits. A VAD cut is only allowed once minChunkMs of audio is
  // buffered (Whisper is far more accurate on several seconds of context than
  // on 1-2 s fragments), and a chunk is force-cut at maxChunkMs. Left unset,
  // maxChunkMs falls back to the old derivation from chunkDurationMs.
  private minChunkMs: number = 1000;
  private maxChunkMsOverride: number | null = null;
  // Disables the browser's call-style DSP (echo cancellation, noise
  // suppression, auto-gain). Those are tuned for voice calls: noise
  // suppression gates word tails and AGC pumps the level, both of which
  // Whisper handles worse than raw audio.
  private rawAudioCapture: boolean = true;
  /** '' = whatever the system default input is. */
  private inputDeviceId: string = '';

  // VAD state
  private vadSilenceMs: number = 0;
  // Set from the constructor as a fallback, then corrected in
  // startAudioCapture() once the AudioContext's real native sample rate is
  // known — onaudioprocess frames are SCRIPT_PROCESSOR_FRAMES samples at the
  // native rate (commonly 48kHz, ~85ms/frame), not at TARGET_RATE (16kHz,
  // which would be 256ms/frame). Using the wrong rate here made vadSilenceMs
  // accumulate ~3x too fast.
  private frameDurationMs: number;

  // Chunk accumulation (16 kHz float32 samples)
  // Speech-presence gate (see SpeechGate): the noise floor persists for the
  // whole session, the voiced-run tracking resets every commit/discard.
  private gate = new SpeechGate();
  private assembler: ChunkAssembler;
  private resampler: Resampler | null = null;

  // Reconnect state
  private intentionalClose = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private audioQueue: Array<ArrayBuffer | string> = [];

  // Session archive (server has ASR_DEBUG_DIR set — see server/lib/chunk-transcription.ts).
  // When on, gate-discarded audio is shipped too (archive-only frames), every chunk gets a
  // chunk_meta message, and a per-frame level/VAD timeline is streamed as telemetry. Off = no
  // extra traffic at all.
  private archive = false;
  private archiveId = '';
  // 16 kHz samples fed to the assembler since start(): the recording's own clock, so
  // chunk start offsets and telemetry rows line up with the archived audio.
  private samplesPushed = 0;
  private telemetryRows: Array<Record<string, number | boolean>> = [];
  private lastTelemetryFlushAt = 0;
  // The page's own load (long tasks, timer lateness), sent as `perf` rows while the archive is on.
  private perf: PerfMonitor | null = null;

  // Resolved when the server's 'stop_complete' message arrives — see stop().
  private stopCompleteResolve: (() => void) | null = null;

  constructor(events: ChunkTranscriptionEvents, chunkDurationMs = 5000) {
    this.events = events;
    this.targetLanguage = 'nl';
    this.sourceLanguage = 'en';
    this.detectSpeakers = false;
    this.chunkDurationMs = chunkDurationMs;
    this.engine = 'openai';
    this.translationProvider = 'openai';
    this.openaiApiKey = '';
    this.anthropicApiKey = '';
    this.ollamaBaseUrl = 'http://localhost:11434';
    this.ollamaModel = 'qwen3.6:latest';
    this.glossary = '';
    this.sermonContext = '';
    this.debugMode = false;
    this.frameDurationMs = (SCRIPT_PROCESSOR_FRAMES / TARGET_RATE) * 1000;
    this.assembler = new ChunkAssembler(Math.round(this.overlapMs * TARGET_RATE / 1000));
  }

  async start({
    sourceLanguage,
    targetLanguage,
    detectSpeakers,
    translationProvider = 'openai',
    openaiApiKey = '',
    anthropicApiKey = '',
    glossary = '',
    sermonContext = '',
    debugMode = false,
    normalizationGain = 1.0,
    chunkOverlapMs = 500,
    useVADChunking = false,
    vadSilenceThresholdMs = 800,
    engine = 'openai',
    ollamaBaseUrl,
    ollamaModel,
  }: ChunkStartOptions): Promise<void> {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;
    this.chunkIndex = 0;
    this.engine = engine;
    this.translationProvider = translationProvider;
    this.openaiApiKey = openaiApiKey;
    this.anthropicApiKey = anthropicApiKey;
    if (ollamaBaseUrl !== undefined) this.ollamaBaseUrl = ollamaBaseUrl;
    if (ollamaModel !== undefined) this.ollamaModel = ollamaModel;
    this.glossary = glossary;
    this.sermonContext = sermonContext;
    this.debugMode = debugMode;
    this.normalizationGain = normalizationGain;
    this.overlapMs = chunkOverlapMs;
    this.useVAD = useVADChunking;
    this.vadSilenceThresholdMs = vadSilenceThresholdMs;
    this.assembler.resizeOverlap(Math.round(this.overlapMs * TARGET_RATE / 1000));
    this.intentionalClose = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.audioQueue = [];
    this.previousTranscript = '';
    this.archive = false;
    this.perf?.stop();
    this.perf = null;
    this.archiveId = Date.now().toString(36);
    this.samplesPushed = 0;
    this.telemetryRows = [];
    this.lastTelemetryFlushAt = 0;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/chunk-transcribe`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        this.events.onDebug?.('WebSocket open — sending start message');
        ws.send(JSON.stringify(this.buildStartMessage()));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string);
          if (message.type === 'ready') {
            this.events.onDebug?.('Server acknowledged — requesting microphone…');
            this.archive = !!message.archive;
            if (this.archive) {
              this.events.onDebug?.('Session archive ON (server has ASR_DEBUG_DIR) — recording all audio + level timeline');
              this.startPerfMonitor();
            }
            this.ws = ws;
            this.attachWsHandlers(ws);
            this.startAudioCapture()
              .then(() => { this.events.onReady(); resolve(); })
              .catch((err: Error) => {
                this.events.onDebug?.(`Microphone error: ${err.message}`);
                reject(err);
              });
          }
        } catch (e) {
          console.warn('Unparseable WebSocket message:', e);
        }
      };

      ws.onerror = () => {
        this.events.onError('WebSocket connection error');
        reject(new Error('WebSocket connection error'));
      };

      ws.onclose = () => {
        reject(new Error('WebSocket closed during initialization'));
      };
    });
  }

  private buildStartMessage() {
    return {
      type: 'start',
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
      detectSpeakers: this.detectSpeakers,
      engine: this.engine,
      translationProvider: this.translationProvider,
      openaiApiKey: this.openaiApiKey,
      anthropicApiKey: this.anthropicApiKey,
      ollamaBaseUrl: this.ollamaBaseUrl,
      ollamaModel: this.ollamaModel,
      glossary: this.glossary,
      sermonContext: this.sermonContext,
      debugMode: this.debugMode,
      outputMode: this.outputMode,
      // On a mid-session reconnect (reconnectWs() reuses this same message),
      // this.chunkIndex has already advanced past 0 — the client keeps
      // counting chunks across reconnects, so the server's fresh session
      // must be told where to resume expecting indices from, or every chunk
      // sent after a reconnect waits forever for indices that will never
      // arrive (see server/lib/chunk-transcription.ts's nextExpectedChunk).
      nextChunkIndex: this.chunkIndex,
      previousTranscript: this.previousTranscript,
      // Groups a recording's reconnects into one archive folder server-side.
      archiveId: this.archiveId,
    };
  }

  private attachWsHandlers(ws: WebSocket): void {
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string);
        switch (message.type) {
          case 'raw_transcript':
            this.events.onRawTranscript(message.text, message.chunkIndex);
            break;
          case 'translation':
            this.events.onTranslation(message.original, message.translated, message.chunkIndex,
              Array.isArray(message.lowWords) ? message.lowWords.filter((w: unknown): w is string => typeof w === 'string') : undefined);
            break;
          case 'chunk_progress':
            if (typeof message.done === 'number') this.events.onChunkProgress?.(message.done);
            break;
          case 'chunk_error':
          case 'error':
            this.events.onError(message.message ?? 'Processing error');
            break;
          case 'debug':
            this.events.onDebug?.(message.message as string);
            break;
          case 'stop_complete':
            this.stopCompleteResolve?.();
            break;
        }
      } catch (e) {
        console.warn('Unparseable WebSocket message:', e);
      }
    };

    ws.onerror = () => { this.events.onError('WebSocket connection error'); };

    ws.onclose = () => {
      if (this.intentionalClose) {
        this.isRecording = false;
        this.events.onClose();
      } else if (this.isRecording) {
        this.reconnecting = true;
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    this.events.onReconnecting?.();
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    setTimeout(() => this.reconnectWs(), delay);
  }

  private reconnectWs(): void {
    if (this.intentionalClose || !this.isRecording) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/chunk-transcribe`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify(this.buildStartMessage()));
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string);
        if (message.type === 'ready') {
          this.archive = !!message.archive;
          this.ws = ws;
          this.reconnecting = false;
          this.reconnectAttempts = 0;
          this.attachWsHandlers(ws);
          const queued = this.audioQueue.splice(0);
          for (const buf of queued) ws.send(buf);
        }
      } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (!this.intentionalClose && this.isRecording && this.reconnecting) {
        this.scheduleReconnect();
      }
    };
  }

  /**
   * Opens the microphone `deviceId` ('' = system default). A device that has
   * disappeared since it was picked falls back to the system default
   * (`fellBack`) rather than failing; any other error is thrown.
   */
  private async openInput(deviceId: string): Promise<{ stream: MediaStream; fellBack: boolean }> {
    const constraints: MediaTrackConstraints = this.rawAudioCapture
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
      : { echoCancellation: true, noiseSuppression: true };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints,
      });
      return { stream, fellBack: false };
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw err;
      return { stream: await navigator.mediaDevices.getUserMedia({ audio: constraints }), fellBack: true };
    }
  }

  private async startAudioCapture(): Promise<void> {
    // The chosen microphone was unplugged since it was picked: never block the
    // recording on that, use the system default and say so.
    const opened = await this.openInput(this.inputDeviceId);
    this.mediaStream = opened.stream;
    if (opened.fellBack) this.events.onNotice?.('The selected microphone is not available — using the system default instead.');
    this.events.onStreamReady?.(this.mediaStream);
    this.events.onDebug?.(`Microphone acquired (${this.rawAudioCapture ? 'raw, no echo/noise/gain processing' : 'browser-processed'}) — starting PCM pipeline`);

    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext as typeof AudioContext;
    // Preferred: ask for a 16 kHz context so the browser itself resamples the
    // mic stream with a proper filter. Firefox refuses to connect a stream to
    // a context at a different rate (throws), so fall back to the native rate
    // and our own band-limited Resampler.
    let source: MediaStreamAudioSourceNode | null = null;
    try {
      this.audioContext = new AudioCtx({ sampleRate: TARGET_RATE });
      source = this.audioContext.createMediaStreamSource(this.mediaStream);
    } catch {
      await this.audioContext?.close().catch(() => {});
      this.audioContext = null;
    }
    if (!this.audioContext || !source) {
      this.audioContext = new AudioCtx();
      source = this.audioContext.createMediaStreamSource(this.mediaStream);
    }
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();

    const nativeRate = this.audioContext.sampleRate;
    // Safari ignores the sampleRate option, so don't assume the 16 kHz request took.
    this.resampler = nativeRate === TARGET_RATE ? null : new Resampler(nativeRate, TARGET_RATE);
    // Correct the constructor's TARGET_RATE-based estimate now that the
    // AudioContext's actual native rate is known — see the frameDurationMs
    // field comment.
    this.frameDurationMs = (SCRIPT_PROCESSOR_FRAMES / nativeRate) * 1000;

    this.source = source;
    this.processor = this.audioContext.createScriptProcessor(SCRIPT_PROCESSOR_FRAMES, 1, 1);

    this.processor.onaudioprocess = (event) => {
      if (!this.isRecording) return;
      if (this.paused) { this.events.onAudioLevel?.(0); return; }
      const input = event.inputBuffer.getChannelData(0);

      const { rms, peak, gained, meanAbs } = analyzeFrame(input, this.normalizationGain);
      this.events.onAudioLevel?.(rms, peak);

      const isSilent = isVadSilent(meanAbs, this.gate.noiseFloor);
      if (isSilent) {
        this.vadSilenceMs += this.frameDurationMs;
      } else {
        this.vadSilenceMs = 0;
      }

      // Adaptive speech-presence gate (separate from the VAD cut-boundary
      // logic above — see MIN_SPEECH_RUN_MS). Analysed in short windows, not
      // per frame, so a single click can't count as a frame's worth of speech.
      const windowSamples = Math.max(1, Math.round(gained.length * GATE_WINDOW_MS / this.frameDurationMs));
      const windowMs = this.frameDurationMs * windowSamples / gained.length;
      for (const w of windowMeanAbs(gained, windowSamples)) this.gate.push(w, windowMs);

      // Band-limited downsample to 16 kHz (a no-op copy when the context already runs at 16 kHz)
      const resampled = this.resampler ? this.resampler.process(gained) : gained;
      if (this.archive) this.recordTelemetry(rms, peak, meanAbs, isSilent, gained);
      this.assembler.push(resampled);
      this.samplesPushed += resampled.length;

      const reason = decideCommit({
        useVAD: this.useVAD,
        vadSilenceMs: this.vadSilenceMs,
        vadSilenceThresholdMs: this.vadSilenceThresholdMs,
        sampleCount: this.assembler.sampleCount,
        minSamples: this.minChunkSamples(),
        maxSamples: this.maxChunkSamples(),
      });
      if (reason) {
        this.commitChunk(reason);
        this.vadSilenceMs = 0;
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    this.isRecording = true;

    if (this.archive) {
      this.sendOrQueue(JSON.stringify({
        type: 'client_info',
        nativeRate, frameDurationMs: this.frameDurationMs, ownResampler: !!this.resampler,
        useVAD: this.useVAD, vadSilenceThresholdMs: this.vadSilenceThresholdMs,
        minChunkMs: this.minChunkMs, maxChunkMs: this.maxChunkSamples() / TARGET_RATE * 1000, overlapMs: this.overlapMs,
        normalizationGain: this.normalizationGain, rawAudioCapture: this.rawAudioCapture,
        deviceLabel: this.mediaStream?.getAudioTracks()[0]?.label ?? '',
        userAgent: navigator.userAgent, startedAt: Date.now(),
      }));
    }

    this.events.onDebug?.(`Audio pipeline started — ${nativeRate}Hz → 16kHz${this.resampler ? ' (own resampler)' : ''}, gain:${this.normalizationGain}, overlap:${this.overlapMs}ms, VAD:${this.useVAD}, chunk ${this.minChunkSamples() / TARGET_RATE}-${this.maxChunkSamples() / TARGET_RATE}s`);
  }

  private minChunkSamples(): number {
    return Math.round((this.minChunkMs / 1000) * TARGET_RATE);
  }

  // The hard cap replaces the old setInterval commit timer: checking per audio
  // frame cuts at the cap exactly, whereas an interval fired on its own clock
  // regardless of when the previous chunk was committed.
  private maxChunkSamples(): number {
    const ms = this.maxChunkMsOverride ?? (this.useVAD ? this.chunkDurationMs * 1.5 : this.chunkDurationMs);
    return Math.max(this.minChunkSamples(), Math.round((ms / 1000) * TARGET_RATE));
  }

  private commitChunk(reason: 'vad' | 'cap' | 'stop'): void {
    if (this.assembler.sampleCount === 0) return;

    const ownSamples = this.assembler.sampleCount;
    const startSample = this.samplesPushed - ownSamples;
    const gateRunMs = this.gate.longestRunMs;
    const noiseFloor = this.gate.noiseFloor;

    // A chunk is discarded unless it holds a long enough voiced run (see
    // MIN_SPEECH_RUN_MS above). It's dead air, room tone, or transient
    // ticks/clicks (typing), none of which is real speech. This
    // deliberately does NOT try to be the sole defence against hallucination:
    // measurements (see CLAUDE.md / server/lib/asr-artifacts.ts) showed
    // Whisper's own no_speech_prob cannot reliably distinguish quiet real
    // speech from silence once a prompt is set, so a chunk that DOES clear
    // this gate can still come back as a hallucinated caption artifact —
    // that's caught server-side afterwards. This gate only needs to be
    // conservative in one direction: never eat real speech.
    if (!this.gate.keepChunk()) {
      if (this.archive) this.archiveDiscardedChunk(startSample, reason, gateRunMs, noiseFloor);
      this.assembler.discard();
      this.gate.resetChunk();
      this.events.onDebug?.('Chunk discarded — no sustained speech detected');
      return;
    }
    this.gate.resetChunk();

    const currentIndex = this.chunkIndex++;

    // [overlap prefix from the PREVIOUS chunk][this chunk's audio]
    const total = this.assembler.commit();

    if (this.archive) {
      this.sendOrQueue(JSON.stringify({
        type: 'chunk_meta', chunkIndex: currentIndex, startSample, samples: ownSamples,
        prefixSamples: total.length - ownSamples, cut: reason, gateRunMs, noiseFloor, sentAt: Date.now(),
      }));
    }

    const pcm16 = floatToPCM16(total);
    const wavBuf = buildWavBuffer(pcm16);

    // Binary format: [4-byte big-endian index][1-byte flags: 0x01=PCM16/WAV][WAV bytes]
    const combined = new ArrayBuffer(5 + wavBuf.byteLength);
    const view = new DataView(combined);
    view.setUint32(0, currentIndex, false); // big-endian
    view.setUint8(4, 0x01);                 // flags: isPCM16
    new Uint8Array(combined).set(new Uint8Array(wavBuf), 5);

    this.sendBinary(combined, currentIndex);
    this.events.onChunkSent?.(currentIndex);

    this.events.onDebug?.(`Chunk ${currentIndex}: ${total.length} samples (${(total.length / TARGET_RATE).toFixed(1)}s)`);
  }

  private sendBinary(buf: ArrayBuffer, _index: number): void {
    this.sendOrQueue(buf);
  }

  /** Sends now, or holds for the reconnect flush — keeps chunk_meta ordered just ahead of its audio frame. */
  private sendOrQueue(data: ArrayBuffer | string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else if (this.reconnecting) {
      this.audioQueue.push(data);
    }
  }

  /**
   * Ships a chunk the speech gate rejected, for the archive only (flag bit 0x02: the server
   * writes it to disk and never transcribes it). Its 4-byte header field carries the chunk's
   * start sample instead of a chunk index. This is how a stretch the gate wrongly ate still
   * ends up in the recording.
   */
  private archiveDiscardedChunk(startSample: number, reason: string, gateRunMs: number, noiseFloor: number): void {
    const audio = this.assembler.peek();
    this.sendOrQueue(JSON.stringify({
      type: 'chunk_meta', discarded: true, startSample, samples: audio.length, cut: reason, gateRunMs, noiseFloor, sentAt: Date.now(),
    }));
    const wavBuf = buildWavBuffer(floatToPCM16(audio));
    const frame = new ArrayBuffer(5 + wavBuf.byteLength);
    const view = new DataView(frame);
    view.setUint32(0, startSample, false);
    view.setUint8(4, 0x03); // PCM16 + archive-only
    new Uint8Array(frame).set(new Uint8Array(wavBuf), 5);
    this.sendOrQueue(frame);
  }

  /** One row per audio frame (~85-256 ms): level, noise floor, VAD/gate state. Batched ~every 2 s. */
  private recordTelemetry(rms: number, peak: number, meanAbs: number, silent: boolean, frame: Float32Array): void {
    // Zero-crossing rate: a cheap pitch/noisiness proxy (speech vowels low, hiss/fricatives high).
    let crossings = 0;
    for (let i = 1; i < frame.length; i++) if ((frame[i - 1] < 0) !== (frame[i] < 0)) crossings++;
    const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
    this.telemetryRows.push({
      t: round(this.samplesPushed / TARGET_RATE, 3),
      w: Date.now(),
      rmsDb: rms > 0 ? round(20 * Math.log10(rms), 1) : -120,
      peak: round(peak, 4),
      meanAbs: round(meanAbs, 5),
      noiseFloor: round(this.gate.noiseFloor, 5),
      silent,
      vadSilenceMs: Math.round(this.vadSilenceMs),
      gateRunMs: Math.round(this.gate.longestRunMs),
      chunkSecs: round(this.assembler.sampleCount / TARGET_RATE, 2),
      zcr: round(crossings / frame.length, 3),
    });
    if (Date.now() - this.lastTelemetryFlushAt >= 2000) this.flushTelemetry();
  }

  private startPerfMonitor(): void {
    this.perf = new PerfMonitor((rows) => {
      // Dropped while the socket is down, like telemetry: the audio frames are what must survive a reconnect.
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'perf', rows }));
    });
    this.perf.start();
  }

  private flushTelemetry(): void {
    this.lastTelemetryFlushAt = Date.now();
    if (!this.telemetryRows.length) return;
    // Dropped (not queued) while the socket is down — the audio frames are what must survive a reconnect.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'telemetry', rows: this.telemetryRows }));
    }
    this.telemetryRows = [];
  }

  // ── Runtime setters (apply without restarting) ──────────────────────────────

  setChunkDuration(ms: number): void {
    // Takes effect on the next audio frame — the cap is checked per frame, no timer to restart.
    this.chunkDurationMs = ms;
  }

  /** Min audio before a VAD cut is allowed, and an explicit hard cap. Set before start() or at any time. */
  setChunkLimits(minChunkMs: number, maxChunkMs: number | null): void {
    this.minChunkMs = Math.max(250, minChunkMs);
    this.maxChunkMsOverride = maxChunkMs;
  }

  /** Set BEFORE start(): false restores the browser's echo-cancel/noise-suppress processing. */
  setRawAudioCapture(enabled: boolean): void {
    this.rawAudioCapture = enabled;
  }

  /** Set BEFORE start(): a deviceId from enumerateDevices(); '' = system default. */
  setInputDeviceId(deviceId: string): void {
    this.inputDeviceId = deviceId;
  }

  setNormalizationGain(gain: number): void {
    this.normalizationGain = Math.max(0.1, Math.min(10, gain));
  }

  setVADThreshold(ms: number): void {
    this.vadSilenceThresholdMs = Math.max(200, Math.min(2000, ms));
    this.vadSilenceMs = 0;
  }

  setOverlapMs(ms: number): void {
    this.overlapMs = ms;
    this.assembler.resizeOverlap(Math.round(ms * TARGET_RATE / 1000));
  }

  setUseVAD(enabled: boolean): void {
    this.useVAD = enabled;
    this.vadSilenceMs = 0;
  }

  // Set BEFORE start() to take effect on the initial 'start' handshake
  // (that's how sermon mode uses it); also sendable mid-session for symmetry
  // with the other runtime setters, though no caller currently needs that.
  setOutputMode(mode: OutputMode): void {
    this.outputMode = mode;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'config', outputMode: mode }));
    }
  }

  setPreviousTranscript(text: string): void {
    this.previousTranscript = text;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'config',
        previousTranscript: text.slice(-300),
      }));
    }
  }

  /** Replaces the vocabulary for Whisper's prompt and the per-chunk correction, effective from the next chunk. */
  setGlossary(glossary: string): void {
    this.glossary = glossary;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'config', glossary }));
  }

  updateConfig(
    sourceLanguage: string,
    targetLanguage: string,
    detectSpeakers: boolean,
    translationProvider?: TranslationProvider,
    openaiApiKey?: string,
    anthropicApiKey?: string,
    glossary?: string,
    sermonContext?: string,
    ollamaBaseUrl?: string,
    ollamaModel?: string,
  ): void {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;
    if (translationProvider) this.translationProvider = translationProvider;
    if (openaiApiKey !== undefined) this.openaiApiKey = openaiApiKey;
    if (anthropicApiKey !== undefined) this.anthropicApiKey = anthropicApiKey;
    if (glossary !== undefined) this.glossary = glossary;
    if (ollamaBaseUrl !== undefined) this.ollamaBaseUrl = ollamaBaseUrl;
    if (ollamaModel !== undefined) this.ollamaModel = ollamaModel;
    if (sermonContext !== undefined) this.sermonContext = sermonContext;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'config',
        sourceLanguage,
        targetLanguage,
        detectSpeakers,
        translationProvider: this.translationProvider,
        openaiApiKey: this.openaiApiKey,
        anthropicApiKey: this.anthropicApiKey,
        ollamaBaseUrl: this.ollamaBaseUrl,
        ollamaModel: this.ollamaModel,
        glossary: this.glossary,
        sermonContext: this.sermonContext,
        previousTranscript: this.previousTranscript.slice(-300),
      }));
    }
  }

  /**
   * Stops listening without ending the session. What was said up to now is
   * committed as a final chunk (so the last words are still transcribed and
   * delivered); audio while paused is dropped, not buffered. The mic and the
   * socket stay open, so resume() is instant and needs no new permission prompt.
   * Archive `startSample`s count only recorded audio, so a paused stretch
   * leaves no gap in a session's `full.wav`.
   */
  pause(): void {
    if (!this.isRecording || this.paused) return;
    if (this.assembler.sampleCount >= 100) this.commitChunk('stop');
    this.assembler.discard(); // also drops the overlap prefix — it must not lead the first chunk after the pause
    this.gate.resetChunk();
    this.vadSilenceMs = 0;
    this.paused = true;
    this.events.onAudioLevel?.(0);
    this.events.onDebug?.('Paused');
  }

  /**
   * Moves a running recording to another microphone ('' = system default)
   * without touching the socket, the chunk numbering or the AudioContext — only
   * the source node feeding the ScriptProcessor changes. The new device is
   * opened first, so if that fails the old one keeps recording and the error
   * goes to the caller. What was heard so far is committed as its own chunk,
   * so no chunk mixes two microphones, and the noise floor starts over (a
   * different mic has a different one).
   */
  switchInputDevice(deviceId: string): Promise<{ label: string; fellBack: boolean; deviceId: string }> {
    // One at a time, in the order requested: opening a device can take seconds (Bluetooth), and
    // the switch that resolves last must not beat one that was asked for later.
    return this.runSwitch(() => this.performSwitch(deviceId));
  }

  private runSwitch = createSerialRunner();

  private async performSwitch(deviceId: string): Promise<{ label: string; fellBack: boolean; deviceId: string }> {
    if (!this.isRecording || !this.audioContext || !this.processor) throw new RecordingStoppedError('Not recording');
    const { stream, fellBack } = await this.openInput(deviceId);
    const label = stream.getAudioTracks()[0]?.label ?? '';
    // Stopped (or torn down) while the new device was opening.
    if (!this.isRecording || !this.audioContext || !this.processor) {
      stream.getTracks().forEach(t => t.stop());
      throw new RecordingStoppedError();
    }
    let source: MediaStreamAudioSourceNode;
    try {
      source = this.audioContext.createMediaStreamSource(stream);
    } catch (err) {
      stream.getTracks().forEach(t => t.stop());
      throw err;
    }
    if (this.assembler.sampleCount >= 100) this.commitChunk('stop');
    this.assembler.discard();
    this.gate = new SpeechGate();
    this.vadSilenceMs = 0;

    const oldStream = this.mediaStream;
    this.source?.disconnect();
    source.connect(this.processor);
    this.source = source;
    this.mediaStream = stream;
    // stop() does not fire the old track's 'ended' event, so the failure handler stays quiet.
    oldStream?.getTracks().forEach(t => t.stop());
    this.inputDeviceId = deviceId;

    this.events.onStreamReady?.(stream);
    this.events.onDebug?.(`Switched microphone to "${label}"${fellBack ? ' (selected device missing, system default)' : ''}`);
    if (this.archive) {
      this.sendOrQueue(JSON.stringify({ type: 'device_switch', label, fellBack, startSample: this.samplesPushed }));
    }
    return { label, fellBack, deviceId: realDeviceId(stream) };
  }

  resume(): void {
    if (!this.isRecording || !this.paused) return;
    this.paused = false;
    this.vadSilenceMs = 0;
    this.events.onDebug?.('Resumed');
  }

  async stop(): Promise<void> {
    this.intentionalClose = true;
    this.reconnecting = false;
    this.isRecording = false;
    this.paused = false;

    // Flush remaining buffered audio as the final chunk
    if (this.assembler.sampleCount >= 100) this.commitChunk('stop');
    if (this.archive) this.flushTelemetry();
    this.perf?.stop();
    this.perf = null;

    this.processor?.disconnect();
    this.source?.disconnect();
    this.processor = null;
    this.source = null;

    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }

    // Wait for the server to finish transcribing and deliver every chunk
    // still in flight (including the one just committed above) before
    // closing the socket. This used to be a fixed 100ms delay — far shorter
    // than a single transcription call — which reliably lost the speaker's
    // final sentence. The server's 'stop' handler now drains in-flight work
    // and acks with 'stop_complete' (see chunk-transcription.ts) instead of
    // aborting it; STOP_DRAIN_TIMEOUT_MS is a fallback in case that ack
    // never arrives (e.g. a wedged provider).
    if (this.ws?.readyState === WebSocket.OPEN) {
      const ws = this.ws;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS);
        this.stopCompleteResolve = () => { clearTimeout(timeout); resolve(); };
        ws.send(JSON.stringify({ type: 'stop' }));
      });
      this.stopCompleteResolve = null;
      ws.close();
    }
    this.ws = null;
    this.audioQueue = [];
    this.assembler.discard();
    this.resampler = null;
    this.gate.resetChunk();
  }
}
