// The operator may type markdown into a translation cell (`> quote`, `**bold**`, lists — rendered on
// listener phones by ListenerMarkdown.tsx). This turns such text back into its plain words so the
// rest of the app can tell "same words, different formatting" from a real wording change: a
// formatting-only edit must not turn a phone line italic (useListenerBroadcast.ts) or teach the
// translator to emit markdown (selectCorrectionExamples). Deliberately crude — it only has to make
// both sides of a comparison equal, not render anything.

const LINE_PREFIX = /^\s*(?:>\s?)*\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/;
const HORIZONTAL_RULE = /^\s*(?:[-*_]\s*){3,}$/;

export function stripMarkdown(text: string): string {
  return text
    .split('\n')
    .map(line => (HORIZONTAL_RULE.test(line) ? '' : line.replace(LINE_PREFIX, '')))
    .join(' ')
    // Emphasis markers. English sermon text has no other use for these characters.
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const HEADING_LINE = /^\s*#{1,6}\s/;

/**
 * Makes `text` a level-1 heading ("# Title"). Idempotent: text that already starts with a heading
 * marker (any level — the operator may have typed one) is returned as it is, so a `#` is never doubled.
 */
export function ensureHeading(text: string): string {
  const t = text.trim();
  if (!t || HEADING_LINE.test(t)) return text;
  return `# ${t}`;
}

/** True when `a` and `b` differ only in markdown formatting and whitespace. */
export function sameWords(a: string, b: string): boolean {
  return stripMarkdown(a) === stripMarkdown(b);
}
