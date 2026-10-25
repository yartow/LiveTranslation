// Which Bible passage (if any) a segment should be checked against — the client half of the scripture
// pipeline (CLAUDE.md "Scripture pipeline"). Pure so the order of the rules is unit-testable:
//   1. the segment names a reference itself ("Hebreeën 12:1-3, laten we lezen") -> that starts a reading,
//   2. else a reading is under way -> the next verse of it,
//   3. else a passage planned for today (service-context.ts) that has not been seen yet -> its first verse,
//      so a reading nobody announced is still caught on its first verbatim verse.

import { findBibleRef } from './bible-ref';
import { passageKey } from './service-context';
import type { ActiveReading } from './segment-store';
import type { ReadingCandidate } from './translate-client';

export interface PickedCandidate {
  readingCandidate?: ReadingCandidate;
  /** How to render the spoken reference in English ("John 3:16") — a hint for the announcement sentence. */
  referenceHint?: string;
  /** The segment's own reference started this candidate (the reading is started at once, before the verdict). */
  ownRef: boolean;
  /** The candidate is a planned passage: it only becomes a reading if the verdict is a verbatim hit. */
  planned: boolean;
}

export interface PickInput {
  text: string;
  /** The operator said "not scripture" for this row — no detection at all. */
  scriptureOverride?: boolean;
  activeReading: ActiveReading | null;
  plannedPassages?: ReadingCandidate[];
  /** passageKey()s of planned passages already caught or announced. */
  usedPlanned: ReadonlySet<string>;
}

export function pickReadingCandidate(input: PickInput): PickedCandidate {
  const out: PickedCandidate = { ownRef: false, planned: false };
  if (input.scriptureOverride) return out;

  const ref = findBibleRef(input.text);
  if (ref) {
    out.referenceHint = ref.canonicalEn;
    if (ref.verseStart !== null) {
      out.readingCandidate = { bookNumber: ref.bookNumber, chapter: ref.chapter, verse: ref.verseStart };
      out.ownRef = true;
    }
    return out;
  }
  if (input.activeReading) {
    out.readingCandidate = {
      bookNumber: input.activeReading.bookNumber,
      chapter: input.activeReading.chapter,
      verse: input.activeReading.nextVerse,
    };
    return out;
  }
  const next = (input.plannedPassages ?? []).find(p => !input.usedPlanned.has(passageKey(p)));
  if (next) { out.readingCandidate = next; out.planned = true; }
  return out;
}
