export interface StreamingTranscriptionEvents {
  onReady: () => void;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onTranslation: (original: string, translated: string, isFinal: boolean) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export class StreamingTranscription {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private events: StreamingTranscriptionEvents;
  private targetLanguage: string;
  private detectSpeakers: boolean;
  private isConnected: boolean = false;

  constructor(events: StreamingTranscriptionEvents) {
    this.events = events;
    this.targetLanguage = 'nl';
    this.detectSpeakers = false;
  }

  async start(targetLanguage: string, detectSpeakers: boolean): Promise<void> {
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/transcribe`;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.ws?.send(JSON.stringify({
          type: 'start',
          targetLanguage: this.targetLanguage,
          detectSpeakers: this.detectSpeakers,
        }));
      };

      this.ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);

          switch (message.type) {
            case 'ready':
              this.isConnected = true;
              await this.startAudioCapture();
              this.events.onReady();
              resolve();
              break;

            case 'partial':
              this.events.onPartial(message.text);
              break;

            case 'final':
              this.events.onFinal(message.text);
              break;

            case 'translation':
              this.events.onTranslation(
                message.original,
                message.translated,
                message.isFinal
              );
              break;

            case 'error':
              this.events.onError(message.message);
              break;
          }
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.events.onError('Connection error');
        reject(error);
      };

      this.ws.onclose = () => {
        console.log('WebSocket closed');
        this.isConnected = false;
        this.events.onClose();
      };
    });
  }

  private async startAudioCapture(): Promise<void> {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });

      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
      });

      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);

      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (event) => {
        if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
          return;
        }

        const inputData = event.inputBuffer.getChannelData(0);

        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        this.ws.send(pcm16.buffer);
      };

      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      console.log('Audio capture started');
    } catch (error) {
      console.error('Failed to start audio capture:', error);
      throw error;
    }
  }

  updateConfig(targetLanguage: string, detectSpeakers: boolean): void {
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'config',
        targetLanguage,
        detectSpeakers,
      }));
    }
  }

  async stop(): Promise<void> {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
      this.ws.close();
    }

    this.ws = null;
    this.isConnected = false;
    console.log('Streaming transcription stopped');
  }
}
