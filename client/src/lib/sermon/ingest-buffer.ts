// The live-ingest flush state machine (plan §3). Pure and framework-free:
// driven from a ref inside useSermonIngest, not React state, because it
// needs synchronous read-modify-write on every incoming chunk of corrected
// ASR text and on every ~250ms cap-timer tick.
//
// One trigger, cfg.maxLatencyMs, decides when buffered text becomes a
// segment — it is both the TARGET block duration and the hard ceiling:
//   (a) a complete sentence boundary exists AND cfg.maxLatencyMs has
//       elapsed since the block STARTED — flush everything complete in the
//       buffer as ONE joined segment. A boundary alone is NOT enough to
//       flush: short sentences keep accumulating into the same block until
//       the target duration is reached, which is what keeps a sermon's
//       segments close to cfg.maxLatencyMs long instead of one segment per
//       ". "-terminated fragment.
//   (b) cfg.maxLatencyMs has elapsed with NO complete sentence at all —
//       force a mid-sentence provisional cut so text is never held forever
//       waiting for punctuation that may not come.
// Both branches gate on the same clock, so (a) can never starve: whatever
// isn't flushed by (a) because it never gets a boundary is still bounded by
// the identical deadline in (b).
//
// The block clock RESTARTS on every branch-(a) flush: a leftover
// half-sentence that survives a flush begins a fresh cfg.maxLatencyMs window
// rather than inheriting the just-expired one. (An earlier version of this
// file preserved each piece's original arrival time across a flush so the
// cap "kept running" — that was correct back when a boundary alone was
// enough to flush immediately, but once flushing gates on the full block
// duration it means the leftover text is already overdue the instant it
// survives a flush, so it gets cut into its own tiny PROVISIONAL segment on
// the very next tick. That is what turned every block into "block, then a
// stray 2-3 word fragment". Restarting the clock on flush is what makes a
// carried-over partial actually wait out a full block before it's forced
// out mid-sentence.)
//
// If the human edits an open provisional row, releaseProvisional() hands that
// row over: the text it already shows leaves the buffer and only newer text
// goes into the next row.
//
// A provisional segment (emitted only when there is no complete sentence at
// all after the cap fires) is tracked by an ingest-internal `token`, not a
// real segment id — segment id assignment belongs to the store/hook layer.
// See useSermonIngest.ts for how a token is bound to a real segment id.

import { findBoundaries, lastBoundary, splitSentences } from './sentence-split';
import { dedupeOverlap, tail80 } from './overlap-dedupe';

interface Piece {
  text: string;
}

export interface IngestState {
  pieces: Piece[];
  /** When the current block started (first text appended since the last flush/reset), or null while the buffer is empty. See the header comment above: this restarts on every branch-(a) flush. */
  anchorAt: number | null;
  provisionalToken: string | null;
  provisionalSeq: number;
  /** Text last sent for the open provisional row, so an unchanged buffer isn't re-sent on every ~250ms tick. */
  provisionalText: string | null;
  recentTail: string;
}

export interface IngestConfig {
  maxLatencyMs: number;
  /**
   * A block shorter than this many words doesn't flush at the normal deadline
   * — it gets an extra half-window (up to 1.5x maxLatencyMs in total) to
   * grow, so a lone "Amen." or a short sentence before a pause doesn't
   * become a row of its own. Omitted/0 disables the rule.
   */
  minBlockWords?: number;
}

export type IngestEffect =
  | { type: 'emit'; text: string; provisional: false }
  | { type: 'emit'; text: string; provisional: true; token: string }
  | { type: 'updateProvisional'; token: string; text: string }
  | { type: 'completeProvisional'; token: string; text: string };

export interface IngestStep {
  state: IngestState;
  effects: IngestEffect[];
}

export function initIngestState(): IngestState {
  return { pieces: [], anchorAt: null, provisionalToken: null, provisionalSeq: 0, provisionalText: null, recentTail: '' };
}

function bufferText(state: IngestState): string {
  return state.pieces.map(p => p.text).join('');
}

/** True if `sep` is needed between the current buffer and new text (avoids gluing words together across chunk boundaries). */
function needsSpace(pieces: Piece[], nextText: string): boolean {
  if (pieces.length === 0) return false;
  const last = pieces[pieces.length - 1].text;
  if (!last || !nextText) return false;
  if (/\s$/.test(last) || /^\s/.test(nextText)) return false;
  // Punctuation that attaches directly to the preceding word (". Klaar." must
  // not become " . Klaar.") never gets a synthetic space in front of it.
  if (/^[.,!?;:)\]}%…]/.test(nextText)) return false;
  return true;
}

/**
 * Drops fully-consumed pieces and trims the piece that straddles cut index
 * `k` (measured in the joined buffer string) down to its surviving tail.
 * The caller (evaluate's branch (a)) is responsible for restarting
 * `anchorAt` for whatever survives — see the header comment.
 */
function trimPiecesTo(pieces: Piece[], k: number): Piece[] {
  const survivors: Piece[] = [];
  let consumed = 0;
  for (const piece of pieces) {
    const pieceEnd = consumed + piece.text.length;
    if (pieceEnd <= k) {
      // fully consumed by the cut — drop it
      consumed = pieceEnd;
      continue;
    }
    if (consumed >= k) {
      // entirely after the cut — keep whole
      survivors.push(piece);
    } else {
      // straddles the cut — keep only the tail
      const localCut = k - consumed;
      survivors.push({ text: piece.text.slice(localCut) });
    }
    consumed = pieceEnd;
  }
  return survivors;
}

function evaluate(state: IngestState, cfg: IngestConfig, now: number): IngestStep {
  const buf = bufferText(state);
  if (!buf.trim()) {
    return state.anchorAt === null ? { state, effects: [] } : { state: { ...state, anchorAt: null }, effects: [] };
  }

  const lastB = lastBoundary(buf);
  const capExpired = state.anchorAt !== null && now - state.anchorAt >= cfg.maxLatencyMs;

  // (c) A provisional row is open and its sentence has now completed: finish
  // THAT sentence immediately (the row is already on screen, so there is no
  // reason to make it wait), but consume only that one sentence. Any further
  // complete sentences stay buffered and start a fresh block clock, instead of
  // being emitted as extra short rows in the same step (the old behaviour,
  // which is what produced "provisional row + a lone 'Amen.' row").
  if (state.provisionalToken && lastB >= 0) {
    const firstEnd = findBoundaries(buf)[0];
    const sentence = buf.slice(0, firstEnd).trim();
    const survivingPieces = trimPiecesTo(state.pieces, firstEnd);
    return {
      state: {
        ...state,
        pieces: survivingPieces,
        anchorAt: survivingPieces.some(p => p.text.trim()) ? now : null,
        provisionalToken: null,
        provisionalText: null,
        recentTail: tail80(buf.slice(0, firstEnd)),
      },
      effects: [{ type: 'completeProvisional', token: state.provisionalToken, text: sentence }],
    };
  }

  // (a) A complete sentence exists AND the block has reached its target
  // duration — flush everything complete in the buffer as one joined
  // segment. If the target hasn't been reached yet, fall through and wait:
  // more sentences may still accumulate into this same block before the
  // deadline (or before another appendChunk brings the next one in).
  if (lastB >= 0 && capExpired) {
    const head = buf.slice(0, lastB);
    const sentences = splitSentences(head);

    // Too short to stand as its own row: hold it for a further half-window.
    const wordCount = head.trim().split(/\s+/).filter(Boolean).length;
    const minWords = cfg.minBlockWords ?? 0;
    if (wordCount < minWords && now - state.anchorAt! < cfg.maxLatencyMs * 1.5) {
      return { state, effects: [] };
    }

    const survivingPieces = trimPiecesTo(state.pieces, lastB);
    return {
      state: {
        ...state,
        pieces: survivingPieces,
        // Restart the block clock: a surviving partial begins a fresh
        // cfg.maxLatencyMs window rather than inheriting the one that just
        // expired — see the header comment for why this is the actual fix.
        anchorAt: survivingPieces.some(p => p.text.trim()) ? now : null,
        recentTail: tail80(head),
      },
      effects: sentences.length > 0 ? [{ type: 'emit', text: sentences.join(' '), provisional: false }] : [],
    };
  }

  // (b) No complete sentence at all — only act once the cap has expired.
  if (lastB < 0 && capExpired) {
    const text = buf.trim();
    if (state.provisionalToken == null) {
      const token = `p${state.provisionalSeq}`;
      return {
        state: { ...state, provisionalToken: token, provisionalSeq: state.provisionalSeq + 1, provisionalText: text },
        effects: [{ type: 'emit', text, provisional: true, token }],
      };
    }
    // Same provisional row keeps growing — never open a second one, and
    // don't re-send text that hasn't changed since the last update.
    if (text === state.provisionalText) return { state, effects: [] };
    return {
      state: { ...state, provisionalText: text },
      effects: [{ type: 'updateProvisional', token: state.provisionalToken, text }],
    };
  }

  return { state, effects: [] };
}

/**
 * Hands an open provisional row over to the human (they edited it, so
 * canWriteLive() is false). Everything the row already shows is dropped from
 * the buffer; only text that arrived after the row's last update survives, and
 * it starts a fresh block. Without this, every later update/complete effect
 * carries the WHOLE buffer, and the hook's fallback would open a new row
 * containing the text the edited row already has — duplicated blocks.
 */
export function releaseProvisional(state: IngestState, now: number): IngestState {
  if (state.provisionalToken == null) return state;
  const buf = bufferText(state);
  const shown = state.provisionalText ?? '';
  const leadingWs = buf.length - buf.trimStart().length;
  const cut = Math.min(buf.length, leadingWs + shown.length);
  const pieces = trimPiecesTo(state.pieces, cut);
  return {
    ...state,
    pieces,
    anchorAt: pieces.some(p => p.text.trim()) ? now : null,
    provisionalToken: null,
    provisionalText: null,
    recentTail: tail80(buf.slice(0, cut)),
  };
}

/** Append newly-arrived corrected ASR text (one chunk) to the buffer and evaluate the flush triggers. */
export function appendChunk(state: IngestState, rawText: string, cfg: IngestConfig, now: number): IngestStep {
  // Compare against the tail of whatever is still sitting unflushed in the
  // buffer when there is any — recentTail only reflects the text as of the
  // last branch-(a) flush, so within a still-open block it would miss an
  // overlap against a chunk that arrived after that flush but before this one.
  const currentTail = state.pieces.length > 0 ? tail80(bufferText(state)) : state.recentTail;
  const deduped = dedupeOverlap(currentTail, rawText);
  if (!deduped.trim()) return { state, effects: [] };

  const sep = needsSpace(state.pieces, deduped) ? ' ' : '';
  const pieces = [...state.pieces, { text: sep + deduped }];
  // Anchor the block clock on the first text of a new block only — an
  // already-running block's clock is untouched by later chunks arriving
  // into it (that's what makes the block duration ~cfg.maxLatencyMs rather
  // than restarting on every chunk).
  const anchorAt = state.anchorAt ?? now;
  return evaluate({ ...state, pieces, anchorAt }, cfg, now);
}

/** Re-evaluate the flush triggers with no new text — call this on a ~250ms interval so the cap fires even mid-sentence. */
export function tick(state: IngestState, cfg: IngestConfig, now: number): IngestStep {
  return evaluate(state, cfg, now);
}
