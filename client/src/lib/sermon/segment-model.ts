// Sermon-mode segment model. See CLAUDE.md "Sermon mode" and
// /Users/andrewyong/.claude/plans/aannames-pas-aan-snoopy-fog.md for the full design.
//
// A Segment is roughly one sentence. It is the atomic unit of editing and
// translation in sermon mode — the whole point of this model is that editing
// one segment's sourceText and re-translating it never touches any other
// segment's translatedText.

export type SegmentStatus =
  | 'PENDING'      // transcribed, not yet translated
  | 'TRANSLATING'  // a translation call is in flight
  | 'TRANSLATED'   // translatedText matches the current sourceText
  | 'EDITED'       // sourceText changed since the last translation (dirty, human-driven)
  | 'ERROR'        // last translation attempt failed
  | 'PROVISIONAL'  // emitted early by the cap-flush before a sentence boundary arrived
  | 'SCRIPTURE';   // translatedText is an exact quoted Bible verse (ESV/KJV), not a model translation — see server/lib/scripture.ts

/** Mirrors server/lib/glossary-check.ts's GlossaryWarning — client/server share no code, see sermon-prompt.ts's header comment. */
export interface GlossaryWarning {
  term: string;
  expected: string;
}

/** Set on a SCRIPTURE segment — the exact verse text substituted in, and where it came from. See CLAUDE.md "Scripture pipeline". */
export interface ScriptureInfo {
  reference: string; // e.g. "John 3:16" or "John 3:16-18"
  version: 'ESV' | 'KJV';
  verses: string;
}

export interface Segment {
  /** Stable, unique, never changes once assigned. */
  id: string;
  /** Order in the sermon. */
  index: number;
  /** Approximate, derived from chunk index * chunk duration — see plan §"Timestamps". */
  startTime: number;
  endTime: number;
  /** True while startTime/endTime are chunk-index approximations rather than real ASR timestamps. */
  approximateTiming: boolean;
  /** Dutch, editable by the human translator. */
  sourceText: string;
  /** English (or whatever targetLanguage is). */
  translatedText: string;
  status: SegmentStatus;
  /** Hash of the sourceText the current translatedText was computed from. null = never translated. */
  translatedHash: string | null;
  /** True once the human has hand-edited translatedText. Such rows are skipped by all auto/refresh paths. */
  manualOverride: boolean;
  /** Timestamp of the most recent sourceText change; drives the stability debounce. */
  lastSourceChangeAt: number;
  /** Bumped only by non-user writes (provisional updates, completions) — see segment-store.ts. */
  sourceRevision: number;
  error?: string;
  /** Non-blocking glossary-adherence warnings from the last translation, or undefined when there are none. Cleared on any edit/override/error — see segment-store.ts. */
  glossaryWarnings?: GlossaryWarning[];
  /** Set when status is SCRIPTURE — the verse reference/version/text that was substituted. Cleared on any edit — see segment-store.ts. */
  scripture?: ScriptureInfo;
  /** True once the human has told this row "not scripture" (CLEAR_SCRIPTURE) — future refreshes translate it normally even if a Bible reference is still detected in its text. Reset to false on the next edit, so correcting the reference re-enables detection. */
  scriptureOverride?: boolean;
}

/**
 * Synchronous FNV-1a 32-bit hash, returned as 8 lowercase hex chars.
 *
 * We need a hash that is (a) synchronous — this runs inside a reducer, and
 * crypto.subtle.digest is async and not usable there — and (b) available
 * identically in the browser and in Node under Vitest, without a dependency.
 * FNV-1a is a handful of lines and good enough: it is a dirty-check, not a
 * security boundary. Text is NFC-normalised and trimmed first so that
 * whitespace-only edits (e.g. a stray trailing space from a textarea) don't
 * spuriously mark a segment dirty.
 */
export function hashText(text: string): string {
  const normalized = text.normalize('NFC').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A segment is dirty when its translation no longer matches its source —
 * except a manualOverride segment, which is never considered dirty: the
 * human's hand-written translation is authoritative and must survive every
 * future refresh (acceptance criterion 4).
 */
export function isDirty(segment: Segment): boolean {
  if (segment.manualOverride) return false;
  return hashText(segment.sourceText) !== segment.translatedHash;
}

export interface CreateSegmentInput {
  id: string;
  index: number;
  sourceText: string;
  startTime: number;
  endTime: number;
  approximateTiming?: boolean;
  status?: SegmentStatus;
  now: number;
}

export function createSegment(input: CreateSegmentInput): Segment {
  return {
    id: input.id,
    index: input.index,
    startTime: input.startTime,
    endTime: input.endTime,
    approximateTiming: input.approximateTiming ?? true,
    sourceText: input.sourceText,
    translatedText: '',
    status: input.status ?? 'PENDING',
    translatedHash: null,
    manualOverride: false,
    lastSourceChangeAt: input.now,
    sourceRevision: 0,
  };
}
