export interface ChunkTranscriptionEvents {
  onReady: () => void;
  onRawTranscript: (text: string, chunkIndex: number) => void;
  onTranslation: (original: string, translated: string, chunkIndex: number) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onStreamReady?: (stream: MediaStream) => void;
  onDebug?: (message: string) => void;
  onAudioLevel?: (rms: number) => void;
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

export class ChunkBasedTranscription {
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
  private audioQueue: ArrayBuffer[] = [];

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

  async start(
    sourceLanguage: string,
    targetLanguage: string,
    detectSpeakers: boolean,
    translationProvider: TranslationProvider = 'openai',
    openaiApiKey = '',
    anthropicApiKey = '',
    glossary = '',
    sermonContext = '',
    debugMode = false,
    normalizationGain = 1.0,
    chunkOverlapMs = 500,
    useVADChunking = false,
    vadSilenceThresholdMs = 800,
    engine: TranscriptionEngine = 'openai',
    ollamaBaseUrl?: string,
    ollamaModel?: string,
  ): Promise<void> {
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
            this.events.onTranslation(message.original, message.translated, message.chunkIndex);
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

  private async startAudioCapture(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: this.rawAudioCapture
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
        : { echoCancellation: true, noiseSuppression: true },
    });
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
      const input = event.inputBuffer.getChannelData(0);

      // RMS for audio level callback
      let sumSq = 0;
      for (let i = 0; i < input.length; i++) sumSq += input[i] * input[i];
      const rms = Math.sqrt(sumSq / input.length);
      this.events.onAudioLevel?.(rms);

      // Apply normalization gain (clamp to prevent clipping)
      const gained = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        gained[i] = Math.max(-1, Math.min(1, input[i] * this.normalizationGain));
      }

      // Mean absolute value for silence gate / VAD
      let sumAbs = 0;
      for (let i = 0; i < gained.length; i++) sumAbs += Math.abs(gained[i]);
      const meanAbs = sumAbs / gained.length;
      // VAD "silence" for chunk cutting. Relative to the tracked noise floor:
      // with the browser's noise suppression off, a room's ambient level can
      // sit above any fixed threshold, in which case pauses would never be
      // seen and every chunk would run to the hard cap, cutting mid-word.
      const isSilent = meanAbs < Math.max(0.005, this.gate.noiseFloor * VAD_SILENCE_FLOOR_RATIO);

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
      this.assembler.push(this.resampler ? this.resampler.process(gained) : gained);

      // VAD-triggered commit: a pause, once enough audio has accumulated.
      if (
        this.useVAD &&
        this.vadSilenceMs >= this.vadSilenceThresholdMs &&
        this.assembler.sampleCount >= this.minChunkSamples()
      ) {
        this.commitChunk();
        this.vadSilenceMs = 0;
      } else if (this.assembler.sampleCount >= this.maxChunkSamples()) {
        // Hard cap (also the only trigger when VAD is off, i.e. fixed-length chunks).
        this.commitChunk();
        this.vadSilenceMs = 0;
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    this.isRecording = true;

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

  private commitChunk(): void {
    if (this.assembler.sampleCount === 0) return;

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
      this.assembler.discard();
      this.gate.resetChunk();
      this.events.onDebug?.('Chunk discarded — no sustained speech detected');
      return;
    }
    this.gate.resetChunk();

    const currentIndex = this.chunkIndex++;

    // [overlap prefix from the PREVIOUS chunk][this chunk's audio]
    const total = this.assembler.commit();

    const pcm16 = floatToPCM16(total);
    const wavBuf = buildWavBuffer(pcm16);

    // Binary format: [4-byte big-endian index][1-byte flags: 0x01=PCM16/WAV][WAV bytes]
    const combined = new ArrayBuffer(5 + wavBuf.byteLength);
    const view = new DataView(combined);
    view.setUint32(0, currentIndex, false); // big-endian
    view.setUint8(4, 0x01);                 // flags: isPCM16
    new Uint8Array(combined).set(new Uint8Array(wavBuf), 5);

    this.sendBinary(combined, currentIndex);

    this.events.onDebug?.(`Chunk ${currentIndex}: ${total.length} samples (${(total.length / TARGET_RATE).toFixed(1)}s)`);
  }

  private sendBinary(buf: ArrayBuffer, _index: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
    } else if (this.reconnecting) {
      this.audioQueue.push(buf);
    }
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

  async stop(): Promise<void> {
    this.intentionalClose = true;
    this.reconnecting = false;
    this.isRecording = false;

    // Flush remaining buffered audio as the final chunk
    if (this.assembler.sampleCount >= 100) this.commitChunk();

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
