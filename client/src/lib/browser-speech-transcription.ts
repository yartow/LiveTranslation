import type { ChunkTranscriptionEvents, TranslationProvider } from './chunk-based-transcription';

export class BrowserSpeechTranscription {
  private recognition: any = null;
  private events: ChunkTranscriptionEvents;
  private targetLanguage = 'nl';
  private sourceLanguage = 'en';
  private detectSpeakers = false;
  private translationProvider: TranslationProvider = 'none';
  private openaiApiKey = '';
  private anthropicApiKey = '';
  private glossary = '';
  private sermonContext = '';
  private chunkIndex = 0;

  constructor(events: ChunkTranscriptionEvents) {
    this.events = events;
  }

  async start(
    sourceLanguage: string,
    targetLanguage: string,
    detectSpeakers: boolean,
    translationProvider: TranslationProvider = 'none',
    openaiApiKey = '',
    anthropicApiKey = '',
    glossary = '',
    sermonContext = '',
  ): Promise<void> {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;
    this.translationProvider = translationProvider;
    this.openaiApiKey = openaiApiKey;
    this.anthropicApiKey = anthropicApiKey;
    this.glossary = glossary;
    this.sermonContext = sermonContext;
    this.chunkIndex = 0;

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      throw new Error(
        'Browser Speech Recognition is not supported in this browser. ' +
        'Please use Chrome or Edge, or switch to OpenAI Whisper in Settings.',
      );
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = this.sourceLanguage;

    this.recognition.onresult = (event: any) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += text;
        } else {
          interim += text;
        }
      }

      if (interim) {
        this.events.onRawTranscript(interim, -1);
      }

      if (final.trim()) {
        this.processText(final.trim());
      }
    };

    this.recognition.onerror = (event: any) => {
      if (event.error === 'not-allowed') {
        this.events.onError('Microphone access denied. Please allow microphone access and try again.');
      } else if (event.error !== 'no-speech') {
        this.events.onError(`Speech recognition error: ${event.error}`);
      }
    };

    // onend fires both on explicit stop() and on browser-initiated disconnects
    this.recognition.onend = () => {
      this.events.onClose();
    };

    this.recognition.start();
    this.events.onReady();
  }

  private async processText(text: string): Promise<void> {
    const index = this.chunkIndex++;

    if (this.translationProvider === 'none') {
      this.events.onTranslation(text, '', index);
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
          glossary: this.glossary || undefined,
          sermonContext: this.sermonContext || undefined,
        }),
      });

      if (!response.ok) {
        this.events.onError('Translation request failed');
        this.events.onTranslation(text, '', index);
        return;
      }

      const data = await response.json();
      this.events.onTranslation(data.correctedText || text, data.translatedText || '', index);
    } catch {
      this.events.onError('Translation failed — check your API key in Settings.');
      this.events.onTranslation(text, '', index);
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

    if (this.recognition) {
      this.recognition.lang = sourceLanguage;
    }
  }

  async stop(): Promise<void> {
    if (this.recognition) {
      this.recognition.onend = null; // prevent duplicate onClose call
      this.recognition.stop();
      this.recognition = null;
    }
    this.events.onClose();
  }
}
