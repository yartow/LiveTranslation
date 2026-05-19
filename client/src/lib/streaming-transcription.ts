import type { ChunkTranscriptionEvents, TranslationProvider } from './chunk-based-transcription';

export class StreamingTranscription {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private events: ChunkTranscriptionEvents;
  private sourceLanguage: string = 'en';
  private targetLanguage: string = 'nl';
  private detectSpeakers: boolean = false;
  private isConnected: boolean = false;
  private debugMode: boolean = false;
  private normalizationGain: number = 1.0;
  private assemblyEndOfTurnThreshold: number = 0.7;
  private assemblyTurnSilenceMs: number = 700;

  constructor(events: ChunkTranscriptionEvents) {
    this.events = events;
  }

  setNormalizationGain(gain: number): void {
    this.normalizationGain = Math.max(0.1, Math.min(10, gain));
  }

  async start(
    sourceLanguage: string,
    targetLanguage: string,
    detectSpeakers: boolean,
    _translationProvider: TranslationProvider = 'openai',
    _openaiApiKey = '',
    _anthropicApiKey = '',
    _glossary = '',
    _sermonContext = '',
    debugMode = false,
    normalizationGain = 1.0,
    assemblyEndOfTurnThreshold = 0.7,
    assemblyTurnSilenceMs = 700,
  ): Promise<void> {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;
    this.debugMode = debugMode;
    this.normalizationGain = normalizationGain;
    this.assemblyEndOfTurnThreshold = assemblyEndOfTurnThreshold;
    this.assemblyTurnSilenceMs = assemblyTurnSilenceMs;

    // ── Step 1: request mic FIRST ────────────────────────────────────────────
    // Safari iOS silently denies getUserMedia if it is called after an async
    // gap (e.g. a WebSocket round-trip). The permission prompt must be
    // triggered synchronously from the user-gesture stack frame.
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          // Do NOT specify sampleRate here — Safari ignores it and some
          // browsers reject the constraint outright.
        },
      });
    } catch (err) {
      const e = err as DOMException;
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        throw new Error(
          'Microphone access denied. ' +
          'On iOS go to Settings → Safari → Microphone and allow access, then try again.',
        );
      }
      throw new Error(`Could not access microphone: ${e.message || e.name}`);
    }

    this.events.onStreamReady?.(this.mediaStream);
    this.events.onDebug?.('Microphone acquired — connecting to transcription server…');

    // ── Step 2: open WebSocket ────────────────────────────────────────────────
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/transcribe`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => {
        this.events.onDebug?.('WebSocket open — starting AssemblyAI session…');
        ws.send(JSON.stringify({
          type: 'start',
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          detectSpeakers: this.detectSpeakers,
          debugMode: this.debugMode,
          assemblyEndOfTurnThreshold: this.assemblyEndOfTurnThreshold,
          assemblyTurnSilenceMs: this.assemblyTurnSilenceMs,
        }));
      };

      ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data as string);

          switch (message.type) {
            case 'ready':
              this.isConnected = true;
              this.events.onDebug?.('Server ready — starting audio pipeline…');
              try {
                await this.startAudioProcessing();
                this.events.onReady();
                resolve();
              } catch (err) {
                this.stopMediaStream();
                reject(err);
              }
              break;

            case 'partial':
              if (message.text) {
                this.events.onRawTranscript(message.text, -1);
              }
              break;

            case 'final':
              if (message.text) {
                this.events.onRawTranscript(message.text, -1);
              }
              break;

            case 'translation':
              this.events.onTranslation(message.original, message.translated, -1);
              break;

            case 'error':
              this.events.onError(message.message ?? 'Transcription error');
              break;

            case 'debug':
              this.events.onDebug?.(message.message as string);
              break;
          }
        } catch {
          // ignore unparseable frames (binary pings, etc.)
        }
      };

      ws.onerror = () => {
        this.stopMediaStream();
        this.events.onError('Connection error — please check your internet connection.');
        reject(new Error('WebSocket connection error'));
      };

      ws.onclose = () => {
        this.isConnected = false;
        this.events.onClose();
      };
    });
  }

  private async startAudioProcessing(): Promise<void> {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext as typeof AudioContext;
    this.audioContext = new AudioCtx();
    this.events.onDebug?.(`AudioContext created — sample rate: ${this.audioContext.sampleRate} Hz, state: ${this.audioContext.state}`);

    if (this.audioContext.state === 'suspended') {
      this.events.onDebug?.('AudioContext suspended — resuming…');
      await this.audioContext.resume();
      this.events.onDebug?.(`AudioContext resumed — state: ${this.audioContext.state}`);
    }

    const nativeRate = this.audioContext.sampleRate;
    const targetRate = 16_000;
    const ratio = nativeRate / targetRate;

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream!);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    let framesSent = 0;
    let framesSkipped = 0;
    let debugInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
      if (!this.isConnected) {
        if (debugInterval) { clearInterval(debugInterval); debugInterval = null; }
        return;
      }
      this.events.onDebug?.(`Audio: ${framesSent} frames sent, ${framesSkipped} silent frames skipped in last 5s`);
      framesSent = 0;
      framesSkipped = 0;
    }, 5000);

    this.processor.onaudioprocess = (event) => {
      if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const input = event.inputBuffer.getChannelData(0);

      // RMS for VU meter
      let rmsSum = 0;
      for (let i = 0; i < input.length; i++) rmsSum += input[i] * input[i];
      const rms = Math.sqrt(rmsSum / input.length);
      this.events.onAudioLevel?.(rms);

      // Silence gate — skip frames that are just background noise
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += Math.abs(input[i]);
      if (sum / input.length < 0.01) { framesSkipped++; return; }

      // Downsample to 16 kHz via nearest-neighbour
      const outLen = Math.floor(input.length / ratio);
      const resampled = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        resampled[i] = input[Math.floor(i * ratio)];
      }

      // Apply normalization gain
      const gain = this.normalizationGain;
      if (gain !== 1.0) {
        for (let i = 0; i < resampled.length; i++) {
          resampled[i] = Math.max(-1, Math.min(1, resampled[i] * gain));
        }
      }

      // Convert float32 → PCM16
      const pcm16 = new Int16Array(resampled.length);
      for (let i = 0; i < resampled.length; i++) {
        const s = Math.max(-1, Math.min(1, resampled[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      this.ws!.send(pcm16.buffer);
      framesSent++;
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    this.events.onDebug?.('Audio pipeline connected — sending PCM16 to server');
  }

  private stopMediaStream(): void {
    this.mediaStream?.getTracks().forEach(t => t.stop());
    this.mediaStream = null;
  }

  updateConfig(
    _sourceLanguage: string,
    targetLanguage: string,
    detectSpeakers: boolean,
    _translationProvider?: TranslationProvider,
    _openaiApiKey?: string,
    _anthropicApiKey?: string,
    _glossary?: string,
    _sermonContext?: string,
  ): void {
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'config',
        targetLanguage,
        detectSpeakers,
      }));
    }
  }

  async stop(): Promise<void> {
    this.isConnected = false;

    this.processor?.disconnect();
    this.processor = null;

    this.source?.disconnect();
    this.source = null;

    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.stopMediaStream();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
      this.ws.close();
    }
    this.ws = null;
  }
}
