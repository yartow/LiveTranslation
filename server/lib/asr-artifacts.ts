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

// Pattern-based whole-output artifacts (matched on the normalized text), for
// phrases with a variable part a fixed set can't list. "TV Gelderland 2021" is
// what mlx-whisper large-v3 actually returned for a plain tone in testing —
// Whisper's Dutch training data contains broadcaster subtitle credits.
const ARTIFACT_PATTERNS: RegExp[] = [
  /^(?:tv|omroep) gelderland(?: \d{4})?$/,
  /^(?:ondertitel\w*|untertitel\w*|subtitles?|sous titres?) .*\b(?:amara|gemeenschap|community|ingediend|tt888)\b/,
];

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

// ── Partial-artifact stripping ───────────────────────────────────────────────
// isAsrArtifact() above only fires when the WHOLE chunk is a caption phrase.
// Real hallucinations are often mixed into otherwise-real text: "[Muziek]
// Goedemorgen", "Muziek. Muziek.", "♪ … ♪ en toen", "… Ondertiteling door …",
// or a decoder loop repeating one phrase. stripAsrArtifacts() removes those
// pieces while leaving the speech around them alone.

// Caption-type phrases only (not polite closers like "dank u wel" / "thank
// you", which a preacher genuinely says at the start or end of a chunk).
// Matched at a chunk edge, and only when terminated by sentence punctuation or
// end-of-text — so "Muziek is een gave van God" at the start of a chunk is
// NOT stripped, but "Muziek. Goedemorgen" is.
const EDGE_CAPTION_SOURCE = [
  'zang en muziek', 'muziek', 'zang', 'applaus', 'gelach',
  'ondertiteling[^.!?…]*', 'ondertiteld door[^.!?…]*', 'amara\\.org[^.!?…]*',
  'abonneer je[^.!?…]*', 'bedankt voor het kijken', 'tot de volgende keer',
  'music', 'applause', 'laughter', 'subtitles by[^.!?…]*', 'subtitled by[^.!?…]*',
  'thanks for watching',
].join('|');
const EDGE_TERM = '(?:[.!?…]+|$)';
const LEADING_CAPTION_RE = new RegExp(`^\\s*(?:${EDGE_CAPTION_SOURCE})\\s*${EDGE_TERM}\\s*`, 'i');
const TRAILING_CAPTION_RE = new RegExp(`(?:^|[.!?…]\\s+)(?:${EDGE_CAPTION_SOURCE})\\s*[.!?…]*\\s*$`, 'i');
// A subtitle-credit line ("Ondertiteling door de Amara.org gemeenschap") is
// only ever the LAST thing Whisper appends, and its own "Amara.org" dot would
// end a sentence-bounded match early — so a trailing credit consumes to the end.
const TRAILING_CREDIT_RE = /(?:^|[.!?…]\s+)(?:ondertiteling|ondertiteld door|subtitles by|subtitled by|amara\.org|(?:tv|omroep) gelderland(?: \d{4})?)[\s\S]*$/i;
// Whisper's all-caps caption hallucination often has no punctuation at all
// ("MUZIEK Dank u wel."). Case-sensitive on purpose: real speech is never
// transcribed as a bare ALL-CAPS "MUZIEK".
const LEADING_CAPS_CAPTION_RE = /^\s*(?:ZANG EN MUZIEK|MUZIEK|APPLAUS|GELACH|MUSIC|APPLAUSE|LAUGHTER)\b\s*[.!?…]*\s*/;

// Annotation syntax that is never spoken content: [Muziek], *zang*, ♪ la la ♪,
// and parentheses only when what's inside is itself a caption phrase (a
// preacher's "(Johannes 3:16)"-style aside survives).
const BRACKET_ANNOTATION_RE = /\[[^\]]{0,80}\]/g;
const ASTERISK_ANNOTATION_RE = /\*[^*\n]{1,80}\*/g;
const MUSIC_NOTE_SPAN_RE = /[♪♫][^♪♫]*[♪♫]/g;
const MUSIC_NOTE_RE = /[♪♫♬]/g;
const PAREN_ANNOTATION_RE = /\(([^)]{1,60})\)/g;

const MIN_REPEATS_SINGLE_WORD = 4; // "heel heel heel" is plausible speech
const MIN_REPEATS_PHRASE = 3;
const MAX_LOOP_PHRASE_WORDS = 8;

function wordKey(word: string): string {
  return stripDiacritics(word.toLowerCase()).replace(/[^a-z0-9]/g, '');
}

/** Collapses a word or phrase repeated back-to-back many times (a decoder loop) down to one occurrence. */
function collapseRepeatedPhrases(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < MIN_REPEATS_PHRASE) return text;
  const keys = words.map(wordKey);
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let collapsed = false;
    for (let n = 1; n <= MAX_LOOP_PHRASE_WORDS && !collapsed; n++) {
      const minRepeats = n === 1 ? MIN_REPEATS_SINGLE_WORD : MIN_REPEATS_PHRASE;
      if (i + n * minRepeats > words.length) break;
      if (keys.slice(i, i + n).some(k => !k)) continue;
      let repeats = 1;
      while (i + (repeats + 1) * n <= words.length) {
        const same = keys.slice(i, i + n).every((k, j) => k === keys[i + repeats * n + j]);
        if (!same) break;
        repeats++;
      }
      if (repeats >= minRepeats) {
        out.push(...words.slice(i, i + n));
        i += repeats * n;
        collapsed = true;
      }
    }
    if (!collapsed) out.push(words[i++]);
  }
  return out.join(' ');
}

/**
 * Removes hallucinated caption artifacts from inside / at the edges of a
 * transcription, leaving real speech intact. Returns '' when nothing real is
 * left. Run isAsrArtifact() first for the whole-output case; this handles the
 * mixed cases it can't.
 */
export function stripAsrArtifacts(rawText: string, sourceLanguage?: string): string {
  let text = rawText;

  text = text.replace(BRACKET_ANNOTATION_RE, ' ')
    .replace(ASTERISK_ANNOTATION_RE, ' ')
    .replace(MUSIC_NOTE_SPAN_RE, ' ')
    .replace(MUSIC_NOTE_RE, ' ')
    .replace(PAREN_ANNOTATION_RE, (m, inner: string) => (ARTIFACT_PHRASES.has(normalize(inner)) ? ' ' : m));

  // Edge captions can stack ("Muziek. Muziek. Ondertiteling door …"), so peel
  // until stable.
  for (let guard = 0; guard < 10; guard++) {
    const before = text;
    text = text.replace(LEADING_CAPS_CAPTION_RE, '').replace(LEADING_CAPTION_RE, '').replace(TRAILING_CREDIT_RE, (m) => (/^[.!?…]/.test(m) ? m.match(/^[.!?…]+/)![0] : '')).replace(TRAILING_CAPTION_RE, (m) => (/^[.!?…]/.test(m) ? m.match(/^[.!?…]+/)![0] + ' ' : '')).trim();
    if (text === before) break;
  }

  text = collapseRepeatedPhrases(text).replace(/\s{2,}/g, ' ').trim();

  if (!text || isAsrArtifact(text, sourceLanguage)) return '';
  return text;
}

export function isAsrArtifact(rawText: string, sourceLanguage?: string): boolean {
  const trimmed = rawText.trim();
  if (!trimmed) return false; // handled separately by the existing empty-text path

  // Nothing but punctuation/symbols/asterisks — e.g. "***".
  if (!LATIN_LETTER_OR_DIGIT_RE.test(trimmed) && !NON_LATIN_SCRIPT_RE.test(trimmed)) return true;

  const lang = (sourceLanguage || '').split('-')[0].toLowerCase();
  if (LATIN_SCRIPT_LANGUAGES.has(lang) && NON_LATIN_SCRIPT_RE.test(trimmed)) return true;

  const normalized = normalize(trimmed);
  if (!normalized) return true;
  return ARTIFACT_PHRASES.has(normalized) || ARTIFACT_PATTERNS.some(re => re.test(normalized));
}
