// Words the speech recognizer was unsure about (MLX engine: server/lib/low-confidence.ts), kept for the
// "check: word, word" chips under a Dutch cell. A chip is shown for a flagged word that is still in the
// cell's text — so it disappears by itself the moment the operator corrects the word — and can be
// dismissed for good ("this one is fine").
//
// A word is flagged wherever it appears, not only in the chunk where Whisper doubted it: the same
// doubtful spelling ("Kik") is worth a look in every row. The set is capped (oldest dropped first) so a
// long service cannot make everything look doubtful. DOM-free; the React side reads it through
// useSyncExternalStore (ConfidenceChips.tsx), so a new chunk never re-renders the page itself.

import { norm, stripPunct, isWordChar } from './word-text';

const MAX_WORDS = 150;
const MAX_CHIPS_PER_CELL = 6;


/** Index of `word` as a whole word in `text` (case-insensitive), or -1. */
export function findWordIndex(text: string, word: string): number {
  const hay = text.toLowerCase(), needle = word.toLowerCase();
  if (!needle) return -1;
  for (let from = 0; ; ) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return -1;
    if (!isWordChar(text[i - 1]) && !isWordChar(text[i + needle.length])) return i;
    from = i + 1;
  }
}

export class ConfidenceStore {
  private flagged = new Map<string, string>(); // normalised word -> as first reported
  private version = 0;
  private listeners = new Set<() => void>();

  /** Flags the words of one chunk. */
  add(words: string[] | undefined): void {
    if (!words?.length) return;
    let changed = false;
    for (const raw of words) {
      const n = norm(raw);
      if (!n || this.flagged.has(n)) continue;
      this.flagged.set(n, stripPunct(raw));
      changed = true;
      if (this.flagged.size > MAX_WORDS) this.flagged.delete(this.flagged.keys().next().value as string);
    }
    if (changed) this.bump();
  }

  /** The flagged words that appear in `text`, as written there, in order, each once. */
  flaggedIn(text: string): string[] {
    if (this.flagged.size === 0 || !text) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const token of text.split(/\s+/)) {
      const word = stripPunct(token);
      const n = norm(word);
      if (!n || seen.has(n) || !this.flagged.has(n)) continue;
      seen.add(n);
      out.push(word);
      if (out.length >= MAX_CHIPS_PER_CELL) break;
    }
    return out;
  }

  /** The operator looked and the word is fine: stop flagging it. */
  dismiss(word: string): void {
    if (this.flagged.delete(norm(word))) this.bump();
  }

  clear(): void {
    if (this.flagged.size) { this.flagged.clear(); this.bump(); }
  }

  get size(): number { return this.flagged.size; }

  private bump(): void {
    this.version++;
    this.listeners.forEach(l => l());
  }

  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}
