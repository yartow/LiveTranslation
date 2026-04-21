export interface ChunkTranscriptionEvents {
  onReady: () => void;
  // Raw Whisper output before GPT correction — used as a live preview
  onRawTranscript: (text: string, chunkIndex: number) => void;
  // Final corrected + translated result delivered in recording order
  onTranslation: (original: string, translated: string, chunkIndex: number) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

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

  constructor(events: ChunkTranscriptionEvents, chunkDurationMs = 5000) {
    this.events = events;
    this.targetLanguage = 'nl';
    this.sourceLanguage = 'en';
    this.detectSpeakers = false;
    this.chunkDurationMs = chunkDurationMs;
  }

  async start(
    sourceLanguage: string,
    targetLanguage: string,
    detectSpeakers: boolean,
  ): Promise<void> {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;
    this.chunkIndex = 0;

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
        }));
      };

      this.ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data as string);

          switch (message.type) {
            case 'ready':
              await this.startAudioCapture();
              this.events.onReady();
              resolve();
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

  // Records one chunk of audio, then immediately starts the next chunk so
  // recording is continuous. The completed chunk blob is sent to the server
  // asynchronously while the next chunk is already being recorded.
  private startNextChunk(): void {
    if (!this.isRecording || !this.mediaStream) return;

    const mimeType = this.getSupportedMimeType();
    const recordedParts: Blob[] = [];
    const currentIndex = this.chunkIndex++;

    try {
      this.mediaRecorder = new MediaRecorder(
        this.mediaStream,
        mimeType ? { mimeType } : undefined,
      );
    } catch {
      this.mediaRecorder = new MediaRecorder(this.mediaStream);
    }

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedParts.push(e.data);
    };

    this.mediaRecorder.onstop = () => {
      // Start the next chunk IMMEDIATELY so there is no gap in recording
      if (this.isRecording) this.startNextChunk();

      if (recordedParts.length === 0) return;
      const blob = new Blob(recordedParts, {
        type: this.mediaRecorder?.mimeType || 'audio/webm',
      });
      // Send asynchronously — does not block the next chunk
      this.sendChunk(blob, currentIndex);
    };

    this.mediaRecorder.start();

    this.chunkTimer = setTimeout(() => {
      if (this.mediaRecorder?.state === 'recording') {
        this.mediaRecorder.stop();
      }
    }, this.chunkDurationMs);
  }

  // Binary protocol: [4-byte big-endian chunk index][audio data]
  private async sendChunk(blob: Blob, index: number): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const audioBuffer = await blob.arrayBuffer();
    const combined = new ArrayBuffer(4 + audioBuffer.byteLength);
    const view = new DataView(combined);
    view.setUint32(0, index, false); // big-endian
    new Uint8Array(combined).set(new Uint8Array(audioBuffer), 4);

    this.ws.send(combined);
  }

  updateConfig(sourceLanguage: string, targetLanguage: string, detectSpeakers: boolean): void {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'config',
        sourceLanguage,
        targetLanguage,
        detectSpeakers,
      }));
    }
  }

  async stop(): Promise<void> {
    this.isRecording = false;

    if (this.chunkTimer) {
      clearTimeout(this.chunkTimer);
      this.chunkTimer = null;
    }

    if (this.mediaRecorder?.state === 'recording') {
      // Let the final partial chunk be sent before closing
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
      this.ws.close();
    }
    this.ws = null;
  }
}
