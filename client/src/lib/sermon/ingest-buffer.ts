// The live-ingest flush state machine (plan §3). Pure and framework-free:
// driven from a ref inside useSermonIngest, not React state, because it
// needs synchronous read-modify-write on every incoming chunk of corrected
// ASR text and on every ~250ms cap-timer tick.
//
// Two triggers decide when buffered text becomes a segment:
//   (a) a complete sentence boundary appears in the buffer — the normal path
//   (b) cfg.maxLatencyMs has elapsed since the OLDEST unflushed text arrived,
//       even mid-sentence — a latency ceiling, not a batch size
//
// The tricky requirement from the spec: when the cap fires mid-sentence, we
// cut at the last complete sentence boundary and the leftover half-sentence
// carries over to the next batch WITHOUT resetting its clock. That is why
// the buffer is a list of timestamped `pieces` rather than one string with a
// single `lastFlushAt` — each surviving piece keeps the arrival time it had
// when it first appeared, so the cap timer measured against the *oldest*
// surviving text keeps running across a cap-flush.
//
// A provisional segment (emitted only when there is no complete sentence at
// all after the cap fires) is tracked by an ingest-internal `token`, not a
// real segment id — segment id assignment belongs to the store/hook layer.
// See useSermonIngest.ts for how a token is bound to a real segment id.

import { lastBoundary, splitSentences } from './sentence-split';
import { dedupeOverlap, tail80 } from './overlap-dedupe';

interface Piece {
  text: string;
  at: number;
}

export interface IngestState {
  pieces: Piece[];
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
  return { pieces: [], provisionalToken: null, provisionalSeq: 0, recentTail: '' };
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
 * `k` (measured in the joined buffer string) down to its surviving tail —
 * crucially, the surviving tail KEEPS the original piece's `at`, which is
 * the mechanism that makes the cap timer not reset on a carried-over
 * partial sentence.
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
      // entirely after the cut — keep whole, same `at`
      survivors.push(piece);
    } else {
      // straddles the cut — keep only the tail, same `at`
      const localCut = k - consumed;
      survivors.push({ text: piece.text.slice(localCut), at: piece.at });
    }
    consumed = pieceEnd;
  }
  return survivors;
}

function evaluate(state: IngestState, cfg: IngestConfig, now: number): IngestStep {
  const buf = bufferText(state);
  if (!buf.trim()) return { state, effects: [] };

  const lastB = lastBoundary(buf);
  const anchor = state.pieces[0]?.at ?? null;
  const capExpired = anchor !== null && now - anchor >= cfg.maxLatencyMs;

  // (a) A complete sentence exists — always flush it, regardless of the cap.
  if (lastB >= 0) {
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
    for (const s of sentences) {
      effects.push({ type: 'emit', text: s, provisional: false });
    }

    return {
      state: {
        ...state,
        pieces: survivingPieces,
        provisionalToken,
        recentTail: tail80(head),
      },
      effects,
    };
  }

  // (b) No complete sentence at all — only act once the cap has expired.
  if (capExpired) {
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
  const pieces = [...state.pieces, { text: sep + deduped, at: now }];
  return evaluate({ ...state, pieces }, cfg, now);
}

/** Re-evaluate the flush triggers with no new text — call this on a ~250ms interval so the cap fires even mid-sentence. */
export function tick(state: IngestState, cfg: IngestConfig, now: number): IngestStep {
  return evaluate(state, cfg, now);
}
