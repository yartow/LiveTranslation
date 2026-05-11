import OpenAI from 'openai';
import fs from 'fs';
import { createHash } from 'crypto';

const sharedClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// LRU cache for per-user OpenAI clients. Keyed by SHA-256 of the API key so
// raw keys are never stored as Map keys. Max 50 entries; oldest evicted first.
const MAX_CLIENTS = 50;
const clientCache = new Map<string, OpenAI>();

function client(apiKey?: string): OpenAI {
  if (!apiKey) return sharedClient;
  const hash = createHash('sha256').update(apiKey).digest('hex');
  if (clientCache.has(hash)) {
    const c = clientCache.get(hash)!;
    // Move to end (most-recently-used)
    clientCache.delete(hash);
    clientCache.set(hash, c);
    return c;
  }
  if (clientCache.size >= MAX_CLIENTS) {
    clientCache.delete(clientCache.keys().next().value!);
  }
  const c = new OpenAI({ apiKey });
  clientCache.set(hash, c);
  return c;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  nl: 'Dutch',
  pt: 'Portuguese',
  it: 'Italian',
  zh: 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  ar: 'Arabic',
  fa: 'Farsi',
  hi: 'Hindi',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
};

// Build a short Whisper prompt from glossary + sermon context.
// Whisper uses this as "previous context" to prime the decoder toward domain vocabulary.
function buildWhisperPrompt(glossary?: string, sermonContext?: string): string | undefined {
  const parts: string[] = [];
  if (sermonContext?.trim()) parts.push(`Sermon: ${sermonContext.trim()}.`);
  if (glossary?.trim()) {
    const terms = glossary.split('\n')
      .map(line => line.split('=')[0].trim())
      .filter(Boolean)
      .slice(0, 25)
      .join(', ');
    if (terms) parts.push(`Terms: ${terms}.`);
  }
  return parts.length ? parts.join(' ') : undefined;
}

// Build the context block injected into LLM system messages.
function buildContextSection(glossary?: string, sermonContext?: string): string {
  const parts: string[] = [];
  if (sermonContext?.trim()) parts.push(`\nSermon context: ${sermonContext.trim()}`);
  if (glossary?.trim()) {
    parts.push(`\nTheological glossary — preserve these terms exactly:\n${glossary.trim()}`);
  }
  return parts.join('\n');
}

export async function transcribeAudio(
  audioFilePath: string,
  language: string = 'en',
  apiKey?: string,
  glossary?: string,
  sermonContext?: string,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(60_000);
  const combinedSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const audioReadStream = fs.createReadStream(audioFilePath);
  const whisperPrompt = buildWhisperPrompt(glossary, sermonContext);
  try {
    const transcription = await client(apiKey).audio.transcriptions.create(
      {
        file: audioReadStream,
        model: 'gpt-4o-transcribe',
        language: language.split('-')[0],
        ...(whisperPrompt ? { prompt: whisperPrompt } : {}),
      },
      { signal: combinedSignal },
    );
    return transcription.text;
  } finally {
    audioReadStream.destroy();
  }
}

export async function correctAndTranslateText(
  originalText: string,
  targetLanguage: string,
  detectSpeakers = false,
  apiKey?: string,
  glossary?: string,
  sermonContext?: string,
  signal?: AbortSignal,
): Promise<{ correctedText: string; translatedText: string }> {
  const targetLanguageName = LANGUAGE_NAMES[targetLanguage] ?? 'English';

  const speakerInstructions = detectSpeakers
    ? `
5. Detect when different speakers are talking based on conversation patterns, topic changes, or speaking style differences
6. Label each speaker's dialogue with "Speaker 1:", "Speaker 2:", etc.
7. Maintain speaker consistency throughout the text`
    : '';

  const contextSection = buildContextSection(glossary, sermonContext);
  const timeout = AbortSignal.timeout(30_000);
  const combinedSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;

  const response = await client(apiKey).chat.completions.create(
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant that corrects speech transcription errors (stutters, filler words, repetitions) and translates text.${contextSection}

Your tasks:
1. Clean up the transcribed text by removing stutters, filler words (um, uh, like), and verbal mistakes while preserving the core meaning
2. Format the text like prose in a book - write sentences continuously in paragraphs
3. ONLY add a new paragraph (line break) when the speaker changes topics or starts a new subject matter
4. Do NOT add line breaks between sentences unless a new topic begins
5. Translate the corrected text to ${targetLanguageName} following the same formatting rules
6. Return JSON with this exact format: { "correctedText": "cleaned up original text", "translatedText": "translation in ${targetLanguageName}" }${speakerInstructions}`,
        },
        {
          role: 'user',
          content: `Original transcription: "${originalText}"`,
        },
      ],
      response_format: { type: 'json_object' },
    },
    { signal: combinedSignal },
  );

  const result = JSON.parse(response.choices[0].message.content || '{}');

  return {
    correctedText: result.correctedText || originalText,
    translatedText: result.translatedText || '',
  };
}

export async function retroactiveCorrection(
  accumulatedText: string,
  targetLanguage: string,
  detectSpeakers = false,
  apiKey?: string,
  glossary?: string,
  sermonContext?: string,
  signal?: AbortSignal,
): Promise<{ correctedText: string; translatedText: string }> {
  const targetLanguageName = LANGUAGE_NAMES[targetLanguage] ?? 'English';

  const speakerInstructions = detectSpeakers
    ? `
5. Maintain speaker labels ("Speaker 1:", "Speaker 2:", etc.) if present
6. Ensure speaker consistency throughout the text`
    : '';

  const contextSection = buildContextSection(glossary, sermonContext);
  const timeout = AbortSignal.timeout(30_000);
  const combinedSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;

  const response = await client(apiKey).chat.completions.create(
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant that performs retroactive coherence checking and grammar correction on accumulated transcribed text.${contextSection}

Your tasks:
1. Review the accumulated text for overall coherence and flow
2. Check if any words were transcribed incorrectly based on context (e.g., "their" vs "there", "to" vs "too")
3. Fix any grammar mistakes, tense inconsistencies, or word choice errors
4. Preserve the original meaning and speaking style - only fix errors, don't rewrite
5. Format the text like prose in a book - write sentences continuously in paragraphs
6. ONLY add a new paragraph (line break) when the speaker changes topics
7. Translate the corrected text to ${targetLanguageName} following the same formatting rules
8. Return JSON with this exact format: { "correctedText": "corrected original text", "translatedText": "translation in ${targetLanguageName}" }${speakerInstructions}`,
        },
        {
          role: 'user',
          content: `Accumulated transcription to review and correct: "${accumulatedText}"`,
        },
      ],
      response_format: { type: 'json_object' },
    },
    { signal: combinedSignal },
  );

  const result = JSON.parse(response.choices[0].message.content || '{}');

  return {
    correctedText: result.correctedText || accumulatedText,
    translatedText: result.translatedText || '',
  };
}

export async function formatForExport(
  originalText: string,
  translatedText: string,
  targetLanguage: string,
  exportType: 'original' | 'translation' | 'both',
  fileFormat: 'txt' | 'md',
  apiKey?: string,
): Promise<string> {
  const targetLanguageName = LANGUAGE_NAMES[targetLanguage] ?? 'English';

  const formatInstructions = fileFormat === 'md'
    ? 'Format the output in proper Markdown with headings, paragraphs, and formatting.'
    : 'Format the output as plain text with proper paragraphs and line breaks.';

  let contentToFormat = '';
  let formatPrompt = '';

  if (exportType === 'original') {
    contentToFormat = originalText;
    formatPrompt = `Format this sermon transcript for export. Add proper line breaks between paragraphs, correct punctuation, and make minor corrections where there are obvious misinterpretations. Mark any corrections you make with asterisks (e.g., "he went to *their* house" if you corrected "there" to "their"). ${formatInstructions}`;
  } else if (exportType === 'translation') {
    contentToFormat = translatedText;
    formatPrompt = `Format this sermon transcript translation (in ${targetLanguageName}) for export. Add proper line breaks between paragraphs, correct punctuation, and make minor corrections where there are obvious misinterpretations. Mark any corrections you make with asterisks. ${formatInstructions}`;
  } else {
    formatPrompt = `Format both the original sermon transcript and its ${targetLanguageName} translation for side-by-side export. For each version:
1. Add proper line breaks between paragraphs
2. Correct punctuation
3. Make minor corrections where there are obvious misinterpretations
4. Mark any corrections with asterisks

Present them with clear section headers. ${formatInstructions}

Original text: "${originalText}"

Translation (${targetLanguageName}): "${translatedText}"`;
  }

  const response = await client(apiKey).chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant that formats sermon transcripts for export. You add proper formatting, fix punctuation, and make minor corrections to obvious transcription errors. Always mark corrections with asterisks so readers can see what was changed.',
      },
      {
        role: 'user',
        content: exportType === 'both'
          ? formatPrompt
          : `${formatPrompt}\n\nText to format: "${contentToFormat}"`,
      },
    ],
  });

  return response.choices[0].message.content || contentToFormat;
}
