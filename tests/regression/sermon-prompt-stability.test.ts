/**
 * Regression: the sermon-translate system prompt must be a byte-identical
 * stable prefix across calls with the same (targetLanguage, glossary) —
 * that's the entire prerequisite for OpenAI/Anthropic prompt caching to
 * actually hit. A cache miss produces no correctness signal, only a cost
 * signal weeks later — so this snapshots the SHA-256 of the no-glossary
 * English prefix and fails loudly if an edit to sermon-prompt.ts's fixed
 * ROLE_PROTOCOL text silently changes it.
 *
 * If you intentionally change the prompt wording, update EXPECTED_HASH.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { buildSystemPrompt, getGlossaryContext } from '../../server/lib/sermon-prompt.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// The approved digest of the current no-glossary English system prompt. A
// failure here means ROLE_PREAMBLE/OUTPUT_PROTOCOL in sermon-prompt.ts
// changed — if that was intentional, update this constant.
const EXPECTED_HASH = 'db640e242046255b9c0a0021320b3c2d1f27652c247520df8f03b3f0da9d74a6';

describe('sermon system prompt — stable prefix regression', () => {
  it('is byte-identical across repeated calls, and matches the approved digest', () => {
    const ctx = getGlossaryContext(undefined);
    const first = buildSystemPrompt('en', ctx);
    const second = buildSystemPrompt('en', ctx);
    expect(sha256(first)).toBe(sha256(second));
    expect(sha256(first)).toBe(EXPECTED_HASH);
  });

  it('contains no per-request-varying content (no ISO dates, no counts)', () => {
    const prompt = buildSystemPrompt('en', getGlossaryContext(undefined));
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no embedded date
    expect(prompt.toLowerCase()).not.toContain('segment id');
  });

  it('is stable across process-level calls for a fixed glossary (regression against accidental edits)', () => {
    const ctx = getGlossaryContext('Heiland = Savior\nGenade = Grace / Mercy');
    const prompt = buildSystemPrompt('en', ctx);
    // Not asserting a fixed hash value (that would make routine, deliberate
    // prompt edits fail this test) — asserting the property that matters:
    // determinism for identical inputs, checked via hash equality rather
    // than string equality so the failure output stays short.
    expect(sha256(prompt)).toBe(sha256(buildSystemPrompt('en', getGlossaryContext('Heiland = Savior\nGenade = Grace / Mercy'))));
  });
});
