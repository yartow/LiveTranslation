import OpenAI from "openai";
import fs from "fs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcribeAudio(audioFilePath: string, language: string = "en"): Promise<string> {
  const audioReadStream = fs.createReadStream(audioFilePath);

  const transcription = await openai.audio.transcriptions.create({
    file: audioReadStream,
    model: "whisper-1",
    language: language,
  });

  return transcription.text;
}

export async function correctAndTranslateText(
  originalText: string,
  targetLanguage: string,
  detectSpeakers: boolean = false
): Promise<{ correctedText: string; translatedText: string }> {
  const languageNames: Record<string, string> = {
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    nl: "Dutch",
    pt: "Portuguese",
    it: "Italian",
    zh: "Chinese (Simplified)",
    "zh-TW": "Chinese (Traditional)",
    ar: "Arabic",
    fa: "Farsi",
    hi: "Hindi",
    ru: "Russian",
    ja: "Japanese",
    ko: "Korean",
  };

  const targetLanguageName = languageNames[targetLanguage] || "English";

  const speakerInstructions = detectSpeakers
    ? `
5. Detect when different speakers are talking based on conversation patterns, topic changes, or speaking style differences
6. Label each speaker's dialogue with "Speaker 1:", "Speaker 2:", etc.
7. Maintain speaker consistency throughout the text`
    : '';

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a helpful assistant that corrects speech transcription errors (stutters, filler words, repetitions) and translates text. 
        
Your tasks:
1. Clean up the transcribed text by removing stutters, filler words (um, uh, like), and verbal mistakes while preserving the core meaning
2. Format the text like prose in a book - write sentences continuously in paragraphs
3. ONLY add a new paragraph (line break) when the speaker changes topics or starts a new subject matter
4. Do NOT add line breaks between sentences unless a new topic begins
5. Translate the corrected text to ${targetLanguageName} following the same formatting rules
6. Return JSON with this exact format: { "correctedText": "cleaned up original text", "translatedText": "translation in ${targetLanguageName}" }${speakerInstructions}`,
      },
      {
        role: "user",
        content: `Original transcription: "${originalText}"`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content || "{}");

  return {
    correctedText: result.correctedText || originalText,
    translatedText: result.translatedText || originalText,
  };
}

export async function retroactiveCorrection(
  accumulatedText: string,
  targetLanguage: string,
  detectSpeakers: boolean = false
): Promise<{ correctedText: string; translatedText: string }> {
  const languageNames: Record<string, string> = {
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    nl: "Dutch",
    pt: "Portuguese",
    it: "Italian",
    zh: "Chinese (Simplified)",
    "zh-TW": "Chinese (Traditional)",
    ar: "Arabic",
    fa: "Farsi",
    hi: "Hindi",
    ru: "Russian",
    ja: "Japanese",
    ko: "Korean",
  };

  const targetLanguageName = languageNames[targetLanguage] || "English";

  const speakerInstructions = detectSpeakers
    ? `
5. Maintain speaker labels ("Speaker 1:", "Speaker 2:", etc.) if present
6. Ensure speaker consistency throughout the text`
    : '';

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a helpful assistant that performs retroactive coherence checking and grammar correction on accumulated transcribed text.
        
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
        role: "user",
        content: `Accumulated transcription to review and correct: "${accumulatedText}"`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content || "{}");

  return {
    correctedText: result.correctedText || accumulatedText,
    translatedText: result.translatedText || accumulatedText,
  };
}
