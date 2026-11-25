// Listener mode's room: the one operator page that publishes, the phones that read, and what each phone
// is sent. Socket-free on purpose — every connection is just a `send` function — so the message handling
// is unit-testable (listener-hub.ts does the WebSocket wiring). CLAUDE.md "Listener mode" has the design.
//
// Messages
//   operator -> room   config {enabled, models, ollamaBaseUrl?, ollamaModel?}   which extra languages are offered
//                      sync {lines, drafting?, scriptures?} | publish {lines, drafting?, scriptures?} | clear
//                      (`drafting` = ids of lines still being typed; used only to debounce translation,
//                      never forwarded to phones. `scriptures` = {lineId: "John 3:16-18"} for lines that are
//                      a verbatim Bible reading: the extra-language phones get the verses from their own
//                      Bible instead of a translation. Also never forwarded; a line left out loses its hint)
//   phone -> room      setLanguage {lang}                                         answered with a snapshot
//   room -> phone      languages {enabled}  snapshot {lang, lines}  update {lang, lines}  clear  ping
//   room -> operator   listenerCount {count, byLang}  translationStatus {lang, ok, error?}
//
// A phone starts on English and only ever receives messages for its own language. English lines pass
// straight through; any other language is produced by listener-translate.ts from the stored English.

import {
  applyClear, applyPublish, applyScriptures, applySync, createHubState, snapshot,
  type HubState, type ListenerLine,
} from './listener-lines';
import {
  EXTRA_LISTENER_LANGUAGES, normalizeConfig, resolveLanguage,
  type ExtraListenerLang, type ListenerLang, type ListenerTranslationConfig,
} from './listener-lang';
import { ListenerTranslator, type EngineDeps } from './listener-translate';

export type Send = (message: unknown) => void;

const MAX_DRAFTING_IDS = 500;

interface ListenerEntry { send: Send; lang: ListenerLang }

export class ListenerRoom {
  readonly state: HubState = createHubState();
  private cfg: ListenerTranslationConfig = normalizeConfig({});
  private listeners = new Map<string, ListenerEntry>();
  private broadcaster: Send | null = null;
  private translator: ListenerTranslator;

  constructor(deps: Omit<EngineDeps, 'emit' | 'onStatus'>) {
    this.translator = new ListenerTranslator(this.state, {
      ...deps,
      emit: (lang, lines) => this.sendToLanguage(lang, { type: 'update', lang, lines }),
      onStatus: (lang, ok, error) => this.sendToBroadcaster({ type: 'translationStatus', lang, ok, ...(error ? { error } : {}) }),
    });
  }

  // ── operator ──

  setBroadcaster(send: Send): void {
    // A page reload/HMR opens the new socket before the old one's 'close' fires — the newest takes over.
    this.broadcaster = send;
    this.notifyCount();
  }

  clearBroadcaster(send: Send): void {
    if (this.broadcaster === send) this.broadcaster = null;
  }

  /**
   * `operator`: the connection comes from the machine the server runs on (or ALLOW_REMOTE_OPERATOR is set).
   * Only that connection may switch translation on — it spends API keys, and anyone on the LAN can open
   * this socket.
   */
  onBroadcasterMessage(message: unknown, ctx: { operator: boolean }): void {
    const msg = message as { type?: unknown; lines?: unknown; drafting?: unknown; scriptures?: unknown } | null;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'config') {
      if (!ctx.operator) { console.warn('[listener-room] Ignoring config from a non-operator connection'); return; }
      this.applyConfig(normalizeConfig(message));
    } else if (msg.type === 'sync' && Array.isArray(msg.lines)) {
      const accepted = applySync(this.state, msg.lines);
      this.translator.invalidateScriptures(applyScriptures(this.state, accepted, msg.scriptures));
      this.translator.onSynced();
      // Phones replace (not merge) their view on a snapshot.
      this.sendSnapshots();
    } else if (msg.type === 'publish' && Array.isArray(msg.lines)) {
      const accepted = applyPublish(this.state, msg.lines);
      if (accepted.length === 0) return;
      this.translator.invalidateScriptures(applyScriptures(this.state, accepted, msg.scriptures));
      this.sendToLanguage('en', { type: 'update', lang: 'en', lines: accepted });
      this.translator.onPublished(accepted, parseDrafting(msg.drafting));
    } else if (msg.type === 'clear') {
      applyClear(this.state);
      this.translator.onCleared();
      this.sendToAll({ type: 'clear' });
    }
  }

  // ── phones ──

  addListener(id: string, send: Send): void {
    this.listeners.set(id, { send, lang: 'en' });
    send({ type: 'languages', enabled: this.cfg.enabled });
    send({ type: 'snapshot', lang: 'en', lines: snapshot(this.state) });
    this.notifyCount();
  }

  removeListener(id: string): void {
    this.listeners.delete(id);
    this.updateActive();
    this.notifyCount();
  }

  onListenerMessage(id: string, message: unknown): void {
    const entry = this.listeners.get(id);
    const msg = message as { type?: unknown; lang?: unknown } | null;
    if (!entry || !msg || typeof msg !== 'object') return;
    if (msg.type !== 'setLanguage') return;

    const lang = resolveLanguage(msg.lang, this.cfg.enabled);
    entry.lang = lang;
    this.updateActive();
    entry.send({ type: 'snapshot', lang, lines: this.linesFor(lang) });
    if (lang !== 'en') this.translator.catchUp(lang).catch(() => {});
    this.notifyCount();
  }

  ping(): void {
    this.sendToAll({ type: 'ping' });
  }

  // ── internals ──

  private applyConfig(config: ListenerTranslationConfig): void {
    this.cfg = config;
    this.translator.setConfig(config);
    // A phone on a language that is no longer offered goes back to English.
    this.listeners.forEach(entry => {
      if (entry.lang !== 'en' && config.enabled.indexOf(entry.lang) < 0) {
        entry.lang = 'en';
        entry.send({ type: 'snapshot', lang: 'en', lines: snapshot(this.state) });
      }
    });
    this.sendToAll({ type: 'languages', enabled: config.enabled });
    this.updateActive();
    this.notifyCount();
  }

  private linesFor(lang: ListenerLang): ListenerLine[] {
    return lang === 'en' ? snapshot(this.state) : this.translator.linesFor(lang);
  }

  /** A fresh snapshot for every phone, built once per language. */
  private sendSnapshots(): void {
    const cache = new Map<ListenerLang, ListenerLine[]>();
    this.listeners.forEach(entry => {
      let lines = cache.get(entry.lang);
      if (!lines) { lines = this.linesFor(entry.lang); cache.set(entry.lang, lines); }
      entry.send({ type: 'snapshot', lang: entry.lang, lines });
    });
  }

  private updateActive(): void {
    const active = new Set<ExtraListenerLang>();
    this.listeners.forEach(entry => { if (entry.lang !== 'en') active.add(entry.lang); });
    this.translator.setActive(active);
  }

  private sendToLanguage(lang: ListenerLang, message: unknown): void {
    this.listeners.forEach(entry => { if (entry.lang === lang) entry.send(message); });
  }

  private sendToAll(message: unknown): void {
    this.listeners.forEach(entry => entry.send(message));
  }

  private sendToBroadcaster(message: unknown): void {
    if (this.broadcaster) this.broadcaster(message);
  }

  private notifyCount(): void {
    const byLang: Record<string, number> = { en: 0 };
    EXTRA_LISTENER_LANGUAGES.forEach(lang => { byLang[lang] = 0; });
    this.listeners.forEach(entry => { byLang[entry.lang]++; });
    this.sendToBroadcaster({ type: 'listenerCount', count: this.listeners.size, byLang });
  }
}

function parseDrafting(raw: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(raw)) return ids;
  for (const id of raw.slice(0, MAX_DRAFTING_IDS)) if (typeof id === 'string' && id) ids.add(id);
  return ids;
}
