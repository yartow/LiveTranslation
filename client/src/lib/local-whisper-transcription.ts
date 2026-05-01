import type { ChunkTranscriptionEvents, TranslationProvider } from './chunk-based-transcription';
import type { LocalWhisperModel } from '@/hooks/useSettings';

export type { LocalWhisperModel };

export interface LocalWhisperEvents extends ChunkTranscriptionEvents {
  onModelProgress?: (loaded: number, total: number, name: string) => void;
}

export class LocalWhisperTranscription {
  private worker: Worker | null = null;
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunkTimer: ReturnType<typeof setTimeout> | null = null;
  private events: LocalWhisperEvents;
  private chunkIndex = 0;
  private isRecording = false;
  private targetLanguage = 'nl';
  private sourceLanguage = 'en';
  private detectSpeakers = false;
  private chunkDurationMs: number;
  private modelSize: LocalWhisperModel = 'tiny';
  private translationProvider: TranslationProvider = 'none';
  private openaiApiKey = '';
  private anthropicApiKey = '';
  private lastChunkSentResolve: (() => void) | null = null;

  constructor(events: LocalWhisperEvents, chunkDurationMs = 5000) {
    this.events = events;
    this.chunkDurationMs = chunkDurationMs;
  }

  async start(
    sourceLanguage: string,
    targetLanguage: string,
    detectSpeakers: boolean,
    translationProvider: TranslationProvider = 'none',
    openaiApiKey = '',
    anthropicApiKey = '',
    modelSize: LocalWhisperModel = 'tiny',
  ): Promise<void> {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;
    this.translationProvider = translationProvider;
    this.openaiApiKey = openaiApiKey;
    this.anthropicApiKey = anthropicApiKey;
    this.modelSize = modelSize;
    this.chunkIndex = 0;

    await this.loadWorker(modelSize);
    await this.startAudioCapture();
    this.events.onReady();
  }

  private loadWorker(modelSize: LocalWhisperModel): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL('./local-whisper-worker.ts', import.meta.url),
        { type: 'module' },
      );
      this.worker = worker;

      worker.onmessage = (e: MessageEvent) => {
        const { type } = e.data as { type: string };
        if (type === 'ready') {
          // Detach the bootstrap handler — runtime transcription results
          // are dispatched via handleWorkerMessage (set in startAudioCapture)
          resolve();
        } else if (type === 'progress') {
          const { loaded, total, name } = e.data as { loaded: number; total: number; name: string };
          this.events.onModelProgress?.(loaded ?? 0, total ?? 0, name ?? '');
        } else if (type === 'error') {
          reject(new Error(e.data.message));
        }
      };

      worker.onerror = (err) => reject(err);
      worker.postMessage({ type: 'load', modelSize });
    });
  }

  private async startAudioCapture(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
    });
    this.events.onStreamReady?.(this.mediaStream);

    if (this.worker) {
      this.worker.onmessage = (e: MessageEvent) => this.handleWorkerMessage(e);
    }

    this.isRecording = true;
    this.startNextChunk();
  }

  private handleWorkerMessage(e: MessageEvent): void {
    const { type } = e.data as { type: string };
    if (type === 'result') {
      const { text, chunkIndex } = e.data as { text: string; chunkIndex: number };
      if (!text) return;
      this.events.onRawTranscript(text, chunkIndex);
      this.translateText(text, chunkIndex);
    } else if (type === 'error') {
      this.events.onError(e.data.message ?? 'Local Whisper error');
    }
  }

  private getSupportedMimeType(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
    ];
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  private startNextChunk(): void {
    if (!this.isRecording || !this.mediaStream) return;

    const mimeType = this.getSupportedMimeType();
    const parts: Blob[] = [];
    const currentIndex = this.chunkIndex++;

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.mediaStream, mimeType ? { mimeType } : undefined);
    } catch {
      recorder = new MediaRecorder(this.mediaStream);
    }
    this.mediaRecorder = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) parts.push(e.data);
    };

    recorder.onstop = () => {
      const isLastChunk = !this.isRecording;
      if (!isLastChunk) this.startNextChunk();

      if (parts.length === 0) {
        if (isLastChunk) { this.lastChunkSentResolve?.(); this.lastChunkSentResolve = null; }
        return;
      }

      const blob = new Blob(parts, { type: mimeType || 'audio/webm' });
      const sendPromise = this.sendChunk(blob, currentIndex);

      if (isLastChunk) {
        sendPromise.finally(() => { this.lastChunkSentResolve?.(); this.lastChunkSentResolve = null; });
      }
    };

    recorder.start();

    if (this.chunkTimer) clearTimeout(this.chunkTimer);
    this.chunkTimer = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, this.chunkDurationMs);
  }

  private async sendChunk(blob: Blob, index: number): Promise<void> {
    if (!this.worker) return;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      const float32 = decoded.getChannelData(0);
      audioCtx.close();
      this.worker.postMessage(
        { type: 'transcribe', audio: float32, language: this.sourceLanguage, chunkIndex: index },
        [float32.buffer],
      );
    } catch (err) {
      console.warn('Local Whisper chunk decode error:', err);
    }
  }

  private async translateText(text: string, chunkIndex: number): Promise<void> {
    if (this.translationProvider === 'none') {
      this.events.onTranslation(text, '', chunkIndex);
      return;
    }

    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          targetLanguage: this.targetLanguage,
          detectSpeakers: this.detectSpeakers,
          translationProvider: this.translationProvider,
          openaiApiKey: this.openaiApiKey,
          anthropicApiKey: this.anthropicApiKey,
        }),
      });

      if (!response.ok) {
        this.events.onError('Translation request failed');
        this.events.onTranslation(text, '', chunkIndex);
        return;
      }

      const data = await response.json();
      this.events.onTranslation(data.correctedText || text, data.translatedText || '', chunkIndex);
    } catch {
      this.events.onError('Translation failed — check your API key in Settings.');
      this.events.onTranslation(text, '', chunkIndex);
    }
  }

  updateConfig(
    sourceLanguage: string,
    targetLanguage: string,
    detectSpeakers: boolean,
    translationProvider?: TranslationProvider,
    openaiApiKey?: string,
    anthropicApiKey?: string,
  ): void {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;
    if (translationProvider) this.translationProvider = translationProvider;
    if (openaiApiKey !== undefined) this.openaiApiKey = openaiApiKey;
    if (anthropicApiKey !== undefined) this.anthropicApiKey = anthropicApiKey;
  }

  async stop(): Promise<void> {
    this.isRecording = false;

    if (this.chunkTimer) {
      clearTimeout(this.chunkTimer);
      this.chunkTimer = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    let waitForLastChunk = Promise.resolve();
    if (this.mediaRecorder) {
      waitForLastChunk = new Promise<void>((resolve) => {
        this.lastChunkSentResolve = resolve;
      });
      if (this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.stop();
      }
    }
    this.mediaRecorder = null;

    await waitForLastChunk;

    this.worker?.terminate();
    this.worker = null;
    this.events.onClose();
  }
}
