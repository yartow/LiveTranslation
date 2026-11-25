// The English line store behind listener mode (CLAUDE.md "Listener mode"): the line type, the
// field-by-field trust-boundary narrowing and the pure functions that edit the backlog. Split out of
// listener-hub.ts (which re-exports everything here) so listener-room.ts and listener-translate.ts can
// use it without importing the socket wiring.
//
// TRUST BOUNDARY: ListenerLine has exactly four fields — id, index, text, edited — and nothing else.
// That is what makes "no Dutch ever reaches a listener" a structural property rather than a discipline
// the caller has to maintain: toListenerLine() reconstructs every incoming line field-by-field, so even
// if the operator's browser were ever tricked into sending a raw segment object (which has a
// sourceText field), that field is simply not among the ones copied out. The English guarantee itself
// still rests on the client only ever calling selectPublishableLines() (segment-store.ts), which reads
// translatedText — this store has no way to verify what language `text` is actually written in.
//
// The same four-field line is what a phone in ANOTHER language receives: the language is carried by
// the message (`lang`), never by the line, and every translated line is produced by
// listener-translate.ts from a stored line's English `text` — never from anything else.

export interface ListenerLine {
  id: string;
  index: number;
  /** The line's text: English as published by the operator, or its translation in the listener's language. Never Dutch. */
  text: string;
  /** True once this line's text has changed since it was first published — the phone renders it italic. */
  edited: boolean;
}

export interface HubState {
  /** The English lines, as published by the operator. The only source anything is ever translated from. */
  lines: Map<string, ListenerLine>;
  /**
   * Line id -> English Bible reference ("John 3:16-18") for lines that are a verbatim reading. A hint that
   * rides next to the lines, never part of one (a ListenerLine stays four fields) and never sent to a phone;
   * listener-translate.ts uses it to show the verse from the phone language's own Bible.
   */
  scriptures: Map<string, string>;
}

export function createHubState(): HubState {
  return { lines: new Map(), scriptures: new Map() };
}

/**
 * Narrows an arbitrary parsed-JSON value down to exactly a ListenerLine's
 * four fields, or null if it doesn't look like one. This reconstruction (not
 * a type-cast) is the trust-boundary enforcement described in the header
 * comment.
 */
export function toListenerLine(raw: unknown): ListenerLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, index, text, edited } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return null;
  if (typeof index !== 'number' || !Number.isFinite(index)) return null;
  if (typeof text !== 'string') return null;
  if (typeof edited !== 'boolean') return null;
  return { id, index, text, edited };
}

/** Validates and merges a batch of raw lines into `state`. Returns only the accepted lines, in input order — the caller broadcasts these as an 'update' delta. */
export function applyPublish(state: HubState, rawLines: unknown[]): ListenerLine[] {
  const accepted: ListenerLine[] = [];
  for (const raw of rawLines) {
    const line = toListenerLine(raw);
    if (!line) continue;
    state.lines.set(line.id, line);
    accepted.push(line);
  }
  return accepted;
}

/**
 * Replaces the whole backlog with exactly what the broadcaster says it has.
 * The broadcaster (the operator's browser) is the only source of truth — the
 * segments live nowhere else — so on every (re)connect it SYNCS instead of
 * merely publishing: a reloaded operator page starts a fresh session with new
 * ids, and merging its lines into the previous page's leftovers would show
 * old and new text interleaved on every phone.
 */
export function applySync(state: HubState, rawLines: unknown[]): ListenerLine[] {
  applyClear(state);
  return applyPublish(state, rawLines);
}

/** Wipes the backlog — called on CLEAR_ALL (a new service starting), so a phone connecting afterwards doesn't see a stale sermon. */
export function applyClear(state: HubState): void {
  state.lines.clear();
  state.scriptures.clear();
}

/** Longest scripture reference the hub keeps ("2 Thessalonians 3:16-18" is 23 characters). */
export const MAX_REFERENCE_LENGTH = 64;

/**
 * Records the scripture hints that came with a batch of accepted lines. Every accepted line is settled by
 * the hint: a line named in `raw` gets (or keeps) its reference, one that is not loses any it had — the
 * operator's page sends the hint with every line that still is a verbatim reading, so an edited verse
 * simply stops being one. Returns the ids whose reference changed (added, replaced or removed).
 */
export function applyScriptures(state: HubState, accepted: ListenerLine[], raw: unknown): string[] {
  const hints = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const changed: string[] = [];
  for (const line of accepted) {
    const hint = hints[line.id];
    const next = typeof hint === 'string' && hint.trim() && hint.length <= MAX_REFERENCE_LENGTH ? hint.trim() : undefined;
    const previous = state.scriptures.get(line.id);
    if (next === previous) continue;
    if (next) state.scriptures.set(line.id, next); else state.scriptures.delete(line.id);
    changed.push(line.id);
  }
  return changed;
}

/** All known lines, ordered for display — what a newly-connecting listener gets as its initial 'snapshot'. */
export function snapshot(state: HubState): ListenerLine[] {
  // Array.from, not [...state.lines.values()] — this repo's tsconfig has no
  // explicit `target`, which defaults tsc to ES3 and rejects iterating a Map
  // iterator without --downlevelIteration (see bible-ref.ts's header comment
  // for the same ES3-default gotcha with regex flags).
  return Array.from(state.lines.values()).sort((a, b) => a.index - b.index);
}
