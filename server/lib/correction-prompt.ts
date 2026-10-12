// Shared pieces of sermon mode's per-chunk ASR correction prompt, used by the
// OpenAI, Claude and Ollama variants (openai.ts / anthropic.ts / ollama.ts)
// so the three can't drift apart.

// The correction prompts used to give English homophone examples
// (pray/prey, their/there) regardless of the spoken language — useless for a
// Dutch sermon, and an invitation for the model to "fix" correct Dutch.
const HOMOPHONE_EXAMPLES: Record<string, string> = {
  nl: 'wordt/word, hun/hen, zonde/zond, heel/hele, dan/dat, zijn/zeijn',
  en: 'pray/prey, altar/alter, their/there/they\'re, word/world, profit/prophet',
  de: 'das/dass, wieder/wider, seid/seit, Stadt/statt',
  fr: 'ses/ces/c\'est, a/à, ou/où, sans/sang',
  es: 'haber/a ver, hecho/echo, tubo/tuvo, vaca/baca',
};

export function homophoneExamples(sourceLanguage?: string): string {
  const lang = (sourceLanguage || '').split('-')[0].toLowerCase();
  return HOMOPHONE_EXAMPLES[lang] ?? HOMOPHONE_EXAMPLES.en;
}

// Whisper hallucinates caption annotations during silence/music; the server
// strips them (asr-artifacts.ts) but the correction model must not copy or
// invent them either.
export const NO_ANNOTATIONS_RULE =
  'Remove non-speech annotations such as [Muziek], (applaus), ♪ or *zang*, and never add words that were not spoken.';

/**
 * Safety net around a correction model's output. A model asked to "correct" a
 * short fragment occasionally answers it, explains itself, or invents a
 * continuation. Correction only fixes and removes — it should never make the
 * text much LONGER — so output far longer than the input is rejected in
 * favour of the raw ASR text.
 */
export function guardCorrection(raw: string, corrected: string | undefined): string {
  const out = (corrected ?? '').trim();
  if (!out) return raw;
  if (out.length > raw.length * 1.6 + 20) return raw;
  return out;
}
