// Translation via a local Ollama instance (OpenAI-compatible API).
// Ollama must be running on the machine and serving on ollamaBaseUrl.
import OpenAI from 'openai';

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', nl: 'Dutch',
  pt: 'Portuguese', it: 'Italian', zh: 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)',
  ar: 'Arabic', fa: 'Farsi', hi: 'Hindi', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
};

function makeClient(baseUrl: string): OpenAI {
  const base = baseUrl.replace(/\/$/, '');
  return new OpenAI({
    apiKey: 'ollama',
    baseURL: `${base}/v1`,
  });
}

export async function correctAndTranslateWithOllama(
  originalText: string,
  targetLanguage: string,
  detectSpeakers: boolean,
  ollamaModel: string,
  ollamaBaseUrl: string,
  glossary?: string,
  sermonContext?: string,
  signal?: AbortSignal,
): Promise<{ correctedText: string; translatedText: string }> {
  const targetLanguageName = LANGUAGE_NAMES[targetLanguage] ?? targetLanguage;
  const contextParts: string[] = [];
  if (sermonContext?.trim()) contextParts.push(`\nContext: ${sermonContext.trim()}`);
  if (glossary?.trim()) contextParts.push(`\nGlossary (preserve exactly): ${glossary.trim()}`);
  const contextSection = contextParts.join('\n');

  const speakerInstructions = detectSpeakers
    ? '\n5. Label different speakers as "Speaker 1:", "Speaker 2:", etc.'
    : '';

  const timeout = AbortSignal.timeout(60_000);
  const combinedSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;

  const response = await makeClient(ollamaBaseUrl).chat.completions.create(
    {
      model: ollamaModel,
      messages: [
        {
          role: 'system',
          content: `You are a speech transcription cleaner and translator.${contextSection}

Tasks:
1. Clean stutters, filler words (um, uh, like), and verbal mistakes from the transcription while preserving meaning
2. Format as continuous prose — only start a new paragraph when the topic clearly changes
3. Translate the corrected text to ${targetLanguageName} with the same formatting
4. Return ONLY valid JSON: { "correctedText": "...", "translatedText": "..." }${speakerInstructions}`,
        },
        { role: 'user', content: `Transcription: "${originalText}"` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    },
    { signal: combinedSignal },
  );

  const result = JSON.parse(response.choices[0].message.content || '{}');
  return {
    correctedText: result.correctedText || originalText,
    translatedText: result.translatedText || '',
  };
}

export async function retroactiveCorrectionWithOllama(
  accumulatedText: string,
  targetLanguage: string,
  detectSpeakers: boolean,
  ollamaModel: string,
  ollamaBaseUrl: string,
  glossary?: string,
  sermonContext?: string,
  signal?: AbortSignal,
): Promise<{ correctedText: string; translatedText: string }> {
  const targetLanguageName = LANGUAGE_NAMES[targetLanguage] ?? targetLanguage;
  const contextParts: string[] = [];
  if (sermonContext?.trim()) contextParts.push(`\nContext: ${sermonContext.trim()}`);
  if (glossary?.trim()) contextParts.push(`\nGlossary (preserve exactly): ${glossary.trim()}`);
  const contextSection = contextParts.join('\n');

  const speakerInstructions = detectSpeakers
    ? '\n5. Keep speaker labels ("Speaker 1:", "Speaker 2:", etc.) consistent.'
    : '';

  const timeout = AbortSignal.timeout(60_000);
  const combinedSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;

  const response = await makeClient(ollamaBaseUrl).chat.completions.create(
    {
      model: ollamaModel,
      messages: [
        {
          role: 'system',
          content: `You are a transcription editor performing a retroactive coherence pass.${contextSection}

Tasks:
1. Check for words transcribed incorrectly based on context ("their" vs "there", etc.)
2. Fix grammar mistakes and tense inconsistencies without rewriting the content
3. Format as continuous prose — new paragraph only on topic change
4. Translate to ${targetLanguageName} with the same formatting
5. Return ONLY valid JSON: { "correctedText": "...", "translatedText": "..." }${speakerInstructions}`,
        },
        { role: 'user', content: `Text to review: "${accumulatedText}"` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    },
    { signal: combinedSignal },
  );

  const result = JSON.parse(response.choices[0].message.content || '{}');
  return {
    correctedText: result.correctedText || accumulatedText,
    translatedText: result.translatedText || '',
  };
}
