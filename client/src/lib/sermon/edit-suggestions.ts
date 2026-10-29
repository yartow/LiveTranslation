// Words the operator keeps correcting, as glossary suggestions. Every Segment carries `asrText` (what the
// recognizer gave) next to `sourceText` (what is on screen now), so a word-level diff of the two shows what
// the human changed — no archive, no recording session needed. A change seen twice ("evengeven" -> "evangelie"
// in two places) is almost certainly a systematic mishearing; a single change is only worth suggesting when
// it looks like a name (capitalised, close to what was heard). The operator accepts a suggestion through the
// existing Add-to-glossary dialog, which writes the replacement the server then applies to every new chunk.
//
// Pure and DOM-free so it is unit-testable.

import { norm, stripPunct } from './word-text';

export interface SuggestionSegment {
  id: string;
  asrText: string;
  sourceText: string;
}

export interface EditSuggestion {
  /** Normalised `heard→correct`, stable across spelling/case — used to dismiss a suggestion for good. */
  key: string;
  /** As first seen, punctuation stripped. */
  heard: string;
  correct: string;
  count: number;
  segmentIds: string[];
}

interface Word { raw: string; norm: string }

/** Words so common that swapping one for another is a rewording, not a mishearing. */
const STOPWORDS = new Set([
  'de', 'het', 'een', 'en', 'van', 'dat', 'die', 'dit', 'is', 'te', 'in', 'op', 'ik', 'je', 'we', 'ze', 'er', 'ook',
  'maar', 'dan', 'nu', 'als', 'dus', 'om', 'aan', 'met', 'voor', 'naar', 'bij', 'uit', 'of', 'zo', 'wel', 'niet',
  'was', 'zijn', 'wij', 'jullie', 'hij', 'zij', 'hem', 'haar', 'mijn', 'jouw', 'ons', 'onze', 'der', 'den', 'ja', 'nee',
]);

const MAX_PHRASE_WORDS = 3;
/** Longest diff table worth building: segments are a few sentences; a pasted wall of text is skipped. */
const MAX_CELLS = 250_000;


function words(text: string): Word[] {
  const out: Word[] = [];
  for (const w of text.split(/\s+/)) {
    const raw = stripPunct(w);
    const n = norm(raw);
    if (n) out.push({ raw, norm: n });
  }
  return out;
}

interface Hunk { aFrom: number; aTo: number; bFrom: number; bTo: number }

/** Runs of changed words between two word lists (LCS alignment). null when the table would be too big. */
function diffHunks(a: string[], b: string[]): Hunk[] | null {
  const n = a.length, m = b.length;
  if (n * m > MAX_CELLS) return null;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0, j = 0;
  let cur: Hunk | null = null;
  const close = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { close(); i++; j++; continue; }
    if (!cur) cur = { aFrom: i, aTo: i, bFrom: j, bTo: j };
    if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) { j++; cur.bTo = j; }
    else { i++; cur.aTo = i; }
  }
  close();
  return hunks;
}

/** Edit distance relative to the longer word (0 = same, 1 = nothing in common). */
function distanceRatio(x: string, y: string): number {
  if (!x.length && !y.length) return 0;
  const prev = Array.from({ length: y.length + 1 }, (_, k) => k);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[y.length] / Math.max(x.length, y.length);
}

const looksLikeName = (heard: string, correct: string): boolean =>
  /^[A-Z\u00C0-\u00DE]/.test(correct) && !/^[A-Z\u00C0-\u00DE]/.test(heard) && distanceRatio(norm(heard), norm(correct)) <= 0.6;

interface Substitution { key: string; heard: string; correct: string }

/** The word/phrase substitutions in one segment: what the recognizer wrote -> what the human wrote instead. */
export function segmentSubstitutions(asrText: string, sourceText: string): Substitution[] {
  if (asrText === sourceText) return [];
  const a = words(asrText), b = words(sourceText);
  const hunks = diffHunks(a.map(w => w.norm), b.map(w => w.norm));
  if (!hunks) return [];
  const out: Substitution[] = [];
  for (const h of hunks) {
    const dn = h.aTo - h.aFrom, in_ = h.bTo - h.bFrom;
    if (dn < 1 || in_ < 1 || dn > MAX_PHRASE_WORDS || in_ > MAX_PHRASE_WORDS) continue; // pure insert/delete or a rewrite
    const heardWords = a.slice(h.aFrom, h.aTo), correctWords = b.slice(h.bFrom, h.bTo);
    const heard = heardWords.map(w => w.raw).join(' '), correct = correctWords.map(w => w.raw).join(' ');
    const hn = heardWords.map(w => w.norm).join(' '), cn = correctWords.map(w => w.norm).join(' ');
    if (hn === cn) continue;                                          // case/punctuation only
    if (/\d/.test(heard + correct)) continue;                         // digits vs number words
    if (heardWords.every(w => STOPWORDS.has(w.norm)) && correctWords.every(w => STOPWORDS.has(w.norm))) continue; // rewording
    if (dn === 1 && in_ === 1 && (heardWords[0].norm.length < 3 || correctWords[0].norm.length < 3)) continue;
    out.push({ key: `${hn}→${cn}`, heard, correct });
  }
  return out;
}

// The page recomputes the suggestions on every store update (every live chunk and keystroke), but a row's diff
// only changes when its asr/source text does — remember the answers (bounded, dropped wholesale when full).
const SUBSTITUTION_CACHE_MAX = 2000;
const substitutionCache = new Map<string, Substitution[]>();
function cachedSubstitutions(asrText: string, sourceText: string): Substitution[] {
  const key = `${asrText}\u0000${sourceText}`;
  let hit = substitutionCache.get(key);
  if (!hit) {
    if (substitutionCache.size >= SUBSTITUTION_CACHE_MAX) substitutionCache.clear();
    substitutionCache.set(key, hit = segmentSubstitutions(asrText, sourceText));
  }
  return hit;
}

/**
 * Suggestions across all rows the operator touched, most frequent first. A suggestion needs two sightings,
 * or one that looks like a name. `dismissed` keys are left out.
 */
export function editSuggestions(segments: SuggestionSegment[], dismissed: ReadonlySet<string> = new Set()): EditSuggestion[] {
  const byKey = new Map<string, EditSuggestion>();
  for (const seg of segments) {
    if (seg.asrText === seg.sourceText) continue;
    const seenHere = new Set<string>();
    for (const sub of cachedSubstitutions(seg.asrText, seg.sourceText)) {
      if (dismissed.has(sub.key) || seenHere.has(sub.key)) continue; // one sighting per row, however often repeated inside it
      seenHere.add(sub.key);
      const e = byKey.get(sub.key);
      if (e) {
        e.count++;
        e.segmentIds.push(seg.id);
        // "Kind" at the start of a sentence, "kind" elsewhere: the lowercase form is the term worth filing.
        if (sub.correct === sub.correct.toLowerCase() && e.correct !== e.correct.toLowerCase()) { e.heard = sub.heard; e.correct = sub.correct; }
      }
      else byKey.set(sub.key, { key: sub.key, heard: sub.heard, correct: sub.correct, count: 1, segmentIds: [seg.id] });
    }
  }
  return Array.from(byKey.values())
    .filter(s => s.count >= 2 || looksLikeName(s.heard, s.correct))
    .sort((x, y) => y.count - x.count || x.heard.localeCompare(y.heard));
}
