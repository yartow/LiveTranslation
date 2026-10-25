// Sends the browser's own errors and warnings to a `dev:record` session (server writes them to
// <session>/client-errors.jsonl), so "the page did something odd mid-service" leaves a trace next to
// the audio. Active only while `isActive()` says the archive is on. Never logs from its own failure
// path (that would loop), and redacts anything that looks like an API key before it leaves the page.

export interface ClientLogEntry {
  t: number;
  level: 'error' | 'warn' | 'unhandled' | 'rejection';
  message: string;
  stack?: string;
}

const MAX_MESSAGE = 2000;
const MAX_QUEUE = 200;

/** Replaces API-key-shaped tokens (OpenAI `sk-…`, Anthropic `sk-ant-…`, `Bearer …`) with a marker. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [redacted]');
}

export function formatArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try { return JSON.stringify(arg) ?? String(arg); } catch { return String(arg); }
}

export function buildEntry(level: ClientLogEntry['level'], args: unknown[], now: number): ClientLogEntry {
  const first = args.find((a): a is Error => a instanceof Error);
  return {
    t: now,
    level,
    message: redactSecrets(args.map(formatArg).join(' ')).slice(0, MAX_MESSAGE),
    stack: first?.stack ? redactSecrets(first.stack).slice(0, MAX_MESSAGE) : undefined,
  };
}

/** Installs the hooks; returns an uninstall function. `post` receives a JSON-lines body. */
export function installClientLog(isActive: () => boolean, post: (body: string, unloading: boolean) => void): () => void {
  let queue: ClientLogEntry[] = [];
  const push = (level: ClientLogEntry['level'], args: unknown[]) => {
    if (!isActive()) return;
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(buildEntry(level, args, Date.now()));
  };
  const flush = (unloading = false) => {
    if (!queue.length) return;
    const body = queue.map(e => JSON.stringify(e)).join('\n');
    queue = [];
    try { post(body, unloading); } catch { /* never log from here */ }
  };

  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => { push('error', args); origError.apply(console, args); };
  console.warn = (...args: unknown[]) => { push('warn', args); origWarn.apply(console, args); };
  const onError = (e: ErrorEvent) => push('unhandled', [e.error ?? e.message]);
  const onRejection = (e: PromiseRejectionEvent) => push('rejection', [e.reason]);
  const onHide = () => flush(true);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('pagehide', onHide);
  const timer = setInterval(() => flush(), 5000);

  return () => {
    clearInterval(timer);
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('pagehide', onHide);
    console.error = origError;
    console.warn = origWarn;
    flush();
  };
}
