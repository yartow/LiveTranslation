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
4. Detect when different speakers are talking based on conversation patterns, topic changes, or speaking style differences
5. Label each speaker's dialogue with "Speaker 1:", "Speaker 2:", etc. on separate lines
6. Maintain speaker consistency throughout the text`
    : '';

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a helpful assistant that corrects speech transcription errors (stutters, filler words, repetitions) and translates text. 
        
Your tasks:
1. Clean up the transcribed text by removing stutters, filler words (um, uh, like), and verbal mistakes while preserving the core meaning
2. Translate the corrected text to ${targetLanguageName}
3. Return JSON with this exact format: { "correctedText": "cleaned up original text", "translatedText": "translation in ${targetLanguageName}" }${speakerInstructions}`,
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
