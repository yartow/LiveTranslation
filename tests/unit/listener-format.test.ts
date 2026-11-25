import { describe, it, expect } from 'vitest';
import { carryFormatting } from '../../server/lib/listener-translate';

describe('carryFormatting', () => {
  it('keeps plain text plain', () => expect(carryFormatting('For God so loved', 'V')).toBe('V'));
  it('quotes every line of a multi-line quote', () => {
    expect(carryFormatting('> a\n> b', 'x\ny')).toBe('> x\n> y');
  });
  it('carries bold, also inside a quote', () => {
    expect(carryFormatting('**a**', 'x')).toBe('**x**');
    expect(carryFormatting('> **a**', 'x')).toBe('> **x**');
  });
  it('wraps bold per line for a multi-line verse', () => {
    expect(carryFormatting('**a**', 'x\ny')).toBe('**x**\n**y**');
  });
});
