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

export type TranslationProvider = 'openai' | 'claude' | 'none';

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
const MIN_CHUNK_SAMPLES = TARGET_RATE; // 1 second minimum before committing

export class ChunkBasedTranscription {
  private ws: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunkTimer: ReturnType<typeof setInterval> | null = null;

  private events: ChunkTranscriptionEvents;
  private targetLanguage: string;
  private sourceLanguage: string;
  private detectSpeakers: boolean;
  private chunkDurationMs: number;
  private chunkIndex = 0;
  private isRecording = false;
  private translationProvider: TranslationProvider;
  private openaiApiKey: string;
  private anthropicApiKey: string;
  private glossary: string;
  private sermonContext: string;
  private debugMode: boolean;
  private previousTranscript: string = '';

  // Audio pipeline config (runtime-adjustable)
  private normalizationGain: number = 1.0;
  private useVAD: boolean = false;
  private vadSilenceThresholdMs: number = 800;
  private overlapMs: number = 500;

  // VAD state
  private vadSilenceMs: number = 0;
  private readonly frameDurationMs: number;

  // Chunk accumulation (16 kHz float32 samples)
  private chunkSamples: Float32Array[] = [];
  private chunkSampleCount: number = 0;
  private overlapBuffer: OverlapBuffer;

  // Reconnect state
  private intentionalClose = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private audioQueue: ArrayBuffer[] = [];

  constructor(events: ChunkTranscriptionEvents, chunkDurationMs = 5000) {
    this.events = events;
    this.targetLanguage = 'nl';
    this.sourceLanguage = 'en';
    this.detectSpeakers = false;
    this.chunkDurationMs = chunkDurationMs;
    this.translationProvider = 'openai';
    this.openaiApiKey = '';
    this.anthropicApiKey = '';
    this.glossary = '';
    this.sermonContext = '';
    this.debugMode = false;
    this.frameDurationMs = (SCRIPT_PROCESSOR_FRAMES / TARGET_RATE) * 1000;
    this.overlapBuffer = new OverlapBuffer(Math.round(this.overlapMs * TARGET_RATE / 1000));
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
  ): Promise<void> {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;
    this.chunkIndex = 0;
    this.translationProvider = translationProvider;
    this.openaiApiKey = openaiApiKey;
    this.anthropicApiKey = anthropicApiKey;
    this.glossary = glossary;
    this.sermonContext = sermonContext;
    this.debugMode = debugMode;
    this.normalizationGain = normalizationGain;
    this.overlapMs = chunkOverlapMs;
    this.useVAD = useVADChunking;
    this.vadSilenceThresholdMs = vadSilenceThresholdMs;
    this.overlapBuffer.resize(Math.round(this.overlapMs * TARGET_RATE / 1000));
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
      translationProvider: this.translationProvider,
      openaiApiKey: this.openaiApiKey,
      anthropicApiKey: this.anthropicApiKey,
      glossary: this.glossary,
      sermonContext: this.sermonContext,
      debugMode: this.debugMode,
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
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.events.onStreamReady?.(this.mediaStream);
    this.events.onDebug?.('Microphone acquired — starting PCM pipeline');

    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext as typeof AudioContext;
    this.audioContext = new AudioCtx();
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();

    const nativeRate = this.audioContext.sampleRate;
    const ratio = nativeRate / TARGET_RATE;
    this.frameDurationMs as number; // already set in constructor

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
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
      const isSilent = meanAbs < 0.005;

      if (isSilent) {
        this.vadSilenceMs += this.frameDurationMs;
      } else {
        this.vadSilenceMs = 0;
      }

      // Downsample to 16 kHz (nearest-neighbour)
      const outLen = Math.floor(gained.length / ratio);
      const resampled = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) resampled[i] = gained[Math.floor(i * ratio)];

      this.overlapBuffer.push(resampled);
      this.chunkSamples.push(resampled);
      this.chunkSampleCount += outLen;

      // VAD-triggered commit
      if (
        this.useVAD &&
        this.vadSilenceMs >= this.vadSilenceThresholdMs &&
        this.chunkSampleCount >= MIN_CHUNK_SAMPLES
      ) {
        this.commitChunk();
        this.vadSilenceMs = 0;
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    this.isRecording = true;

    // Fixed-interval commit timer (always running as safety cap)
    const maxMs = this.useVAD ? this.chunkDurationMs * 1.5 : this.chunkDurationMs;
    this.chunkTimer = setInterval(() => {
      if (this.chunkSampleCount >= MIN_CHUNK_SAMPLES) this.commitChunk();
    }, maxMs);

    this.events.onDebug?.(`Audio pipeline started — ${nativeRate}Hz → 16kHz, gain:${this.normalizationGain}, overlap:${this.overlapMs}ms, VAD:${this.useVAD}`);
  }

  private commitChunk(): void {
    if (this.chunkSampleCount === 0) return;

    const currentIndex = this.chunkIndex++;

    // Combine overlap prefix + accumulated chunk samples
    const overlapSamples = this.overlapBuffer.snapshot();
    const total = new Float32Array(overlapSamples.length + this.chunkSampleCount);
    total.set(overlapSamples);
    let offset = overlapSamples.length;
    for (const seg of this.chunkSamples) {
      total.set(seg, offset);
      offset += seg.length;
    }

    // Reset accumulation
    this.chunkSamples = [];
    this.chunkSampleCount = 0;

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
    this.chunkDurationMs = ms;
    // Restart the interval timer at the new duration
    if (this.chunkTimer !== null) {
      clearInterval(this.chunkTimer);
      const maxMs = this.useVAD ? ms * 1.5 : ms;
      this.chunkTimer = setInterval(() => {
        if (this.chunkSampleCount >= MIN_CHUNK_SAMPLES) this.commitChunk();
      }, maxMs);
    }
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
    this.overlapBuffer.resize(Math.round(ms * TARGET_RATE / 1000));
  }

  setUseVAD(enabled: boolean): void {
    this.useVAD = enabled;
    this.vadSilenceMs = 0;
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
  ): void {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;
    if (translationProvider) this.translationProvider = translationProvider;
    if (openaiApiKey !== undefined) this.openaiApiKey = openaiApiKey;
    if (anthropicApiKey !== undefined) this.anthropicApiKey = anthropicApiKey;
    if (glossary !== undefined) this.glossary = glossary;
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

    if (this.chunkTimer !== null) {
      clearInterval(this.chunkTimer);
      this.chunkTimer = null;
    }

    // Flush remaining buffered audio as the final chunk
    if (this.chunkSampleCount >= 100) this.commitChunk();

    // Small delay to let the final send flush
    await new Promise<void>(r => setTimeout(r, 100));

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

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
      this.ws.close();
    }
    this.ws = null;
    this.audioQueue = [];
    this.chunkSamples = [];
    this.chunkSampleCount = 0;
  }
}
