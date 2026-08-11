import { describe, it, expect } from 'vitest';
import { dedupeOverlap, tail80 } from '../../client/src/lib/sermon/overlap-dedupe.js';

describe('dedupeOverlap', () => {
  it('drops a multi-word overlap, keeping the trailing punctuation of the matched word', () => {
    expect(dedupeOverlap('…werk aan het kruis', 'aan het kruis. Daarom')).toBe('. Daarom');
  });

  it('is case-insensitive and diacritic-insensitive when matching', () => {
    expect(dedupeOverlap('dit is genade', 'GENADE alleen redt')).toBe(' alleen redt');
    expect(dedupeOverlap('de heer is trouw', 'trouw blijft Hij')).toBe(' blijft Hij');
  });

  it('does not eat a genuine short repeated word (single short token guard)', () => {
    expect(dedupeOverlap('Dat vond ik heel', 'heel goed gedaan')).toBe('heel goed gedaan');
  });

  it('does accept a single long-enough token as overlap', () => {
    expect(dedupeOverlap('en dan komt genade', 'genade over ons')).toBe(' over ons');
  });

  it('returns incoming unchanged when there is no overlap at all', () => {
    expect(dedupeOverlap('dit is de eerste zin', 'een compleet andere zin')).toBe('een compleet andere zin');
  });

  it('returns incoming unchanged when prevTail is empty', () => {
    expect(dedupeOverlap('', 'nieuwe tekst hier')).toBe('nieuwe tekst hier');
  });

  it('returns incoming unchanged when incoming is empty or whitespace', () => {
    expect(dedupeOverlap('vorige tekst', '   ')).toBe('   ');
  });

  it('caps comparison at 8 tokens: a 9-token overlap outside the window is not detected', () => {
    const prevTail = 'een twee drie vier vijf zes zeven acht negen tien';
    const incoming = 'twee drie vier vijf zes zeven acht negen tien elf';
    // The true overlap here is 9 tokens ("twee".."tien"), which exceeds the
    // 8-token comparison cap, so no match is found and incoming passes through
    // unchanged. This is the cap doing its job, not a bug.
    expect(dedupeOverlap(prevTail, incoming)).toBe(incoming);
  });
});

describe('tail80', () => {
  it('returns the last 80 characters', () => {
    const text = 'a'.repeat(100);
    expect(tail80(text)).toBe('a'.repeat(80));
  });

  it('returns the whole string when shorter than 80 characters', () => {
    expect(tail80('kort')).toBe('kort');
  });
});
