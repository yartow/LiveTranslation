import { describe, it, expect } from 'vitest';
import { maskKey } from '../../client/src/lib/mask-key.js';

describe('maskKey', () => {
  it('masks a full-length API key showing first 6 and last 4 characters', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz1234';
    const masked = maskKey(key);
    expect(masked.startsWith('sk-abc')).toBe(true);
    expect(masked.endsWith('1234')).toBe(true);
    expect(masked).toContain('•');
  });

  it('total masked length equals original key length', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrst';
    expect(maskKey(key).length).toBe(key.length);
  });

  it('replaces only the middle portion with bullets', () => {
    // key = 'AAAAAABBBBCCCC' (14 chars)
    // first 6 = 'AAAAAA', last 4 = 'CCCC', middle = 4 bullets
    const key = 'AAAAAABBBBCCCCxx';
    const masked = maskKey(key);
    expect(masked.slice(0, 6)).toBe('AAAAAA');
    expect(masked.slice(-4)).toBe('CCxx');
    expect([...masked.slice(6, -4)].every(c => c === '•')).toBe(true);
  });

  it('returns all bullets for short keys (≤10 chars)', () => {
    expect(maskKey('short')).toBe('•••••');
    expect(maskKey('exactly10c')).toBe('••••••••••');
  });

  it('handles an empty string without throwing', () => {
    expect(maskKey('')).toBe('');
  });
});
