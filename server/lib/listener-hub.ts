// Listener mode's broadcast relay — lets phones on the LAN follow the
// English translation live, without seeing the Dutch source or the operator
// console. See CLAUDE.md "Listener mode" and the plan doc's "Listener mode:
// English-only view for phones on the LAN" for the full design.
//
// One in-memory room, deliberately not session-scoped: this app is built for
// one preacher on one MBP running one service at a time (see "Sermon mode" in
// CLAUDE.md), so there is exactly one broadcaster and any number of
// listeners. If a future need for concurrent independent services arises,
// that is a conscious redesign (a room id in the URL), not a bug fix here.
//
// TRUST BOUNDARY: ListenerLine has exactly four fields — id, index, text,
// edited — and nothing else. That is what makes "no Dutch ever reaches a
// listener" a structural property rather than a discipline the caller has to
// maintain: toListenerLine() below reconstructs every incoming line
// field-by-field, so even if the operator's browser were ever tricked into
// sending a raw segment object (which has a sourceText field), that field is
// simply not among the ones copied out. The English guarantee itself still
// rests on the client only ever calling selectPublishableLines()
// (segment-store.ts), which reads translatedText — this hub has no way to
// verify what language `text` is actually written in.
//
// Also NOT an authentication boundary — see CLAUDE.md: anyone who can reach
// the server on the LAN and knows (or guesses) /ws/sermon-listen can read the
// transcript. That is the intended behaviour for this feature.
//
// The pure data functions below (toListenerLine/applyPublish/applyClear/
// snapshot) take an explicit HubState rather than closing over module state,
// the same separation chunk-transcription.ts uses for flushInOrder/
// ChunkSessionForTest — it's what makes them directly unit-testable. Only
// setupListenerWebSockets wires that pure core up to real sockets.

import { WebSocket as WsWebSocket, WebSocketServer } from 'ws';

export interface ListenerLine {
  id: string;
  index: number;
  /** English only. */
  text: string;
  /** True once this line's text has changed since it was first published — the phone renders it italic. */
  edited: boolean;
}

export interface HubState {
  lines: Map<string, ListenerLine>;
}

export function createHubState(): HubState {
  return { lines: new Map() };
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

/** Wipes the backlog — called on CLEAR_ALL (a new service starting), so a phone connecting afterwards doesn't see a stale sermon. */
export function applyClear(state: HubState): void {
  state.lines.clear();
}

/** All known lines, ordered for display — what a newly-connecting listener gets as its initial 'snapshot'. */
export function snapshot(state: HubState): ListenerLine[] {
  // Array.from, not [...state.lines.values()] — this repo's tsconfig has no
  // explicit `target`, which defaults tsc to ES3 and rejects iterating a Map
  // iterator without --downlevelIteration (see bible-ref.ts's header comment
  // for the same ES3-default gotcha with regex flags).
  return Array.from(state.lines.values()).sort((a, b) => a.index - b.index);
}

// Module-level singleton room — see the header comment for why this is
// intentionally not per-session.
const hubState = createHubState();
const listeners = new Set<WsWebSocket>();
let broadcaster: WsWebSocket | null = null;

function send(ws: WsWebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    // A send failing (e.g. the socket closed between the readyState check and
    // .send()) is not this module's problem to escalate — the 'close'
    // listener registered where the socket was accepted is what cleans up
    // state. Never let a single bad send take the hub down.
    console.warn('[listener-hub] send failed:', err);
  }
}

function broadcastToListeners(payload: unknown): void {
  // Array.from — see snapshot()'s comment on this repo's ES3-default target.
  for (const ws of Array.from(listeners)) send(ws, payload);
}

function notifyListenerCount(): void {
  if (broadcaster) send(broadcaster, { type: 'listenerCount', count: listeners.size });
}

/**
 * Registers the two listener-mode WebSocket endpoints on their respective
 * (already-created) WebSocketServer instances — mirrors
 * chunk-transcription.ts's setupChunkTranscriptionWebSocket, wired up
 * alongside it in server/index.ts's upgrade handler.
 *
 * wssBroadcast: the operator's SermonMode page (useListenerBroadcast.ts) —
 * publishes English lines as they finish translating.
 * wssListen: listener phones (ListenerMode.tsx) — receive a snapshot on
 * connect, then incremental updates.
 */
export function setupListenerWebSockets(wssBroadcast: WebSocketServer, wssListen: WebSocketServer): void {
  wssBroadcast.on('connection', (ws: WsWebSocket) => {
    // A page reload/HMR on the operator side opens a new broadcaster socket
    // before the old one's 'close' fires — simply take over as the current
    // broadcaster. useListenerBroadcast.ts republishes its full known set on
    // every connect, so the hub's content is never stale after a takeover.
    broadcaster = ws;
    notifyListenerCount();

    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        const message = JSON.parse(text);

        if (message?.type === 'publish' && Array.isArray(message.lines)) {
          const accepted = applyPublish(hubState, message.lines);
          if (accepted.length > 0) broadcastToListeners({ type: 'update', lines: accepted });
        } else if (message?.type === 'clear') {
          applyClear(hubState);
          broadcastToListeners({ type: 'clear' });
        }
      } catch (err) {
        // Malformed JSON from the broadcaster must never take the hub (or
        // the WebSocket server) down — same never-throw discipline as
        // glossary-store.ts.
        console.warn('[listener-hub] Ignoring malformed broadcaster message:', err);
      }
    });

    ws.on('close', () => {
      if (broadcaster === ws) broadcaster = null;
    });
    ws.on('error', (err) => {
      console.warn('[listener-hub] Broadcaster socket error:', err);
    });
  });

  wssListen.on('connection', (ws: WsWebSocket) => {
    listeners.add(ws);
    send(ws, { type: 'snapshot', lines: snapshot(hubState) });
    notifyListenerCount();

    ws.on('close', () => {
      listeners.delete(ws);
      notifyListenerCount();
    });
    ws.on('error', (err) => {
      console.warn('[listener-hub] Listener socket error:', err);
    });
  });
}
