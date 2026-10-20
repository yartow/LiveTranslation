// Locating the words "Add to glossary" should rewrite inside a source cell.

/**
 * Index of the occurrence of `phrase` in `text` (case-insensitive) closest to
 * `near`, or -1. The text may have moved a little since the words were
 * highlighted (live updates, typing), so offsets are a hint, not a promise.
 */
export function locatePhrase(text: string, phrase: string, near: number): number {
  const needle = phrase.trim().toLowerCase();
  if (!needle) return -1;
  const haystack = text.toLowerCase();
  let best = -1;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    if (best === -1 || Math.abs(at - near) < Math.abs(best - near)) best = at;
    from = at + 1;
  }
  return best;
}

/** `text` with the occurrence of `phrase` nearest `near` replaced by `replacement`; null if the phrase is not there. */
export function replacePhrase(text: string, phrase: string, replacement: string, near: number): string | null {
  const at = locatePhrase(text, phrase, near);
  if (at === -1) return null;
  return text.slice(0, at) + replacement + text.slice(at + phrase.trim().length);
}
