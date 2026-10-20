// Request validation for POST /api/sermon/translate's `items` array. Lives
// outside routes.ts so it can be unit-tested without importing the whole
// router (OpenAI/Anthropic clients, multer, ffmpeg).

import type { TranslateItemInput } from './sermon-translate';

export const SERMON_MAX_ITEMS = 100;
/**
 * Sanity cap per text/context string, not a product limit: a translator may
 * type or paste arbitrarily long cells and they must translate. This only keeps
 * one hostile request from pinning memory (the route's 10 MB body limit is the
 * other half of that guard).
 */
export const SERMON_MAX_TEXT_LEN = 100_000;
export const SERMON_MAX_CONTEXT_SENTENCES = 5;
export const SERMON_MAX_REFERENCE_HINT_LEN = 60;

// bookNumber 1-66 (the canonical Protestant-canon count — see
// scripts/build-bible-data.ts's books.json), chapter/verse positive
// integers. Resolution of the reference itself (book-name parsing) happens
// entirely client-side (client/src/lib/sermon/bible-ref.ts) — this only
// validates the shape of what the client already resolved, never re-parses text.
function parseReadingCandidate(value: unknown): TranslateItemInput['readingCandidate'] | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return 'invalid';
  const { bookNumber, chapter, verse } = value as Record<string, unknown>;
  const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
  if (!isPositiveInt(bookNumber) || bookNumber > 66) return 'invalid';
  if (!isPositiveInt(chapter) || chapter > 999) return 'invalid';
  if (!isPositiveInt(verse) || verse > 999) return 'invalid';
  return { bookNumber, chapter, verse };
}

export interface ParsedSermonItems {
  items: TranslateItemInput[];
  /** Ids of items whose text is empty/whitespace — answered with a per-item error instead of rejecting the whole batch. */
  blankIds: string[];
}

/** null = structurally invalid (the caller 400s). */
export function parseSermonItems(value: unknown): ParsedSermonItems | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > SERMON_MAX_ITEMS) return null;

  const items: TranslateItemInput[] = [];
  const blankIds: string[] = [];
  const seenIds = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const { id, text, before, after, readingCandidate, referenceHint } = raw as Record<string, unknown>;

    if (typeof id !== 'string' || !id) return null;
    if (seenIds.has(id)) return null;
    seenIds.add(id);
    if (typeof text !== 'string' || text.length > SERMON_MAX_TEXT_LEN) return null;

    const beforeArr = before === undefined ? [] : before;
    const afterArr = after === undefined ? [] : after;
    if (!Array.isArray(beforeArr) || !Array.isArray(afterArr)) return null;
    if (beforeArr.length > SERMON_MAX_CONTEXT_SENTENCES || afterArr.length > SERMON_MAX_CONTEXT_SENTENCES) return null;
    const isValidContextString = (s: unknown): s is string => typeof s === 'string' && s.length <= SERMON_MAX_TEXT_LEN;
    if (!beforeArr.every(isValidContextString) || !afterArr.every(isValidContextString)) return null;

    const parsedCandidate = parseReadingCandidate(readingCandidate);
    if (parsedCandidate === 'invalid') return null;

    if (referenceHint !== undefined && (typeof referenceHint !== 'string' || referenceHint.length > SERMON_MAX_REFERENCE_HINT_LEN)) return null;

    if (!text.trim()) { blankIds.push(id); continue; }
    items.push({
      id, text, before: beforeArr as string[], after: afterArr as string[],
      readingCandidate: parsedCandidate ?? undefined,
      referenceHint: referenceHint || undefined,
    });
  }
  return { items, blankIds };
}
