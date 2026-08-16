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
// A provisional segment (emitted only when there is no complete sentence at
// all after the cap fires) is tracked by an ingest-internal `token`, not a
// real segment id — segment id assignment belongs to the store/hook layer.
// See useSermonIngest.ts for how a token is bound to a real segment id.

import { lastBoundary, splitSentences } from './sentence-split';
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
  recentTail: string;
}

export interface IngestConfig {
  maxLatencyMs: number;
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
  return { pieces: [], anchorAt: null, provisionalToken: null, provisionalSeq: 0, recentTail: '' };
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

  // (a) A complete sentence exists AND the block has reached its target
  // duration — flush everything complete in the buffer as one joined
  // segment. If the target hasn't been reached yet, fall through and wait:
  // more sentences may still accumulate into this same block before the
  // deadline (or before another appendChunk brings the next one in).
  if (lastB >= 0 && capExpired) {
    const head = buf.slice(0, lastB);
    const survivingPieces = trimPiecesTo(state.pieces, lastB);
    let sentences = splitSentences(head);

    const effects: IngestEffect[] = [];
    let provisionalToken = state.provisionalToken;

    if (provisionalToken && sentences.length > 0) {
      // The sentence that was running provisional has now completed.
      effects.push({ type: 'completeProvisional', token: provisionalToken, text: sentences[0] });
      sentences = sentences.slice(1);
      provisionalToken = null;
    }
    if (sentences.length > 0) {
      effects.push({ type: 'emit', text: sentences.join(' '), provisional: false });
    }

    return {
      state: {
        ...state,
        pieces: survivingPieces,
        // Restart the block clock: a surviving partial begins a fresh
        // cfg.maxLatencyMs window rather than inheriting the one that just
        // expired — see the header comment for why this is the actual fix.
        anchorAt: survivingPieces.length > 0 ? now : null,
        provisionalToken,
        recentTail: tail80(head),
      },
      effects,
    };
  }

  // (b) No complete sentence at all — only act once the cap has expired.
  if (lastB < 0 && capExpired) {
    if (state.provisionalToken == null) {
      const token = `p${state.provisionalSeq}`;
      return {
        state: { ...state, provisionalToken: token, provisionalSeq: state.provisionalSeq + 1 },
        effects: [{ type: 'emit', text: buf.trim(), provisional: true, token }],
      };
    }
    // Same provisional row keeps growing — never open a second one.
    return {
      state,
      effects: [{ type: 'updateProvisional', token: state.provisionalToken, text: buf.trim() }],
    };
  }

  return { state, effects: [] };
}

/** Append newly-arrived corrected ASR text (one chunk) to the buffer and evaluate the flush triggers. */
export function appendChunk(state: IngestState, rawText: string, cfg: IngestConfig, now: number): IngestStep {
  const deduped = dedupeOverlap(state.recentTail, rawText);
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
