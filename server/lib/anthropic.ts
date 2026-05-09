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

async function callClaude(
  systemPrompt: string,
  userContent: string,
  apiKey: string,
  maxTokens = 1024,
  signal?: AbortSignal,
): Promise<string> {
  const effectiveKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!effectiveKey) {
    throw new Error('No Anthropic API key provided. Add one in Settings.');
  }

  const timeout = AbortSignal.timeout(30_000);
  const combinedSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': effectiveKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
    signal: combinedSignal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = await response.json() as { content?: Array<{ text?: string }> };
  return data.content?.[0]?.text ?? '';
}

function parseJsonResponse(
  raw: string,
  fallback: Record<string, string>,
): Record<string, string> {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
}

function buildContextSection(glossary?: string, sermonContext?: string): string {
  const parts: string[] = [];
  if (sermonContext?.trim()) parts.push(`\nSermon context: ${sermonContext.trim()}`);
  if (glossary?.trim()) {
    parts.push(`\nTheological glossary — preserve these terms exactly:\n${glossary.trim()}`);
  }
  return parts.join('\n');
}

export async function correctAndTranslateWithClaude(
  originalText: string,
  targetLanguage: string,
  detectSpeakers: boolean,
  apiKey: string,
  glossary?: string,
  sermonContext?: string,
  signal?: AbortSignal,
): Promise<{ correctedText: string; translatedText: string }> {
  const langName = LANGUAGE_NAMES[targetLanguage] ?? 'English';

  const speakerNote = detectSpeakers
    ? `\n5. Detect speaker changes and label each as "Speaker 1:", "Speaker 2:", etc.`
    : '';

  const contextSection = buildContextSection(glossary, sermonContext);

  const system = `You are a helpful assistant that corrects speech transcription errors and translates text.${contextSection}

Tasks:
1. Remove stutters, filler words (um, uh, like), and verbal mistakes
2. Format as prose paragraphs; new paragraph only on topic change
3. Translate to ${langName} following the same formatting rules
4. Return ONLY valid JSON: {"correctedText":"...","translatedText":"..."}${speakerNote}`;

  const raw = await callClaude(system, `Original transcription: "${originalText}"`, apiKey, 1024, signal);
  const result = parseJsonResponse(raw, { correctedText: originalText, translatedText: '' });

  return {
    correctedText: result.correctedText || originalText,
    translatedText: result.translatedText ?? '',
  };
}

export async function retroactiveCorrectionWithClaude(
  accumulatedText: string,
  targetLanguage: string,
  detectSpeakers: boolean,
  apiKey: string,
  glossary?: string,
  sermonContext?: string,
  signal?: AbortSignal,
): Promise<{ correctedText: string; translatedText: string }> {
  const langName = LANGUAGE_NAMES[targetLanguage] ?? 'English';

  const speakerNote = detectSpeakers
    ? `\n5. Maintain speaker labels and ensure speaker consistency throughout`
    : '';

  const contextSection = buildContextSection(glossary, sermonContext);

  const system = `You are a helpful assistant performing retroactive coherence checking on accumulated transcription.${contextSection}

Tasks:
1. Review for overall coherence and flow
2. Fix context-dependent errors (e.g., "their" vs "there")
3. Fix grammar, tense inconsistencies, and word choice errors
4. Preserve original meaning and speaking style
5. Translate to ${langName}
6. Return ONLY valid JSON: {"correctedText":"...","translatedText":"..."}${speakerNote}`;

  const raw = await callClaude(
    system,
    `Accumulated transcription: "${accumulatedText}"`,
    apiKey,
    2048,
    signal,
  );
  const result = parseJsonResponse(raw, { correctedText: accumulatedText, translatedText: '' });

  return {
    correctedText: result.correctedText || accumulatedText,
    translatedText: result.translatedText ?? '',
  };
}
