// Deterministic "misheard phrase -> correct term" replacements, learned from
// the operator ("Add to glossary" in sermon mode, see glossary-add.ts) and
// stored in <GLOSSARY_DIR>/asr-corrections.csv (columns: Gehoord,Nederlands).
//
// Applied to every transcribed chunk right after stripAsrArtifacts, so it works
// whether or not the per-chunk LLM correction is on: Whisper's own mistake is
// fixed before the LLM (or the ingest buffer) ever sees it. The correct terms
// are also fed to Whisper's prompt and the correction prompt (see
// effectiveGlossary), so the mistake becomes less likely in the first place.
//
// Loading never throws — a missing/corrupt file is just "no corrections", the
// same discipline as glossary-store.ts.

import { parseCsv } from './csv-parse';
import { readGlossaryFile, statGlossaryFile } from './glossary-file';

export const CORRECTIONS_FILE = 'asr-corrections.csv';
export const CORRECTIONS_HEADER = ['Gehoord', 'Nederlands'];

export interface CorrectionRule {
  heard: string;
  correct: string;
  regex: RegExp;
  wordCount: number;
}

// No `u` flag (this project's tsconfig target rejects it), so "a letter" is
// spelled out: ASCII + Latin-1 Supplement/Extended-A/B, which covers Dutch.
const LETTER = 'A-Za-z0-9\\u00C0-\\u024F';
const NON_LETTER_RUN = new RegExp(`[^${LETTER}]+`);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The words of a phrase, ignoring case, punctuation and spacing — "Ik lees, je-logie" and "ik lees je logie" compare equal. */
export function phraseWords(phrase: string): string[] {
  return phrase.normalize('NFC').toLowerCase().split(NON_LETTER_RUN).filter(Boolean);
}

export function normalizePhrase(phrase: string): string {
  return phraseWords(phrase).join(' ');
}

export function buildRules(pairs: Array<{ heard: string; correct: string }>): CorrectionRule[] {
  // Later rows override earlier ones for the same phrase, so re-adding a term with a different fix wins.
  const byKey = new Map<string, { heard: string; correct: string }>();
  for (const p of pairs) {
    const key = normalizePhrase(p.heard);
    if (!key || !p.correct.trim()) continue;
    byKey.set(key, { heard: p.heard.trim(), correct: p.correct.trim() });
  }
  const rules: CorrectionRule[] = [];
  for (const [key, p] of Array.from(byKey)) {
    const words = key.split(' ');
    // The phrase may be separated by any whitespace/punctuation in the transcript ("ik lees, je logie").
    const body = words.map(escapeRegex).join(`[^${LETTER}]+`);
    // Group 1 = the character before the match (or start of text) — a lookbehind would do, but this avoids needing one.
    const regex = new RegExp(`(^|[^${LETTER}])(${body})(?![${LETTER}])`, 'gi');
    rules.push({ heard: p.heard, correct: p.correct, regex, wordCount: words.length });
  }
  // Longest phrase first, so "ik lees je logie" wins over a shorter rule on "je logie".
  return rules.sort((a, b) => b.wordCount - a.wordCount || b.heard.length - a.heard.length);
}

function matchCase(matched: string, correct: string): string {
  const first = matched.charAt(0);
  const isUpper = first !== first.toLowerCase() && first === first.toUpperCase();
  if (isUpper && correct.charAt(0) === correct.charAt(0).toLowerCase()) {
    return correct.charAt(0).toUpperCase() + correct.slice(1);
  }
  return correct;
}

export function applyAsrCorrections(text: string, rules: CorrectionRule[]): string {
  if (!text || rules.length === 0) return text;
  let out = text;
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    out = out.replace(rule.regex, (_m, before: string, matched: string) => before + matchCase(matched, rule.correct));
  }
  return out;
}

let cache: { mtimeMs: number; rules: CorrectionRule[]; terms: string[] } | null = null;

function load(): { rules: CorrectionRule[]; terms: string[] } {
  try {
    const mtimeMs = statGlossaryFile(CORRECTIONS_FILE, 'csv');
    if (mtimeMs === null) { cache = null; return { rules: [], terms: [] }; }
    if (cache && cache.mtimeMs === mtimeMs) return cache;
    const rows = parseCsv(readGlossaryFile(CORRECTIONS_FILE, 'csv').text);
    const pairs = rows
      .filter((r, i) => !(i === 0 && r[0]?.trim().toLowerCase() === CORRECTIONS_HEADER[0].toLowerCase()))
      .filter(r => r.length >= 2)
      .map(r => ({ heard: r[0], correct: r[1] }));
    const rules = buildRules(pairs);
    const terms = Array.from(new Set(rules.map(r => r.correct)));
    cache = { mtimeMs, rules, terms };
    return cache;
  } catch {
    return { rules: [], terms: [] };
  }
}

/** Cached by mtime; cheap enough to call per chunk. */
export function getAsrCorrectionRules(): CorrectionRule[] {
  return load().rules;
}

export function applyLearnedCorrections(text: string): string {
  return applyAsrCorrections(text, getAsrCorrectionRules());
}

export function resetAsrCorrectionsCache(): void {
  cache = null;
}

/**
 * The session's vocabulary hints with the learned correct terms in front.
 * Whisper's prompt keeps only the first terms and the correction prompt gets the
 * whole list, so putting learned terms first means the operator's own
 * corrections are never the ones cut off. The first `priorityLines` lines of the session glossary (today's
 * service title and terms) stay in front of even those: the prompt only has room for ~15 terms, and
 * once that many corrections are learned they would otherwise push the names of this service out.
 */
export function effectiveGlossary(sessionGlossary: string | undefined, priorityLines = 0): string {
  const { terms } = load();
  if (terms.length === 0) return sessionGlossary ?? '';
  const existing = (sessionGlossary ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const head = existing.slice(0, Math.max(0, priorityLines));
  const termOf = (l: string) => l.split('=')[0].trim().toLowerCase();
  const taken = new Set(head.map(termOf));
  const learned = terms.filter(t => !taken.has(t.toLowerCase()));
  const have = new Set(terms.map(t => t.toLowerCase()));
  const rest = existing.slice(head.length).filter(l => !have.has(termOf(l)) && !taken.has(termOf(l)));
  return [...head, ...learned, ...rest].join('\n');
}

/** A client-sent count of priority glossary lines -> a small non-negative integer (anything else: 0). */
export function parsePriorityLines(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? Math.min(raw, 100) : 0;
}
