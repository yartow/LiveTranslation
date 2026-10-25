// "Today's service": what the operator knows before the preacher starts — title, the planned Bible
// passages, names and terms that will come up, free notes. Pure and DOM-free (like the rest of
// lib/sermon) so parsing is unit-testable. It feeds three places:
//   - Whisper's vocabulary prompt and the per-chunk correction (the correct spellings, via glossaryWithService),
//   - the translator's system prompt (serviceContextForPrompt -> server/lib/sermon-prompt.ts),
//   - the Bible-quote pipeline (plannedPassages: a reading is caught even when never announced).
// Stored per tab session (sessionStorage, see useSettings.ts) so last week's service can't leak into this one.

import { findBibleRef, type BibleRef } from './bible-ref';
import type { ReadingCandidate } from './translate-client';

export interface ServiceContext {
  title: string;
  /** One Bible passage per line, in Dutch as spoken: "Hebreeën 12:1-3". */
  passages: string;
  /** One name/term per line: `Term`, or `heard = Correct` when Whisper keeps mishearing it. */
  terms: string;
  notes: string;
}

export const EMPTY_SERVICE_CONTEXT: ServiceContext = { title: '', passages: '', terms: '', notes: '' };

const MAX_TITLE = 200;
const MAX_PASSAGES = 600;
const MAX_TERMS = 4000;
const MAX_NOTES = 2000;
const MAX_TERM_LINES = 100;
const MAX_TERM_CHARS = 80;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Whatever was stored (or typed) -> a well-formed context: strings only, length-capped. */
export function normalizeServiceContext(raw: unknown): ServiceContext {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { title: str(o.title, MAX_TITLE), passages: str(o.passages, MAX_PASSAGES), terms: str(o.terms, MAX_TERMS), notes: str(o.notes, MAX_NOTES) };
}

export function isEmptyServiceContext(c: ServiceContext): boolean {
  return !c.title.trim() && !c.passages.trim() && !c.terms.trim() && !c.notes.trim();
}

export interface ServiceTerm {
  /** What Whisper tends to write (empty for a plain term). */
  heard: string;
  /** The spelling to use. */
  correct: string;
}

export function parseServiceTerms(terms: string): ServiceTerm[] {
  const out: ServiceTerm[] = [];
  for (const line of terms.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    const heard = eq >= 0 ? t.slice(0, eq).trim() : '';
    const correct = (eq >= 0 ? t.slice(eq + 1).trim() : t).slice(0, MAX_TERM_CHARS);
    if (!correct) continue;
    out.push({ heard: heard.slice(0, MAX_TERM_CHARS), correct });
    if (out.length >= MAX_TERM_LINES) break;
  }
  return out;
}

/**
 * The glossary text handed to Whisper's prompt and the correction step: today's correct spellings first
 * (the prompt only has room for the first terms), then the standing vocabulary. No `=` in these lines —
 * the server uses the part before `=` as the term.
 */
export function glossaryWithService(baseGlossary: string, c: ServiceContext): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const t of parseServiceTerms(c.terms)) {
    const key = t.correct.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(t.correct);
  }
  if (c.title.trim()) lines.unshift(c.title.trim().slice(0, MAX_TERM_CHARS));
  if (!lines.length) return baseGlossary;
  return base(baseGlossary) ? `${lines.join('\n')}\n${baseGlossary}` : lines.join('\n');
}
const base = (g: string) => g.trim();

export interface ParsedPassage {
  line: string;
  /** null when the line could not be read as a Dutch Bible reference. */
  ref: BibleRef | null;
}

export function parsePassages(passages: string): ParsedPassage[] {
  return passages.split('\n').map(l => l.trim()).filter(Boolean).map(line => ({ line, ref: findBibleRef(line) }));
}

/** Verse-level passages in the order given: the readings to expect, as candidates for scripture adjudication. */
export function plannedPassages(c: ServiceContext): ReadingCandidate[] {
  const out: ReadingCandidate[] = [];
  for (const p of parsePassages(c.passages)) {
    if (p.ref && p.ref.verseStart !== null) out.push({ bookNumber: p.ref.bookNumber, chapter: p.ref.chapter, verse: p.ref.verseStart });
  }
  return out;
}

/** The text sent to the translator (server/lib/sermon-prompt.ts sanitizes and fences it). Empty when there is nothing to say. */
export function serviceContextForPrompt(c: ServiceContext): string {
  const lines: string[] = [];
  if (c.title.trim()) lines.push(`Title: ${c.title.trim()}`);
  for (const p of parsePassages(c.passages)) lines.push(`Passage: ${p.ref ? p.ref.canonicalEn : p.line}`);
  for (const t of parseServiceTerms(c.terms)) lines.push(t.heard ? `Name/term: ${t.correct} (may be heard as "${t.heard}")` : `Name/term: ${t.correct}`);
  for (const n of c.notes.split('\n').map(l => l.trim()).filter(Boolean)) lines.push(`Note: ${n}`);
  return lines.join('\n');
}

/** Stable key for a planned passage — remembers which readings have already been caught. */
export const passageKey = (p: ReadingCandidate): string => `${p.bookNumber}:${p.chapter}:${p.verse}`;
