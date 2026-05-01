export interface ChunkTranscriptionEvents {
  onReady: () => void;
  onRawTranscript: (text: string, chunkIndex: number) => void;
  onTranslation: (original: string, translated: string, chunkIndex: number) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onStreamReady?: (stream: MediaStream) => void;
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
    this.intentionalClose = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.audioQueue = [];

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/transcribe`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'start',
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          detectSpeakers: this.detectSpeakers,
          translationProvider: this.translationProvider,
          openaiApiKey: this.openaiApiKey,
          anthropicApiKey: this.anthropicApiKey,
        }));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string);
          if (message.type === 'ready') {
            this.ws = ws;
            this.attachWsHandlers(ws);
            this.startAudioCapture()
              .then(() => {
                this.events.onReady();
                resolve();
              })
              .catch(reject);
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

  // Attach steady-state message/error/close handlers to an open WS.
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
        }
      } catch (e) {
        console.warn('Unparseable WebSocket message:', e);
      }
    };

    ws.onerror = () => {
      this.events.onError('WebSocket connection error');
    };

    ws.onclose = () => {
      if (this.intentionalClose) {
        this.isRecording = false;
        this.events.onClose();
      } else if (this.isRecording) {
        // Unexpected disconnect — buffer subsequent audio and reconnect
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
    const wsUrl = `${protocol}//${window.location.host}/ws/transcribe`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'start',
        sourceLanguage: this.sourceLanguage,
        targetLanguage: this.targetLanguage,
        detectSpeakers: this.detectSpeakers,
        translationProvider: this.translationProvider,
        openaiApiKey: this.openaiApiKey,
        anthropicApiKey: this.anthropicApiKey,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string);
        if (message.type === 'ready') {
          this.ws = ws;
          this.reconnecting = false;
          this.reconnectAttempts = 0;
          this.attachWsHandlers(ws);
          // Replay buffered audio chunks in recording order
          const queued = this.audioQueue.splice(0);
          for (const combined of queued) {
            ws.send(combined);
          }
        }
      } catch (e) {
        console.warn('Unparseable WebSocket message during reconnect:', e);
      }
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
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000,
      },
    });
    this.events.onStreamReady?.(this.mediaStream);
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
  // During reconnect, buffers the frame for replay after reconnection.
  private async sendChunk(blob: Blob, index: number): Promise<void> {
    const audioBuffer = await blob.arrayBuffer();
    const combined = new ArrayBuffer(4 + audioBuffer.byteLength);
    const view = new DataView(combined);
    view.setUint32(0, index, false); // big-endian, matches server readUInt32BE
    new Uint8Array(combined).set(new Uint8Array(audioBuffer), 4);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(combined);
    } else if (this.reconnecting) {
      this.audioQueue.push(combined);
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
    this.intentionalClose = true;
    this.reconnecting = false;
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
    // We create the promise whenever mediaRecorder exists, not only when it is
    // in 'recording' state: the chunk timer may have fired and set the state to
    // 'inactive' while onstop is still queued in the microtask queue, so we
    // must be ready to receive that onstop callback regardless of current state.
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

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
      this.ws.close();
    }
    this.ws = null;
    this.audioQueue = [];
  }
}
