// Detects when a transcription's ENTIRE output is a Whisper caption
// hallucination rather than real speech — "***", "MUZIEK", "Zang en muziek",
// foreign-script garbage during a Latin-script recording, etc.
//
// Why this exists instead of a no_speech_prob threshold: measured against
// mlx-whisper large-v3 (Dutch, with the app's usual initial_prompt set),
// real quiet speech and actual silence produce OVERLAPPING no_speech_prob
// values — e.g. a real quiet "Amen" scored 0.057 (and was transcribed as
// "MUZIEK"), while pure silence scored 0.047 (lower). No probability
// threshold can separate these; Whisper is trained on caption data and is
// often confidently wrong about hallucinated annotations during silence.
// So this is a closed-set content filter applied to the FULL chunk output,
// not a per-word or per-audio-level heuristic — it only fires when the
// entire transcription is one of these artifacts, never when an artifact
// phrase merely appears inside otherwise-real speech.
//
// Shared by both transcription engines (server/lib/chunk-transcription.ts's
// WebSocket pipeline for 'openai'/'mlx', and the POST /api/transcribe REST
// path in server/routes.ts) so neither engine is a gap in the defence.

const LATIN_SCRIPT_LANGUAGES = new Set(['en', 'es', 'fr', 'de', 'nl', 'pt', 'it']);

// Non-Latin script ranges Whisper is known to hallucinate into during
// silence/noise even when the configured source language is Latin-script
// (the reported case: "を を を" — Hiragana/Katakana — during a Dutch
// recording). zh-TW is intentionally excluded from LATIN_SCRIPT_LANGUAGES
// above, so this check is skipped entirely for it and for zh/ja/ru/ar/fa/
// hi/ko — those languages legitimately produce this script.
const NON_LATIN_SCRIPT_RE =
  /[぀-ヿ㐀-鿿가-힯Ѐ-ӿ؀-ۿ֐-׿]/;

// Normalized (lowercased, diacritics/punctuation stripped, whitespace
// collapsed) whole-output matches. Only fires when the ENTIRE trimmed
// output equals one of these — a sermon that genuinely mentions "muziek"
// or says "dank u wel" mid-sentence is untouched.
const ARTIFACT_PHRASES = new Set([
  // Dutch
  'muziek',
  'zang en muziek',
  'zang',
  'applaus',
  'gelach',
  'stilte',
  'ondertiteling',
  'ondertiteling door',
  'ondertiteld door',
  'ondertiteling door de amara org gemeenschap',
  'abonneer je',
  'dank u wel',
  'dank je wel',
  'bedankt voor het kijken',
  'tot de volgende keer',
  // English
  'music',
  'applause',
  'laughter',
  'silence',
  'thank you',
  'thanks for watching',
  'subtitles by',
  'subtitled by',
  'amara org',
  'you',
  'bye',
]);

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalize(s: string): string {
  return stripDiacritics(s.toLowerCase())
    .replace(/[.,!?;:"'`~*_\-–—()[\]{}♪†•·]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Plain ASCII + Latin-1/Latin Extended-A letter/digit test, rather than a
// Unicode property escape (`\p{L}`) — this project's tsconfig doesn't set a
// `target`, which defaults tsc below the ES2018 property-escape support.
// A non-Latin-script hallucination like "を を を" isn't matched by this,
// but it doesn't need to be — NON_LATIN_SCRIPT_RE below catches it.
const LATIN_LETTER_OR_DIGIT_RE = /[a-zA-Z0-9À-ÖØ-öø-ÿ]/;

export function isAsrArtifact(rawText: string, sourceLanguage?: string): boolean {
  const trimmed = rawText.trim();
  if (!trimmed) return false; // handled separately by the existing empty-text path

  // Nothing but punctuation/symbols/asterisks — e.g. "***".
  if (!LATIN_LETTER_OR_DIGIT_RE.test(trimmed) && !NON_LATIN_SCRIPT_RE.test(trimmed)) return true;

  const lang = (sourceLanguage || '').split('-')[0].toLowerCase();
  if (LATIN_SCRIPT_LANGUAGES.has(lang) && NON_LATIN_SCRIPT_RE.test(trimmed)) return true;

  const normalized = normalize(trimmed);
  if (!normalized) return true;
  return ARTIFACT_PHRASES.has(normalized);
}
