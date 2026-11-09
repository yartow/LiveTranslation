import type { ChunkTranscriptionEvents, TranslationProvider } from './chunk-based-transcription';
import type { TranscriptionBackend } from './transcription-backend';
import { translateRecognizedText } from './translate-text';

export class BrowserSpeechTranscription implements TranscriptionBackend {
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
  private ollamaBaseUrl = '';
  private ollamaModel = '';
  private chunkIndex = 0;
  private intentionalStop = false;

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
    ollamaBaseUrl = '',
    ollamaModel = '',
  ): Promise<void> {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.detectSpeakers = detectSpeakers;
    this.translationProvider = translationProvider;
    this.openaiApiKey = openaiApiKey;
    this.anthropicApiKey = anthropicApiKey;
    this.glossary = glossary;
    this.sermonContext = sermonContext;
    this.ollamaBaseUrl = ollamaBaseUrl;
    this.ollamaModel = ollamaModel;
    this.chunkIndex = 0;
    this.intentionalStop = false;

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      throw new Error(
        'Browser Speech Recognition is not supported in this browser. ' +
        'Please use Chrome or Edge, or switch to OpenAI Whisper in Settings.',
      );
    }

    const rec = new SpeechRecognition();
    this.recognition = rec;
    this.attachHandlers(rec);
    rec.start();
    this.events.onReady();
  }

  private attachHandlers(rec: any): void {
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.sourceLanguage;

    rec.onresult = (event: any) => {
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

    rec.onerror = (event: any) => {
      if (event.error === 'not-allowed') {
        this.intentionalStop = true;
        this.events.onError('Microphone access denied. Please allow microphone access and try again.');
      } else if (event.error === 'network') {
        this.intentionalStop = true; // prevent restart loop
        const isBrave = typeof (window.navigator as any).brave !== 'undefined';
        this.events.onError(
          isBrave
            ? 'Brave is blocking Google\'s speech service. Go to Brave Shields (lion icon) → disable for this page, then try again. Or switch to OpenAI Whisper in Settings.'
            : 'Could not reach Google\'s speech recognition service. Check your internet connection, or switch to OpenAI Whisper in Settings.',
        );
      } else if (event.error !== 'no-speech') {
        this.events.onError(`Speech recognition error: ${event.error}`);
      }
    };

    // Chrome ends recognition after ~15s of silence or on network disruptions.
    // Restart automatically unless stop() was explicitly called.
    rec.onend = () => {
      if (this.intentionalStop) {
        this.events.onClose();
        return;
      }
      try {
        rec.start();
      } catch {
        this.events.onClose();
      }
    };
  }

  private async processText(text: string): Promise<void> {
    await translateRecognizedText(text, this.chunkIndex++, {
      targetLanguage: this.targetLanguage,
      detectSpeakers: this.detectSpeakers,
      translationProvider: this.translationProvider,
      openaiApiKey: this.openaiApiKey,
      anthropicApiKey: this.anthropicApiKey,
      glossary: this.glossary,
      sermonContext: this.sermonContext,
      ollamaBaseUrl: this.ollamaBaseUrl,
      ollamaModel: this.ollamaModel,
    }, this.events);
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
    if (sermonContext !== undefined) this.sermonContext = sermonContext;
    if (ollamaBaseUrl !== undefined) this.ollamaBaseUrl = ollamaBaseUrl;
    if (ollamaModel !== undefined) this.ollamaModel = ollamaModel;

    if (this.recognition) {
      this.recognition.lang = sourceLanguage;
    }
  }

  async stop(): Promise<void> {
    if (this.recognition) {
      this.intentionalStop = true;
      this.recognition.stop();
      this.recognition = null;
    } else {
      this.events.onClose();
    }
  }
}
