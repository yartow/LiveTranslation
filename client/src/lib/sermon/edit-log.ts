// A continuous log of what the operator changes, for a `dev:record` session (server writes it to
// <session>/edits.jsonl). The 60 s transcript snapshot only shows the final text; this keeps every
// change, including edits that were later reverted and the last minute before the page closed.
// Pure and DOM-free so the entry building is unit-testable; SermonMode wires it to fetch/sendBeacon.

import type { SegmentAction, SegmentStoreState } from './segment-store';

export interface EditLogEntry {
  t: number;
  id: string;
  /** Which action: 'EDIT_SOURCE' | 'REPLACE_SOURCE' | 'SET_TARGET_MANUAL' | 'CLEAR_TARGET_MANUAL'. */
  type: string;
  field: 'source' | 'target';
  prev: string;
  next: string;
}

/** The log entry for `action` applied on top of `before`, or null when it is not a human edit or changed nothing. */
export function editLogEntry(action: SegmentAction, before: SegmentStoreState, now: number): EditLogEntry | null {
  switch (action.type) {
    case 'EDIT_SOURCE':
    case 'REPLACE_SOURCE': {
      const seg = before.byId[action.id];
      if (!seg || seg.sourceText === action.sourceText) return null;
      return { t: now, id: action.id, type: action.type, field: 'source', prev: seg.sourceText, next: action.sourceText };
    }
    case 'SET_TARGET_MANUAL': {
      const seg = before.byId[action.id];
      if (!seg || seg.translatedText === action.translatedText) return null;
      return { t: now, id: action.id, type: action.type, field: 'target', prev: seg.translatedText, next: action.translatedText };
    }
    case 'CLEAR_TARGET_MANUAL': {
      const seg = before.byId[action.id];
      if (!seg || !seg.manualOverride) return null;
      return { t: now, id: action.id, type: action.type, field: 'target', prev: seg.translatedText, next: '' };
    }
    default:
      return null;
  }
}

/** Buffers entries and hands them to `send` as one JSON-lines body per flush. */
export function createEditLog(send: (body: string) => void) {
  let queue: EditLogEntry[] = [];
  return {
    record(entry: EditLogEntry) { queue.push(entry); },
    /** Sends everything buffered; a failing `send` must never break the page. */
    flush() {
      if (!queue.length) return;
      const body = queue.map(e => JSON.stringify(e)).join('\n');
      queue = [];
      try { send(body); } catch { /* a debugging aid */ }
    },
    get size() { return queue.length; },
  };
}
