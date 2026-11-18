// Listener mode's phone view — CLAUDE.md "Listener mode". Route "/listen"
// (App.tsx). The translation only (English, or another language the operator offers — picked in the
// header or with /listen?lang=hi), read-only, auto-scrolling. Never the Dutch.
//
// Deliberately standalone: no Header, no SettingsDialog, no useSettings, no
// mic. This page never touches the operator's settings/recording machinery
// — importing any of that here would be a maintenance trap (a listener's
// phone has no business knowing about API keys or the glossary). It talks to
// the server over exactly one channel, /ws/sermon-listen, wired up by
// server/lib/listener-hub.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import ListenerMarkdown from '@/components/listener/ListenerMarkdown';
import {
  LISTENER_LANGUAGE_INFO, LISTENER_LANG_STORAGE_KEY, LISTENER_UI,
  initialListenerLang, isListenerLang, resolveListenerLang, type ListenerLang,
} from '@/lib/listener-languages';

/** Mirrors server/lib/listener-lines.ts's ListenerLine — client/server share no code, see sermon-prompt.ts's header comment for the established pattern of documenting these mirrors explicitly. */
interface ListenerLine {
  id: string;
  index: number;
  text: string;
  edited: boolean;
}

type ConnectionState = 'connecting' | 'connected' | 'reconnecting';

// Same doubling backoff shape used throughout the client (see
// chunk-based-transcription.ts's reconnectWs and useListenerBroadcast.ts), but
// capped lower: a phone waiting on a restarting server should be back within
// seconds of it returning, and a reconnect attempt costs next to nothing.
function backoffDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 10_000);
}

// A socket that died silently (server restart, phone asleep, wifi handover)
// never fires 'close', so it would sit on "Connected" showing stale text. The
// hub sends a {type:'ping'} every 15 s (listener-hub.ts); if nothing at all has
// arrived for STALE_MS the connection is treated as dead and replaced. When the
// phone wakes up / comes back online we are stricter (RESUME_STALE_MS), since
// one missed heartbeat is already proof.
const STALE_MS = 40_000;
const RESUME_STALE_MS = 20_000;
const WATCHDOG_MS = 5_000;

// Distance (px) from the bottom of the scroll container within which we
// still consider the listener "at the live edge" — used both to decide when
// new lines should auto-scroll, and to silently re-engage auto-follow if the
// listener scrolls back down themselves (not just via the button).
const LIVE_EDGE_PX = 48;
const FOLLOW_DISENGAGE_PX = 120;

function readStoredLang(): string | null {
  try { return localStorage.getItem(LISTENER_LANG_STORAGE_KEY); } catch { return null; }
}

export default function ListenerMode() {
  const [linesById, setLinesById] = useState<Record<string, ListenerLine>>({});
  // The language the phone shows. Starts on English: the hub says which others are on offer (`languages`),
  // and only then does the phone switch to what it asked for (?lang= or the remembered choice).
  const [lang, setLang] = useState<ListenerLang>('en');
  const [offered, setOffered] = useState<string[]>([]);
  const langRef = useRef<ListenerLang>('en');
  const hubLangRef = useRef<ListenerLang>('en'); // what the hub believes this socket reads — it starts every connection on English
  const offeredRef = useRef<string[]>([]);
  const wantedRef = useRef<ListenerLang>(initialListenerLang(window.location.search, readStoredLang()));
  const info = LISTENER_LANGUAGE_INFO[lang];
  const ui = LISTENER_UI[lang];
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [following, setFollowing] = useState(true);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);

  const orderedLines = useMemo(
    () => Object.values(linesById).sort((a, b) => a.index - b.index),
    [linesById],
  );

  // Show `next` and, when it is not what the hub is sending this socket, ask for it.
  const applyLanguage = useCallback((next: ListenerLang) => {
    langRef.current = next;
    setLang(next);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && hubLangRef.current !== next) {
      ws.send(JSON.stringify({ type: 'setLanguage', lang: next }));
      hubLangRef.current = next;
    }
  }, []);

  const chooseLanguage = useCallback((value: string) => {
    if (!isListenerLang(value)) return;
    wantedRef.current = value;
    try { localStorage.setItem(LISTENER_LANG_STORAGE_KEY, value); } catch { /* private mode: it just isn't remembered */ }
    applyLanguage(resolveListenerLang(value, offeredRef.current));
  }, [applyLanguage]);

  useEffect(() => {
    document.documentElement.lang = info.htmlLang;
  }, [info.htmlLang]);

  // Dark by default — best contrast in a dim sanctuary (design_guidelines.md
  // "Readability first"). Unlike SermonMode there is no toggle here; a
  // listener has nothing to configure.
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  useEffect(() => {
    closedRef.current = false;
    let lastMessageAt = Date.now();

    function detach(ws: WebSocket) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch { /* already closed */ }
    }

    function connect() {
      if (closedRef.current) return;
      setConnection(prev => (prev === 'connecting' ? prev : 'reconnecting'));
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws/sermon-listen`);
      wsRef.current = ws;
      lastMessageAt = Date.now();

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
        lastMessageAt = Date.now();
        hubLangRef.current = 'en'; // every connection starts on English; `languages` follows at once
        setConnection('connected');
      };
      ws.onmessage = (evt) => {
        lastMessageAt = Date.now();
        let msg: any;
        try {
          msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
        } catch {
          return;
        }
        if (msg?.type === 'languages' && Array.isArray(msg.enabled)) {
          const list = msg.enabled.filter((l: unknown) => isListenerLang(l) && l !== 'en') as string[];
          offeredRef.current = list;
          setOffered(list);
          // Go to the wanted language when it is on offer (or back to English when it no longer is).
          const target = resolveListenerLang(wantedRef.current, list);
          if (target !== hubLangRef.current || target !== langRef.current) applyLanguage(target);
        } else if (msg?.type === 'snapshot' && Array.isArray(msg.lines)) {
          // Only what is in the language on screen: a late message for the one just left is dropped.
          if ((msg.lang ?? 'en') !== langRef.current) return;
          const next: Record<string, ListenerLine> = {};
          for (const line of msg.lines) next[line.id] = line;
          setLinesById(next);
        } else if (msg?.type === 'update' && Array.isArray(msg.lines)) {
          if ((msg.lang ?? 'en') !== langRef.current) return;
          setLinesById(prev => {
            const next = { ...prev };
            for (const line of msg.lines) next[line.id] = line;
            return next;
          });
        } else if (msg?.type === 'clear') {
          setLinesById({});
        }
        // {type:'ping'} needs nothing beyond the lastMessageAt update above.
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (closedRef.current) return;
        if (wsRef.current === ws) wsRef.current = null;
        setConnection('reconnecting');
        const delay = backoffDelay(reconnectAttemptsRef.current);
        reconnectAttemptsRef.current++;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    }

    // Drop whatever socket exists (it may be half-dead) and open a fresh one
    // right away; the new connection's snapshot replaces the whole view.
    function reconnectNow() {
      if (closedRef.current) return;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (wsRef.current) { detach(wsRef.current); wsRef.current = null; }
      reconnectAttemptsRef.current = 0;
      connect();
    }

    function checkAfterResume() {
      if (document.visibilityState === 'hidden') return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - lastMessageAt > RESUME_STALE_MS) reconnectNow();
    }

    connect();

    const watchdog = setInterval(() => {
      if (wsRef.current && Date.now() - lastMessageAt > STALE_MS) reconnectNow();
    }, WATCHDOG_MS);
    document.addEventListener('visibilitychange', checkAfterResume);
    window.addEventListener('online', checkAfterResume);
    window.addEventListener('pageshow', checkAfterResume);

    return () => {
      closedRef.current = true;
      clearInterval(watchdog);
      document.removeEventListener('visibilitychange', checkAfterResume);
      window.removeEventListener('online', checkAfterResume);
      window.removeEventListener('pageshow', checkAfterResume);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [applyLanguage]);

  // Auto-scroll to the newest line whenever the ordered set changes, but
  // only while following — a listener who scrolled up to re-read something
  // must not get yanked back down by the next incoming line.
  useEffect(() => {
    if (!following) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [orderedLines, following]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > FOLLOW_DISENGAGE_PX) {
      setFollowing(false);
    } else if (distanceFromBottom <= LIVE_EDGE_PX) {
      // Re-engage automatically if the listener scrolls back down by hand,
      // not only via the "jump to live" button.
      setFollowing(true);
    }
  }, []);

  const jumpToLive = useCallback(() => {
    setFollowing(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 border-b border-border">
        <span className="text-sm font-medium text-muted-foreground">{ui.title}</span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {offered.length > 0 && (
            <select
              value={lang}
              onChange={(e) => chooseLanguage(e.target.value)}
              aria-label={ui.language}
              data-testid="select-listener-language"
              className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground"
            >
              {(['en', ...offered] as ListenerLang[]).map(code => (
                <option key={code} value={code}>{LISTENER_LANGUAGE_INFO[code].native}</option>
              ))}
            </select>
          )}
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {connection === 'connected' ? (
              <>
                <Wifi className="w-3.5 h-3.5" />
                {ui.connected}
              </>
            ) : (
              <>
                <WifiOff className="w-3.5 h-3.5 animate-pulse" />
                {connection === 'connecting' ? ui.connecting : ui.reconnecting}
              </>
            )}
          </span>
          {/* A full reload, not just a reconnect: it also picks up a newer
              version of this page after the operator restarted the app. */}
          <button
            onClick={() => window.location.reload()}
            aria-label={ui.refresh}
            data-testid="button-refresh"
            className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {ui.refresh}
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-6"
      >
        <div className="max-w-prose mx-auto space-y-4" lang={info.htmlLang}>
          {orderedLines.length === 0 ? (
            <p className="text-muted-foreground text-center text-sm mt-12">
              {ui.waiting}
            </p>
          ) : (
            orderedLines.map(line => (
              <ListenerMarkdown
                key={line.id}
                text={line.text}
                className={
                  `text-xl sm:text-2xl ${info.leading} ` +
                  (line.edited && info.italicForEdited ? 'italic text-foreground/90' : 'text-foreground')
                }
              />
            ))
          )}
        </div>
      </div>

      {!following && (
        <button
          onClick={jumpToLive}
          data-testid="button-jump-to-live"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-border bg-primary text-primary-foreground px-4 py-2 text-sm font-medium"
        >
          <ArrowDown className="w-4 h-4" />
          {ui.jumpToLive}
        </button>
      )}
    </div>
  );
}
