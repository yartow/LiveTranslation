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
import { sameWords } from '@/lib/sermon/markdown';
import type { buildListenerConfig } from '@/lib/listener-languages';

/** The `config` message the hub wants (which extra languages phones may pick, and how each is translated). */
export type ListenerConfigMessage = ReturnType<typeof buildListenerConfig>;

export interface PublishedEntry {
  text: string;
  /** Position last sent: a song inserted above (REPLACE_WITH_LYRICS) moves the rows after it. */
  index?: number;
  /** The last published version was the operator's own typing. */
  manual: boolean;
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
export function computeBatch(
  state: SegmentStoreState,
  published: Map<string, PublishedEntry>,
  force: boolean,
): Array<{ id: string; index: number; text: string; edited: boolean }> {
  const batch: Array<{ id: string; index: number; text: string; edited: boolean }> = [];
  for (const line of selectPublishableLines(state)) {
    const prev = published.get(line.id);
    if (!prev) {
      published.set(line.id, { text: line.text, index: line.index, manual: line.manual, edited: false });
      batch.push({ id: line.id, index: line.index, text: line.text, edited: false });
    } else if (prev.text !== line.text) {
      // Typing a translation from scratch sends a stream of changing texts; only a
      // revision of something already shown as finished (machine text, or a line
      // that was already complete) reads as "edited" (italic) on the phone.
      // Adding markdown (`> ` before a quote, `**bold**`) changes how the line looks, not what it says:
      // not italic, and the line keeps counting as what it was (a finished machine line stays one, so a
      // later change of words to it is still a revision).
      const formattingOnly = sameWords(prev.text, line.text);
      const stillDrafting = prev.manual && line.manual;
      const edited = prev.edited || (!stillDrafting && !formattingOnly);
      published.set(line.id, { text: line.text, index: line.index, manual: formattingOnly ? prev.manual : line.manual, edited });
      batch.push({ id: line.id, index: line.index, text: line.text, edited });
    } else if (force || prev.index !== line.index) {
      published.set(line.id, { ...prev, index: line.index });
      batch.push({ id: line.id, index: line.index, text: line.text, edited: prev.edited });
    }
  }
  return batch;
}

/**
 * Ids in `batch` that the operator typed by hand (manualOverride). The hub debounces translating those into
 * the other listener languages until the typing stops; a finished machine line is translated at once. A
 * hint that rides on the `publish` message only — it is never part of a line and never reaches a phone.
 */
export function draftingIds(batch: ReadonlyArray<{ id: string }>, state: SegmentStoreState): string[] {
  if (batch.length === 0) return [];
  const manual = new Set<string>();
  for (const line of selectPublishableLines(state)) if (line.manual) manual.add(line.id);
  return batch.filter(b => manual.has(b.id)).map(b => b.id);
}

export interface ListenerBroadcastInfo {
  listenerCount: number;
  /** Phones per language ({en, hi, ta, zh, 'zh-TW'}), as the hub counts them. */
  listenersByLang: Record<string, number>;
  /** Languages whose translation is failing right now -> short reason (e.g. "API key missing or invalid"). */
  translationErrors: Record<string, string>;
}

/**
 * `enabled` is the operator's "send to listeners" switch (SermonToolbar). While
 * off nothing is published and `published` is not advanced, so switching back
 * on sends everything translated or typed in the meantime in one go. It is
 * independent of recording: stopping the microphone never stops the broadcast.
 */
export function useListenerBroadcast(
  stateRef: React.MutableRefObject<SegmentStoreState>,
  state: SegmentStoreState,
  enabled: boolean = true,
  config?: ListenerConfigMessage,
): ListenerBroadcastInfo {
  const [listenerCount, setListenerCount] = useState(0);
  const [listenersByLang, setListenersByLang] = useState<Record<string, number>>({});
  const [translationErrors, setTranslationErrors] = useState<Record<string, string>>({});
  const configJson = config ? JSON.stringify(config) : '';
  const configJsonRef = useRef(configJson);
  configJsonRef.current = configJson;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // Set when the socket (re)connected while paused: the full resync (see onopen) is owed until sending resumes.
  const needsSyncRef = useRef(false);
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
        // Languages first, so the hub knows what to translate before the backlog arrives.
        if (configJsonRef.current) ws.send(configJsonRef.current);
        // Full resync — see computeBatch's `force` doc comment. A 'sync'
        // REPLACES the hub's backlog (even with an empty batch): after a page
        // reload this operator has a fresh session, and merging it into the
        // previous page's leftovers would leave old text on every phone.
        if (!enabledRef.current) { needsSyncRef.current = true; return; }
        needsSyncRef.current = false;
        const batch = computeBatch(stateRef.current, publishedRef.current, true);
        ws.send(JSON.stringify({ type: 'sync', lines: batch }));
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
          if (msg?.type === 'listenerCount' && typeof msg.count === 'number') {
            setListenerCount(msg.count);
            if (msg.byLang && typeof msg.byLang === 'object') setListenersByLang(msg.byLang);
          } else if (msg?.type === 'translationStatus' && typeof msg.lang === 'string') {
            setTranslationErrors(prev => {
              const next = { ...prev };
              if (msg.ok) delete next[msg.lang];
              else next[msg.lang] = typeof msg.error === 'string' ? msg.error : 'Translation failed';
              return next;
            });
          }
        } catch {
          // Ignore malformed messages — the hub never sends anything else on
          // this channel, but a stray/future message type must not crash it.
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        setListenerCount(0);
        setListenersByLang({});
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

  // The operator changed which languages are offered (or how they are translated): tell the hub right away.
  // Debounced: typing a model name in Settings must not re-send (and re-translate) for every keystroke.
  useEffect(() => {
    if (!configJson) return;
    const timer = setTimeout(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(configJson);
    }, 800);
    return () => clearTimeout(timer);
  }, [configJson]);

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

    if (!enabled) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (needsSyncRef.current) {
      needsSyncRef.current = false;
      ws.send(JSON.stringify({ type: 'sync', lines: computeBatch(state, publishedRef.current, true) }));
      return;
    }
    const batch = computeBatch(state, publishedRef.current, false);
    if (batch.length > 0) {
      const drafting = draftingIds(batch, state);
      ws.send(JSON.stringify({ type: 'publish', lines: batch, ...(drafting.length > 0 ? { drafting } : {}) }));
    }
  }, [state, enabled]);

  return { listenerCount, listenersByLang, translationErrors };
}
