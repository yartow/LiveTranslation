import { describe, it, expect } from 'vitest';
import { parseSermonItems, SERMON_MAX_ITEMS } from '../../server/lib/sermon-items.js';
import { claudeMaxTokens, itemTimeoutMs } from '../../server/lib/sermon-translate.js';

describe('parseSermonItems', () => {
  it('accepts a very long cell (no per-cell character limit)', () => {
    const text = 'Dit is een lange zin. '.repeat(1000); // ~22,000 chars
    const parsed = parseSermonItems([{ id: 'a', text }]);
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.items[0].text).toBe(text);
  });

  it('answers a blank cell alone instead of rejecting the batch', () => {
    const parsed = parseSermonItems([{ id: 'a', text: 'Hallo' }, { id: 'b', text: '   ' }, { id: 'c', text: '' }]);
    expect(parsed?.items.map(i => i.id)).toEqual(['a']);
    expect(parsed?.blankIds).toEqual(['b', 'c']);
  });

  it('still rejects structurally invalid batches', () => {
    expect(parseSermonItems([])).toBeNull();
    expect(parseSermonItems('x')).toBeNull();
    expect(parseSermonItems([{ id: 'a', text: 1 }])).toBeNull();
    expect(parseSermonItems([{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }])).toBeNull();
    expect(parseSermonItems(Array.from({ length: SERMON_MAX_ITEMS + 1 }, (_, i) => ({ id: `i${i}`, text: 'x' })))).toBeNull();
    expect(parseSermonItems([{ id: 'a', text: 'x', readingCandidate: { bookNumber: 99, chapter: 1, verse: 1 } }])).toBeNull();
  });

  it('passes the lyrics flag through and rejects a malformed one', () => {
    expect(parseSermonItems([{ id: 'a', text: 'x', lyrics: true }])?.items[0].lyrics).toBe(true);
    expect(parseSermonItems([{ id: 'a', text: 'x', lyrics: false }])?.items[0]).not.toHaveProperty('lyrics');
    expect(parseSermonItems([{ id: 'a', text: 'x', lyrics: 'yes' }])).toBeNull();
  });

  it('applies a sanity cap far above any real cell', () => {
    expect(parseSermonItems([{ id: 'a', text: 'x'.repeat(100_001) }])).toBeNull();
  });
});

describe('length-scaled limits', () => {
  it('grows Claude max_tokens with the request, within 1024-8192', () => {
    expect(claudeMaxTokens(100)).toBe(1024);
    expect(claudeMaxTokens(6000)).toBe(3000);
    expect(claudeMaxTokens(1_000_000)).toBe(8192);
  });

  it('grows the item timeout by a second per 500 characters', () => {
    expect(itemTimeoutMs(0)).toBe(20_000);
    expect(itemTimeoutMs(5000)).toBe(30_000);
  });
});
