// Sanitizes user-supplied glossary text before it is embedded in an LLM
// system prompt. Strips backtick runs (prevents a glossary line from closing
// the ```-fenced data-only block early) and silently drops any line that
// looks like an injected instruction, so glossary content can only ever be
// read as data, never as instructions. See CLAUDE.md "Security notes —
// Prompt injection (glossary)".
//
// Moved here (from server/lib/anthropic.ts, where it originated) so
// server/lib/sermon-prompt.ts and any future glossary source can share one
// implementation instead of the OpenAI path re-inventing an unsanitized copy
// — see the plan doc, §5.
const INJECTION_RE = /^\s*(ignore|forget|disregard|instead|override|system|assistant|human|user|new instruction|end of|stop|you are|do not|don't)/i;

export function sanitizeGlossary(raw: string): string {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/`+/g, "'")) // close-fence prevention
    .filter(line => !INJECTION_RE.test(line)) // drop injection attempts
    .join('\n');
}
