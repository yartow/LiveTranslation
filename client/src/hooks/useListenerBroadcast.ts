// Operator-side publisher for listener mode (CLAUDE.md "Listener mode") —
// pushes finished translations to server/lib/listener-hub.ts over
// /ws/sermon-broadcast, so ListenerMode.tsx (running on a listener's phone)
// can render them. Called once from SermonMode.tsx, alongside
// useTranslationQueue/useSermonIngest.
//
// Deliberately reads ONLY selectPublishableLines(state) (segment-store.ts)
// — translatedText, never sourceText. See listener-hub.ts's header comment
// for the full trust-boundary rationale; this hook is the client half of it.

import { useEffect, useRef, useState } from 'react';
import { selectPublishableLines, type SegmentStoreState } from '@/lib/sermon/segment-store';

interface PublishedEntry {
  text: string;
  /** Sticky once true — a line that has ever changed stays "edited" (renders italic on the phone) even across a reconnect. */
  edited: boolean;
}

/** Same reconnect backoff shape as chunk-based-transcription.ts's reconnectWs — doubling from 1s, capped at 30s. */
function backoffDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30_000);
}

/**
 * Builds the wire batch for the current publishable lines against what was
 * last sent, and updates `published` in place.
 *
 * `force`: when true (on a fresh socket connect), every currently
 * publishable line is included even if unchanged since last sent — this is
 * what makes a reconnect a full resync rather than a diff, so the hub can
 * never end up missing lines after a broadcaster takeover or a server
 * restart (see listener-hub.ts's header comment on takeover). When false
 * (the normal live path), only new or changed lines are sent, which is what
 * keeps the socket quiet while nothing is happening.
 */
function computeBatch(
  state: SegmentStoreState,
  published: Map<string, PublishedEntry>,
  force: boolean,
): Array<{ id: string; index: number; text: string; edited: boolean }> {
  const batch: Array<{ id: string; index: number; text: string; edited: boolean }> = [];
  for (const line of selectPublishableLines(state)) {
    const prev = published.get(line.id);
    if (!prev) {
      published.set(line.id, { text: line.text, edited: false });
      batch.push({ id: line.id, index: line.index, text: line.text, edited: false });
    } else if (prev.text !== line.text) {
      published.set(line.id, { text: line.text, edited: true });
      batch.push({ id: line.id, index: line.index, text: line.text, edited: true });
    } else if (force) {
      batch.push({ id: line.id, index: line.index, text: line.text, edited: prev.edited });
    }
  }
  return batch;
}

export function useListenerBroadcast(stateRef: React.MutableRefObject<SegmentStoreState>, state: SegmentStoreState): { listenerCount: number } {
  const [listenerCount, setListenerCount] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const publishedRef = useRef(new Map<string, PublishedEntry>());
  const sessionIdRef = useRef(state.sessionId);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);

  // Connect once for the component's lifetime; reconnects on its own.
  useEffect(() => {
    closedRef.current = false;

    function connect() {
      if (closedRef.current) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/sermon-broadcast`);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        // Full resync — see computeBatch's `force` doc comment.
        const batch = computeBatch(stateRef.current, publishedRef.current, true);
        if (batch.length > 0) ws.send(JSON.stringify({ type: 'publish', lines: batch }));
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
          if (msg?.type === 'listenerCount' && typeof msg.count === 'number') setListenerCount(msg.count);
        } catch {
          // Ignore malformed messages — the hub never sends anything else on
          // this channel, but a stray/future message type must not crash it.
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        setListenerCount(0);
        if (closedRef.current) return;
        const delay = backoffDelay(reconnectAttemptsRef.current);
        reconnectAttemptsRef.current++;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();
    return () => {
      closedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
    // stateRef is a stable ref object; this effect owns the socket's whole lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live diff-publish on every store change.
  useEffect(() => {
    // CLEAR_ALL (segment-store.ts) assigns a fresh sessionId — treat that as
    // a new service starting: tell the hub to drop its backlog and forget
    // everything we thought we'd already published, so the new service's
    // segments are all treated as first-publish (edited:false) again.
    if (state.sessionId !== sessionIdRef.current) {
      sessionIdRef.current = state.sessionId;
      publishedRef.current.clear();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'clear' }));
      return;
    }

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const batch = computeBatch(state, publishedRef.current, false);
    if (batch.length > 0) ws.send(JSON.stringify({ type: 'publish', lines: batch }));
  }, [state]);

  return { listenerCount };
}
