export interface ChunkTranscriptionEvents {
  onReady: () => void;
  onRawTranscript: (text: string, chunkIndex: number) => void;
  onTranslation: (original: string, translated: string, chunkIndex: number) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export type TranslationProvider = 'openai' | 'claude' | 'none';

export class ChunkBasedTranscription {
  private ws: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunkTimer: ReturnType<typeof setTimeout> | null = null;
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
  // Resolver called from onstop when the last partial chunk has been sent,
  // so stop() can wait before closing the WebSocket.
  private lastChunkSentResolve: (() => void) | null = null;

  constructor(events: ChunkTranscriptionEvents, chunkDurationMs = 5000) {
    this.events = events;
    this.targetLanguage = 'nl';
    this.sourceLanguage = 'en';
    this.detectSpeakers = false;
    this.chunkDurationMs = chunkDurationMs;
    this.translationProvider = 'openai';
    this.openaiApiKey = '';
    this.anthropicApiKey = '';
  }

  async start(
    sourceLanguage: string,
    targetLanguage: string,
    detectSpeakers: boolean,
    translationProvider: TranslationProvider = 'openai',
    openaiApiKey = '',
    anthropicApiKey = '',
  ): Promise<void> {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;
    this.chunkIndex = 0;
    this.translationProvider = translationProvider;
    this.openaiApiKey = openaiApiKey;
    this.anthropicApiKey = anthropicApiKey;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/transcribe`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.ws!.send(JSON.stringify({
          type: 'start',
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          detectSpeakers: this.detectSpeakers,
          translationProvider: this.translationProvider,
          openaiApiKey: this.openaiApiKey,
          anthropicApiKey: this.anthropicApiKey,
        }));
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string);

          switch (message.type) {
            case 'ready':
              // Propagate startAudioCapture errors through reject so the
              // caller's await start() throws instead of hanging forever.
              this.startAudioCapture()
                .then(() => {
                  this.events.onReady();
                  resolve();
                })
                .catch(reject);
              break;

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
          }
        } catch {
          // Ignore unparseable messages
        }
      };

      this.ws.onerror = () => {
        this.events.onError('WebSocket connection error');
        reject(new Error('WebSocket connection error'));
      };

      this.ws.onclose = () => {
        this.isRecording = false;
        this.events.onClose();
      };
    });
  }

  private async startAudioCapture(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000,
      },
    });
    this.isRecording = true;
    this.startNextChunk();
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

  // Records one chunk and starts the next one immediately when this chunk ends.
  // The current chunk's audio is sent asynchronously so recording never pauses.
  // When isRecording is false (stop() called) this is the final chunk:
  // lastChunkSentResolve is called after the blob is sent so stop() can
  // safely close the WebSocket only after the last audio has been transmitted.
  private startNextChunk(): void {
    if (!this.isRecording || !this.mediaStream) return;

    const mimeType = this.getSupportedMimeType();
    const recordedParts: Blob[] = [];
    const currentIndex = this.chunkIndex++;

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        this.mediaStream,
        mimeType ? { mimeType } : undefined,
      );
    } catch {
      recorder = new MediaRecorder(this.mediaStream);
    }
    this.mediaRecorder = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedParts.push(e.data);
    };

    recorder.onstop = () => {
      const isLastChunk = !this.isRecording;

      // Start next chunk IMMEDIATELY to keep recording continuous
      if (!isLastChunk) this.startNextChunk();

      if (recordedParts.length === 0) {
        if (isLastChunk) {
          this.lastChunkSentResolve?.();
          this.lastChunkSentResolve = null;
        }
        return;
      }

      const blob = new Blob(recordedParts, { type: mimeType || 'audio/webm' });
      const sendPromise = this.sendChunk(blob, currentIndex);

      if (isLastChunk) {
        sendPromise.finally(() => {
          this.lastChunkSentResolve?.();
          this.lastChunkSentResolve = null;
        });
      }
    };

    recorder.start();

    // Clear any stale timer before arming a new one
    if (this.chunkTimer) clearTimeout(this.chunkTimer);
    this.chunkTimer = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, this.chunkDurationMs);
  }

  // Binary protocol: [4-byte big-endian chunk index][audio data]
  private async sendChunk(blob: Blob, index: number): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const audioBuffer = await blob.arrayBuffer();
    const combined = new ArrayBuffer(4 + audioBuffer.byteLength);
    const view = new DataView(combined);
    view.setUint32(0, index, false); // big-endian, matches server readUInt32BE
    new Uint8Array(combined).set(new Uint8Array(audioBuffer), 4);

    this.ws.send(combined);
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

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'config',
        sourceLanguage,
        targetLanguage,
        detectSpeakers,
        translationProvider: this.translationProvider,
        openaiApiKey: this.openaiApiKey,
        anthropicApiKey: this.anthropicApiKey,
      }));
    }
  }

  async stop(): Promise<void> {
    this.isRecording = false;

    if (this.chunkTimer) {
      clearTimeout(this.chunkTimer);
      this.chunkTimer = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    // Wait for the final partial chunk to be sent before closing the WebSocket.
    // lastChunkSentResolve is set up here and called from onstop after the
    // blob is transmitted, preventing lost audio at session end.
    let waitForLastChunk = Promise.resolve();
    if (this.mediaRecorder?.state === 'recording') {
      waitForLastChunk = new Promise<void>((resolve) => {
        this.lastChunkSentResolve = resolve;
      });
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;

    await waitForLastChunk;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
      this.ws.close();
    }
    this.ws = null;
  }
}
