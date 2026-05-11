/**
 * Regression: chunks arriving out of order must be delivered to the client
 * in the original recording order. This tests the flushInOrder mechanism that
 * was introduced to replace the earlier unbuffered delivery that caused
 * translated text to appear in the wrong order when a slow chunk was overtaken
 * by a faster one.
 */
import { describe, it, expect } from 'vitest';
import { flushInOrder, type ChunkSessionForTest, type ChunkResult } from '../../server/lib/chunk-transcription.js';

function makeSession() {
  const messages: Array<{ original: string; chunkIndex: number }> = [];
  const session: ChunkSessionForTest = {
    clientWs: {
      readyState: 1,
      send: (msg: string) => {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'translation') {
          messages.push({ original: parsed.original, chunkIndex: parsed.chunkIndex });
        }
      },
    },
    nextExpectedChunk: 0,
    pendingResults: new Map<number, ChunkResult>(),
  };
  return { session, messages };
}

describe('Regression: chunk ordering preserves recording sequence', () => {
  it('out-of-order arrival is reordered before delivery', () => {
    const { session, messages } = makeSession();

    // Simulate: chunk 2 finishes first, then 0, then 1
    session.pendingResults.set(2, { correctedText: 'Third sentence.', translatedText: '' });
    flushInOrder(session);
    expect(messages).toHaveLength(0); // nothing delivered yet

    session.pendingResults.set(0, { correctedText: 'First sentence.', translatedText: '' });
    flushInOrder(session);
    expect(messages).toHaveLength(1);
    expect(messages[0].original).toBe('First sentence.'); // only chunk 0 delivered

    session.pendingResults.set(1, { correctedText: 'Second sentence.', translatedText: '' });
    flushInOrder(session);
    // Now all three delivered in order
    expect(messages.map(m => m.original)).toEqual([
      'First sentence.',
      'Second sentence.',
      'Third sentence.',
    ]);
  });

  it('chunkIndex in the delivered message matches the recording position, not arrival position', () => {
    const { session, messages } = makeSession();

    // Chunk 1 arrives before chunk 0
    session.pendingResults.set(1, { correctedText: 'B', translatedText: '' });
    session.pendingResults.set(0, { correctedText: 'A', translatedText: '' });
    flushInOrder(session);

    expect(messages[0].chunkIndex).toBe(0);
    expect(messages[1].chunkIndex).toBe(1);
  });

  it('a permanently missing chunk would block all subsequent chunks', () => {
    const { session, messages } = makeSession();

    // Chunk 0 is never received (simulate a lost message)
    session.pendingResults.set(1, { correctedText: 'B', translatedText: '' });
    session.pendingResults.set(2, { correctedText: 'C', translatedText: '' });
    flushInOrder(session);

    // Chunks 1 and 2 are held back until chunk 0 arrives
    expect(messages).toHaveLength(0);
    expect(session.nextExpectedChunk).toBe(0); // still waiting for chunk 0
  });
});
