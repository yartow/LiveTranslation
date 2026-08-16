import { describe, it, expect, beforeEach } from 'vitest';
import { flushInOrder, stripAsteriskArtifacts, type ChunkSessionForTest, type ChunkResult } from '../../server/lib/chunk-transcription.js';

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
