// Pure reducer + selectors for the sermon-mode segment store. Deliberately
// framework-free (no React import) so it can be exercised directly from
// Vitest under environment:'node' — see tests/unit/sermon-segment-store.test.ts.
//
// The state shape is normalized ({ids, byId}), not an array, and every
// action shallow-copies byId and replaces only the touched id(s). That is
// what makes "editing segment 12 leaves every other segment's object
// reference untouched" a property of the reducer itself, not something the
// UI has to be careful about. See segment-model.ts for hashText/isDirty and
// the plan doc for the full rationale.

import { type Segment, type SegmentStatus, type GlossaryWarning, type ScriptureInfo, hashText, isDirty, createSegment } from './segment-model';

/**
 * Tracks an in-progress Bible reading across segments (spec "Bijbelcitaten"
 * §"Waar eindigt het citaat?") — set when a segment's own text resolves a
 * reference (client/src/lib/sermon/bible-ref.ts), consulted for any
 * following segment that doesn't carry its own reference, and advanced
 * (nextVerse) or cleared as translate results come back. Owned by the store
 * so every runBatch (manual refresh, auto-translate) sees the same view —
 * see useTranslationQueue.ts.
 */
export interface ActiveReading {
  bookNumber: number;
  chapter: number;
  /** The verse the NEXT segment without its own reference will be checked against. */
  nextVerse: number;
}

export interface SegmentStoreState {
  ids: string[];
  byId: Record<string, Segment>;
  nextSeq: number;
  sessionId: string;
  activeReading: ActiveReading | null;
}

export function initState(sessionId: string): SegmentStoreState {
  return { ids: [], byId: {}, nextSeq: 0, sessionId, activeReading: null };
}

/** Deterministic, human-readable ids (seg_<sessionId>_<n>) rather than crypto.randomUUID() — see plan §2. */
export function nextSegmentId(state: SegmentStoreState): string {
  return `seg_${state.sessionId}_${state.nextSeq}`;
}

/**
 * True when a segment is safe for a live/automatic write (UPDATE_PROVISIONAL,
 * COMPLETE_PROVISIONAL) — it exists, and the human hasn't taken it over via a
 * manual override or a source edit ("nooit over een mens heen" — plan §2/§3).
 * Exported so useSermonIngest.ts can make the identical decision *before*
 * dispatching, and fall back to opening a new segment instead of silently
 * losing live text to what would otherwise be a no-op write inside the
 * reducer — see its applyEffects for the fallback.
 */
export function canWriteLive(seg: Segment | undefined): seg is Segment {
  return !!seg && !seg.manualOverride && seg.status !== 'EDITED';
}

export type SegmentAction =
  // `id` is optional: tests and static seeding let the reducer assign one via
  // nextSegmentId(). useSermonIngest.ts always supplies its own explicit id
  // instead, because it must know a PROVISIONAL segment's real id
  // synchronously (to later target it with UPDATE_PROVISIONAL/
  // COMPLETE_PROVISIONAL) without racing React's batched state updates —
  // peeking nextSegmentId(state) from a ref between two dispatches in the
  // same tick is not safe, since the ref may not have caught up yet.
  | { type: 'APPEND_SEGMENT'; id?: string; sourceText: string; startTime: number; endTime: number; approximateTiming?: boolean; status?: SegmentStatus; now: number }
  | { type: 'UPDATE_PROVISIONAL'; id: string; sourceText: string; endTime: number; now: number }
  | { type: 'COMPLETE_PROVISIONAL'; id: string; sourceText: string; endTime: number; now: number }
  | { type: 'EDIT_SOURCE'; id: string; sourceText: string; now: number }
  | { type: 'SET_TARGET_MANUAL'; id: string; translatedText: string; now: number }
  | { type: 'MARK_TRANSLATING'; ids: string[] }
  | { type: 'APPLY_TRANSLATION'; id: string; translation: string; requestHash: string; warnings?: GlossaryWarning[] }
  | { type: 'SET_ERROR'; id: string; error: string; requestHash: string }
  // Scripture pipeline (see ActiveReading above and CLAUDE.md "Scripture pipeline").
  | { type: 'APPLY_SCRIPTURE'; id: string; text: string; reference: string; version: 'ESV' | 'KJV'; requestHash: string }
  | { type: 'CLEAR_SCRIPTURE'; id: string; now: number }
  | { type: 'SET_ACTIVE_READING'; bookNumber: number; chapter: number; verse: number }
  | { type: 'CLEAR_ACTIVE_READING' }
  | { type: 'CLEAR_ALL'; sessionId: string };

function replace(state: SegmentStoreState, id: string, segment: Segment): SegmentStoreState {
  return { ...state, byId: { ...state.byId, [id]: segment } };
}

// A stale APPLY_TRANSLATION/SET_ERROR reply is normally harmless to just drop
// — whatever changed sourceText in the meantime (EDIT_SOURCE, UPDATE_
// PROVISIONAL, COMPLETE_PROVISIONAL) already moved the row's status off
// TRANSLATING. But if none of those happened to run first, dropping the
// reply would leave the row stuck at TRANSLATING forever — selectTranslatable
// excludes it and no per-row button is shown for that status. Force it back
// to EDITED (dirty, translatable) as a last-resort recovery so a rejected
// reply can never permanently strand a row.
function recoverFromStaleReply(state: SegmentStoreState, id: string, seg: Segment): SegmentStoreState {
  if (seg.status !== 'TRANSLATING') return state;
  return replace(state, id, { ...seg, status: 'EDITED' });
}

export function segmentReducer(state: SegmentStoreState, action: SegmentAction): SegmentStoreState {
  switch (action.type) {
    case 'APPEND_SEGMENT': {
      const id = action.id ?? nextSegmentId(state);
      // An id collision should never happen — ids are meant to be unique for
      // the store's lifetime. Refusing to overwrite turns what used to be a
      // silent data-loss bug (a caller-supplied id from a previous session
      // clobbering an existing, possibly already-translated row) into a loud,
      // debuggable no-op instead. See useSermonIngest.ts's session-scoped
      // live ids, which is what stops this from firing in the first place.
      if (state.byId[id]) {
        if (typeof console !== 'undefined') {
          console.warn(`[segment-store] APPEND_SEGMENT ignored: id "${id}" already exists`);
        }
        return state;
      }
      const segment = createSegment({
        id,
        index: state.ids.length,
        sourceText: action.sourceText,
        startTime: action.startTime,
        endTime: action.endTime,
        approximateTiming: action.approximateTiming,
        status: action.status,
        now: action.now,
      });
      return {
        ...state,
        ids: [...state.ids, id],
        byId: { ...state.byId, [id]: segment },
        nextSeq: state.nextSeq + 1,
      };
    }

    // A live-arriving update to a PROVISIONAL segment's text, or a boundary
    // arriving and finalizing it. Both must never clobber a row the human
    // has started editing — see plan §2/§3, "nooit over een mens heen".
    case 'UPDATE_PROVISIONAL': {
      const seg = state.byId[action.id];
      if (!canWriteLive(seg)) return state;
      return replace(state, action.id, {
        ...seg,
        sourceText: action.sourceText,
        endTime: action.endTime,
        status: 'PROVISIONAL',
        lastSourceChangeAt: action.now,
        sourceRevision: seg.sourceRevision + 1,
      });
    }

    case 'COMPLETE_PROVISIONAL': {
      const seg = state.byId[action.id];
      if (!canWriteLive(seg)) return state;
      return replace(state, action.id, {
        ...seg,
        sourceText: action.sourceText,
        endTime: action.endTime,
        status: 'PENDING',
        approximateTiming: seg.approximateTiming,
        lastSourceChangeAt: action.now,
        sourceRevision: seg.sourceRevision + 1,
      });
    }

    // Human edit. This is the only action that sets status EDITED, and it is
    // the only writer of sourceText that must NOT bump sourceRevision — the
    // textarea already holds this exact text (it's an uncontrolled input),
    // so there is nothing for the UI layer to imperatively re-sync.
    case 'EDIT_SOURCE': {
      const seg = state.byId[action.id];
      if (!seg) return state;
      return replace(state, action.id, {
        ...seg,
        sourceText: action.sourceText,
        status: 'EDITED',
        lastSourceChangeAt: action.now,
        glossaryWarnings: undefined, // stale against the edited source — a fresh translation will re-check
        scripture: undefined, // stale — a corrected/edited reference gets a fresh lookup on the next translate
        scriptureOverride: false, // an edit is a fresh start — re-enable scripture detection even if the human previously dismissed it
      });
    }

    case 'SET_TARGET_MANUAL': {
      const seg = state.byId[action.id];
      if (!seg) return state;
      return replace(state, action.id, {
        ...seg,
        translatedText: action.translatedText,
        manualOverride: true,
        status: 'TRANSLATED',
        error: undefined,
        glossaryWarnings: undefined, // the human's hand-written translation is authoritative
        scripture: undefined,
      });
    }

    case 'MARK_TRANSLATING': {
      let byId = state.byId;
      let changed = false;
      for (const id of action.ids) {
        const seg = byId[id];
        if (!seg || seg.manualOverride) continue;
        if (!changed) { byId = { ...byId }; changed = true; }
        byId[id] = { ...seg, status: 'TRANSLATING' };
      }
      return changed ? { ...state, byId } : state;
    }

    // Guarded against staleness: if the human kept editing while this
    // translation was in flight, requestHash no longer matches the current
    // sourceText hash and the result is discarded — the row stays dirty and
    // will be picked up by the next refresh. Also discarded if the human
    // applied a manual override in the meantime (AC4).
    case 'APPLY_TRANSLATION': {
      const seg = state.byId[action.id];
      if (!seg) return state;
      if (seg.manualOverride) return state;
      if (hashText(seg.sourceText) !== action.requestHash) return recoverFromStaleReply(state, action.id, seg);
      return replace(state, action.id, {
        ...seg,
        translatedText: action.translation,
        translatedHash: action.requestHash,
        status: 'TRANSLATED',
        error: undefined,
        glossaryWarnings: action.warnings,
        scripture: undefined, // may have been SCRIPTURE before a corrected source resolved to an ordinary translation
      });
    }

    case 'SET_ERROR': {
      const seg = state.byId[action.id];
      if (!seg) return state;
      if (seg.manualOverride) return state;
      if (hashText(seg.sourceText) !== action.requestHash) return recoverFromStaleReply(state, action.id, seg);
      return replace(state, action.id, { ...seg, status: 'ERROR', error: action.error, glossaryWarnings: undefined });
    }

    // A verbatim reading (server/lib/scripture.ts) — the exact quoted verse
    // text, not a model translation. Uses the same requestHash staleness
    // guard and translatedHash bookkeeping as APPLY_TRANSLATION, which is
    // what makes a SCRIPTURE segment behave exactly like the spec requires:
    // not auto-retranslated (isDirty is false once translatedHash matches),
    // but a source edit re-dirties it and the next translate re-adjudicates.
    case 'APPLY_SCRIPTURE': {
      const seg = state.byId[action.id];
      if (!seg) return state;
      if (seg.manualOverride) return state;
      if (hashText(seg.sourceText) !== action.requestHash) return recoverFromStaleReply(state, action.id, seg);
      return replace(state, action.id, {
        ...seg,
        translatedText: action.text,
        translatedHash: action.requestHash,
        status: 'SCRIPTURE',
        error: undefined,
        glossaryWarnings: undefined,
        scripture: { reference: action.reference, version: action.version, verses: action.text },
      });
    }

    // Human says "this isn't scripture" — re-dirty so the next refresh
    // translates it normally, and remember not to re-detect a reference in
    // this row's current text (scriptureOverride), until the human edits it
    // again (see EDIT_SOURCE, which resets scriptureOverride to false).
    case 'CLEAR_SCRIPTURE': {
      const seg = state.byId[action.id];
      if (!seg) return state;
      return replace(state, action.id, {
        ...seg,
        status: 'EDITED',
        scripture: undefined,
        scriptureOverride: true,
        // sourceText itself didn't change, so translatedHash would still
        // match it and isDirty() would say "not dirty" despite status
        // EDITED — null it out (same as a never-translated segment) so this
        // row is genuinely picked up by the next refresh/auto-translate.
        translatedHash: null,
        lastSourceChangeAt: action.now,
      });
    }

    case 'SET_ACTIVE_READING':
      return { ...state, activeReading: { bookNumber: action.bookNumber, chapter: action.chapter, nextVerse: action.verse } };

    case 'CLEAR_ACTIVE_READING':
      return state.activeReading === null ? state : { ...state, activeReading: null };

    case 'CLEAR_ALL':
      return initState(action.sessionId);

    default:
      return state;
  }
}

// ── Selectors ────────────────────────────────────────────────────────────

export function selectOrdered(state: SegmentStoreState): Segment[] {
  return state.ids.map(id => state.byId[id]);
}

export function selectDirtyIds(state: SegmentStoreState): string[] {
  return state.ids.filter(id => isDirty(state.byId[id]));
}

export interface TranslatableConfig {
  stabilityMs: number;
}

/**
 * Segments eligible for *automatic* translation: dirty, not already in
 * flight, not manually overridden, and unchanged for at least stabilityMs —
 * the debounce that keeps us from translating text Whisper is still
 * revising. Manual Refresh bypasses this selector entirely (it calls
 * selectDirtyIds directly) because the human explicitly asked for it.
 */
export function selectTranslatable(state: SegmentStoreState, cfg: TranslatableConfig, now: number): string[] {
  return state.ids.filter(id => {
    const seg = state.byId[id];
    if (seg.manualOverride || seg.status === 'TRANSLATING') return false;
    if (!isDirty(seg)) return false;
    return now - seg.lastSourceChangeAt >= cfg.stabilityMs;
  });
}

export interface SegmentContext {
  before: string[];
  after: string[];
}

/** Read-only neighbour sentences for the <CONTEXT_VOOR>/<CONTEXT_NA> prompt blocks. */
export function selectContext(state: SegmentStoreState, id: string, before: number, after: number): SegmentContext {
  const idx = state.ids.indexOf(id);
  if (idx === -1) return { before: [], after: [] };
  const beforeIds = state.ids.slice(Math.max(0, idx - before), idx);
  const afterIds = state.ids.slice(idx + 1, idx + 1 + after);
  return {
    before: beforeIds.map(i => state.byId[i].sourceText),
    after: afterIds.map(i => state.byId[i].sourceText),
  };
}
