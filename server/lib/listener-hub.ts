// Listener mode's WebSocket endpoints — lets phones on the LAN follow the sermon live, without seeing the
// Dutch source or the operator console. See CLAUDE.md "Listener mode" for the full design.
//
// This file is only the socket wiring: the English line store lives in listener-lines.ts (re-exported
// below, where the trust boundary is documented), the per-connection message handling in
// listener-room.ts and the translation into Hindi/Tamil/Chinese in listener-translate.ts.
//
// One in-memory room, deliberately not session-scoped: this app is built for one preacher on one MBP
// running one service at a time (see "Sermon mode" in CLAUDE.md), so there is exactly one broadcaster
// and any number of listeners. If a future need for concurrent independent services arises, that is a
// conscious redesign (a room id in the URL), not a bug fix here.
//
// Also NOT an authentication boundary — see CLAUDE.md: anyone who can reach the server on the LAN and
// knows (or guesses) /ws/sermon-listen can read the transcript. That is the intended behaviour for this
// feature. The one thing a LAN device may NOT do is switch translation on: the `config` message (which
// spends API keys) is honoured only from the operator's own machine (isOperatorRequest).

import { WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import { isOperatorRequest } from './loopback';
import { ListenerRoom, type Send } from './listener-room';
import { fileGlossary } from './listener-glossary';
import { listenerScriptureText } from './listener-scripture';
import type { ListenerTranslationLogEntry, TranslateRequest } from './listener-translate';

export * from './listener-lines';

// The provider plumbing and the session archive are imported on first use, so loading this file (and the
// unit tests that import it) never pulls in the OpenAI/Anthropic clients.
function translateWithProvider(req: TranslateRequest): Promise<string[]> {
  return import('./listener-translate-provider').then(m => m.providerTranslate(req));
}

function logListenerTranslation(entry: ListenerTranslationLogEntry): void {
  import('./session-archive').then(m => m.logListenerTranslation(entry)).catch(() => {});
}

// Module-level singleton room — see the header comment for why this is intentionally not per-session.
const room = new ListenerRoom({ translate: translateWithProvider, log: logListenerTranslation, glossary: fileGlossary, scriptureText: listenerScriptureText });

// Phones never learn that a connection died silently (server restart, phone
// asleep, wifi handover — no 'close' event ever fires), so the hub sends a
// small app-level heartbeat; ListenerMode.tsx reconnects when it goes quiet.
const HEARTBEAT_MS = 15_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => room.ping(), HEARTBEAT_MS);
  // Never keep the process alive just for the heartbeat.
  heartbeatTimer.unref?.();
}

function senderFor(ws: WsWebSocket): Send {
  return (payload: unknown) => {
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
  };
}

function parseMessage(data: Buffer | string, isBinary: boolean): unknown {
  if (isBinary) return null;
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  return JSON.parse(text);
}

let nextListenerId = 1;

/**
 * Registers the two listener-mode WebSocket endpoints on their respective
 * (already-created) WebSocketServer instances — mirrors
 * chunk-transcription.ts's setupChunkTranscriptionWebSocket, wired up
 * alongside it in server/index.ts's upgrade handler.
 *
 * wssBroadcast: the operator's SermonMode page (useListenerBroadcast.ts) —
 * publishes English lines as they finish translating, and says which extra languages are offered.
 * wssListen: listener phones (ListenerMode.tsx) — receive a snapshot on
 * connect, then incremental updates in the language they pick.
 */
export function setupListenerWebSockets(wssBroadcast: WebSocketServer, wssListen: WebSocketServer): void {
  startHeartbeat();

  wssBroadcast.on('connection', (ws: WsWebSocket, req) => {
    const send = senderFor(ws);
    const operator = isOperatorRequest(req?.socket?.remoteAddress);
    // useListenerBroadcast.ts sends `config` and then SYNCS its full known set on every connect (see
    // applySync), so the hub's content is never stale after a takeover.
    room.setBroadcaster(send);

    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      try {
        const message = parseMessage(data, isBinary);
        if (message) room.onBroadcasterMessage(message, { operator });
      } catch (err) {
        // Malformed JSON from the broadcaster must never take the hub (or
        // the WebSocket server) down — same never-throw discipline as
        // glossary-store.ts.
        console.warn('[listener-hub] Ignoring malformed broadcaster message:', err);
      }
    });
    ws.on('close', () => room.clearBroadcaster(send));
    ws.on('error', (err) => {
      console.warn('[listener-hub] Broadcaster socket error:', err);
    });
  });

  wssListen.on('connection', (ws: WsWebSocket) => {
    const id = String(nextListenerId++);
    room.addListener(id, senderFor(ws));

    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      try {
        const message = parseMessage(data, isBinary);
        if (message) room.onListenerMessage(id, message);
      } catch {
        // A phone sending garbage is ignored.
      }
    });
    ws.on('close', () => room.removeListener(id));
    ws.on('error', (err) => {
      console.warn('[listener-hub] Listener socket error:', err);
    });
  });
}
