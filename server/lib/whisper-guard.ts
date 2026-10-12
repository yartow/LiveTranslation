// Safety net for prompt-induced Whisper failures.
//
// Whisper's initial prompt (previous text + glossary) steers the decoder, and
// occasionally steers it into ECHOING the prompt instead of transcribing:
// measured on a real clip, a chunk of Scripture being read aloud (~8 s, ~25
// words) came back as just "Filippenzen 2, vers 5 tot 11." once the glossary
// was in the prompt, and transcribed fine without it. The damage is an entire
// chunk, far worse than the spelling a glossary term buys.
//
// A chunk of real speech carries roughly 2-3 words per second; an echo or
// truncation carries well under 1. So a long-enough chunk with a very low word
// rate is retried once WITHOUT the prompt, and the longer result wins.

export const GUARD_MIN_SECS = 5;
export const GUARD_MIN_WORDS_PER_SEC = 1.0;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** True when a chunk's transcript is implausibly short for its audio length. */
export function looksTruncated(text: string, durationSecs: number): boolean {
  if (!Number.isFinite(durationSecs) || durationSecs < GUARD_MIN_SECS) return false;
  return wordCount(text) / durationSecs < GUARD_MIN_WORDS_PER_SEC;
}

/** Duration of a 16 kHz mono 16-bit WAV (44-byte header), as the client sends it. */
export function wavDurationSecs(byteLength: number): number {
  return Math.max(0, byteLength - 44) / 32_000;
}

/**
 * Runs `run(true)` (with the prompt); if the result looks truncated and a
 * prompt was actually in play, retries `run(false)` and keeps whichever
 * transcript has more words. Retry failures are swallowed: the first result
 * stands.
 */
export async function transcribeGuarded(
  run: (usePrompt: boolean) => Promise<string>,
  hasPrompt: boolean,
  durationSecs: number,
): Promise<{ text: string; retried: boolean }> {
  const first = await run(true);
  if (!hasPrompt || !looksTruncated(first, durationSecs)) return { text: first, retried: false };
  try {
    const second = await run(false);
    return { text: wordCount(second) > wordCount(first) ? second : first, retried: true };
  } catch {
    return { text: first, retried: true };
  }
}
