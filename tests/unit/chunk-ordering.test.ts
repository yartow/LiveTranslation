import { describe, it, expect, beforeEach } from 'vitest';
import { flushInOrder, stripAsteriskArtifacts, resolveStartChunkIndex, type ChunkSessionForTest, type ChunkResult } from '../../server/lib/chunk-transcription.js';
import { isAsrArtifact } from '../../server/lib/asr-artifacts.js';

function makeSession(): ChunkSessionForTest & { sent: Array<{ original: string; chunkIndex: number }> } {
  const sent: Array<{ original: string; chunkIndex: number }> = [];
  return {
    clientWs: {
      readyState: 1, // WebSocket.OPEN
      send: (msg: string) => {
        const parsed = JSON.parse(msg);
        sent.push({ original: parsed.original, chunkIndex: parsed.chunkIndex });
      },
    },
    nextExpectedChunk: 0,
    pendingResults: new Map<number, ChunkResult>(),
    sent,
  };
}

describe('flushInOrder', () => {
  it('delivers a single completed chunk immediately', () => {
    const s = makeSession();
    s.pendingResults.set(0, { correctedText: 'Hello', translatedText: 'Hallo' });
    flushInOrder(s);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].original).toBe('Hello');
    expect(s.nextExpectedChunk).toBe(1);
  });

  it('delivers multiple consecutive chunks in order', () => {
    const s = makeSession();
    s.pendingResults.set(0, { correctedText: 'First', translatedText: '' });
    s.pendingResults.set(1, { correctedText: 'Second', translatedText: '' });
    s.pendingResults.set(2, { correctedText: 'Third', translatedText: '' });
    flushInOrder(s);
    expect(s.sent.map(m => m.original)).toEqual(['First', 'Second', 'Third']);
    expect(s.nextExpectedChunk).toBe(3);
  });

  it('holds back later chunks until the gap is filled', () => {
    const s = makeSession();
    // Chunk 1 arrives before chunk 0
    s.pendingResults.set(1, { correctedText: 'Second', translatedText: '' });
    flushInOrder(s);
    expect(s.sent).toHaveLength(0); // blocked — chunk 0 not yet received

    // Chunk 0 arrives
    s.pendingResults.set(0, { correctedText: 'First', translatedText: '' });
    flushInOrder(s);
    expect(s.sent.map(m => m.original)).toEqual(['First', 'Second']);
    expect(s.nextExpectedChunk).toBe(2);
  });

  it('handles a gap in the middle correctly', () => {
    const s = makeSession();
    s.pendingResults.set(0, { correctedText: 'A', translatedText: '' });
    s.pendingResults.set(2, { correctedText: 'C', translatedText: '' });
    flushInOrder(s);
    // Only A delivered; C held back because B (chunk 1) is missing
    expect(s.sent.map(m => m.original)).toEqual(['A']);
    expect(s.nextExpectedChunk).toBe(1);

    s.pendingResults.set(1, { correctedText: 'B', translatedText: '' });
    flushInOrder(s);
    expect(s.sent.map(m => m.original)).toEqual(['A', 'B', 'C']);
    expect(s.nextExpectedChunk).toBe(3);
  });

  it('skips silent chunks (empty correctedText) without sending a WS message', () => {
    const s = makeSession();
    s.pendingResults.set(0, { correctedText: '', translatedText: '' }); // silent
    s.pendingResults.set(1, { correctedText: 'Hello', translatedText: '' });
    flushInOrder(s);
    // No message for the silent chunk, but ordering advances past it
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].original).toBe('Hello');
    expect(s.nextExpectedChunk).toBe(2);
  });

  it('does nothing when pendingResults is empty', () => {
    const s = makeSession();
    flushInOrder(s);
    expect(s.sent).toHaveLength(0);
    expect(s.nextExpectedChunk).toBe(0);
  });

  it('gap recovery: skips ahead once enough results have piled up behind a permanently missing index', () => {
    const s = makeSession();
    // Chunk 0 never arrives (simulates a genuinely lost frame). Chunks 1-9
    // do. Without recovery, flushInOrder would block forever on index 0.
    for (let i = 1; i <= 9; i++) {
      s.pendingResults.set(i, { correctedText: `chunk${i}`, translatedText: '' });
    }
    flushInOrder(s);
    // 9 pending results exceeds MAX_PENDING_BEFORE_GAP_SKIP (8) — recovery
    // should have advanced past the hole and delivered everything.
    expect(s.nextExpectedChunk).toBe(10);
    expect(s.sent.map(m => m.original)).toEqual(
      Array.from({ length: 9 }, (_, i) => `chunk${i + 1}`),
    );
  });

  it('does not skip ahead while the pile-up is still below the recovery threshold', () => {
    const s = makeSession();
    // Only a few chunks piled up behind the missing index 0 — not enough
    // to trigger recovery yet; ordering must still block correctly.
    for (let i = 1; i <= 3; i++) {
      s.pendingResults.set(i, { correctedText: `chunk${i}`, translatedText: '' });
    }
    flushInOrder(s);
    expect(s.sent).toHaveLength(0);
    expect(s.nextExpectedChunk).toBe(0);
  });
});

describe('stripAsteriskArtifacts', () => {
  it('removes a leading asterisk-hallucination run and the space it leaves behind', () => {
    expect(stripAsteriskArtifacts('*** Er goed uitzien.')).toBe('Er goed uitzien.');
  });

  it('removes several separate asterisk runs scattered through the text', () => {
    expect(stripAsteriskArtifacts('*** *** *** *** *** *** Hij lijkt best wel snel te zijn, alleen...'))
      .toBe('Hij lijkt best wel snel te zijn, alleen...');
  });

  it('removes a single stray asterisk glued to a word', () => {
    expect(stripAsteriskArtifacts('Dit is *raar*.')).toBe('Dit is raar.');
  });

  it('leaves ordinary text with no asterisks untouched', () => {
    expect(stripAsteriskArtifacts('Dank je wel.')).toBe('Dank je wel.');
  });

  it('leaves an empty string empty', () => {
    expect(stripAsteriskArtifacts('')).toBe('');
  });
});

describe('resolveStartChunkIndex (reconnect resync)', () => {
  it('resumes from the requested index on a reconnect', () => {
    expect(resolveStartChunkIndex({ nextChunkIndex: 42 })).toBe(42);
  });

  it('defaults to 0 for a genuinely new session (field absent)', () => {
    expect(resolveStartChunkIndex({})).toBe(0);
  });

  it('defaults to 0 for a negative or non-numeric value rather than trusting it blindly', () => {
    expect(resolveStartChunkIndex({ nextChunkIndex: -1 })).toBe(0);
    expect(resolveStartChunkIndex({ nextChunkIndex: 'not-a-number' as unknown as number })).toBe(0);
  });

  it('accepts 0 explicitly (the very first chunk of a session)', () => {
    expect(resolveStartChunkIndex({ nextChunkIndex: 0 })).toBe(0);
  });
});

describe('isAsrArtifact + stripAsteriskArtifacts ordering (regression for the asterisk-marker bug)', () => {
  it('an asterisk-wrapped hallucination must be caught by isAsrArtifact BEFORE stripAsteriskArtifacts runs', () => {
    const rawText = '*ZANG EN MUZIEK*';
    // stripAsteriskArtifacts alone would destroy the very marker that
    // identifies this as an annotation, leaving the hallucinated words
    // behind ("ZANG EN MUZIEK") — this is what server/lib/chunk-
    // transcription.ts's processChunk() must avoid by running the artifact
    // check first.
    expect(isAsrArtifact(rawText, 'nl')).toBe(true);

    // Simulate the actual pipeline order: artifact check first (drops to
    // '' before stripAsteriskArtifacts ever runs on it).
    const correctedText = isAsrArtifact(rawText, 'nl') ? '' : stripAsteriskArtifacts(rawText);
    expect(correctedText).toBe('');

    // Demonstrate the bug this guards against: running strip first would
    // have left the hallucinated words intact and un-caught.
    expect(stripAsteriskArtifacts(rawText)).toBe('ZANG EN MUZIEK');
  });
});
