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

import { type Segment, type SegmentStatus, hashText, isDirty, createSegment } from './segment-model';

export interface SegmentStoreState {
  ids: string[];
  byId: Record<string, Segment>;
  nextSeq: number;
  sessionId: string;
}

export function initState(sessionId: string): SegmentStoreState {
  return { ids: [], byId: {}, nextSeq: 0, sessionId };
}

/** Deterministic, human-readable ids (seg_<sessionId>_<n>) rather than crypto.randomUUID() — see plan §2. */
export function nextSegmentId(state: SegmentStoreState): string {
  return `seg_${state.sessionId}_${state.nextSeq}`;
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
  | { type: 'APPLY_TRANSLATION'; id: string; translation: string; requestHash: string }
  | { type: 'SET_ERROR'; id: string; error: string; requestHash: string }
  | { type: 'CLEAR_ALL'; sessionId: string };

function replace(state: SegmentStoreState, id: string, segment: Segment): SegmentStoreState {
  return { ...state, byId: { ...state.byId, [id]: segment } };
}

export function segmentReducer(state: SegmentStoreState, action: SegmentAction): SegmentStoreState {
  switch (action.type) {
    case 'APPEND_SEGMENT': {
      const id = action.id ?? nextSegmentId(state);
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
      if (!seg) return state;
      if (seg.manualOverride || seg.status === 'EDITED') return state;
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
      if (!seg) return state;
      if (seg.manualOverride || seg.status === 'EDITED') return state;
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
      if (hashText(seg.sourceText) !== action.requestHash) return state;
      return replace(state, action.id, {
        ...seg,
        translatedText: action.translation,
        translatedHash: action.requestHash,
        status: 'TRANSLATED',
        error: undefined,
      });
    }

    case 'SET_ERROR': {
      const seg = state.byId[action.id];
      if (!seg) return state;
      if (seg.manualOverride) return state;
      if (hashText(seg.sourceText) !== action.requestHash) return state;
      return replace(state, action.id, { ...seg, status: 'ERROR', error: action.error });
    }

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
