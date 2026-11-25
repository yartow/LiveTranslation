import { describe, it, expect } from 'vitest';
import {
  clampTextSize, stepTextSize, toggleColumn, visibleCell,
  TEXT_SIZE_DEFAULT, TEXT_SIZE_MAX, TEXT_SIZE_MIN,
} from '../../client/src/lib/sermon/layout.js';

describe('text size', () => {
  it('clamps to 12..120 and rounds', () => {
    expect(clampTextSize(3)).toBe(TEXT_SIZE_MIN);
    expect(clampTextSize(500)).toBe(TEXT_SIZE_MAX);
    expect(clampTextSize(20.6)).toBe(21);
    expect(clampTextSize(NaN)).toBe(TEXT_SIZE_DEFAULT);
  });

  it('steps by 2 px when small, by more when large, and stops at the ends', () => {
    expect(stepTextSize(14, 1)).toBe(16);
    expect(stepTextSize(14, -1)).toBe(12);
    expect(stepTextSize(12, -1)).toBe(12);
    expect(stepTextSize(60, 1)).toBeGreaterThan(62);
    expect(stepTextSize(120, 1)).toBe(120);
  });

  it('reaches the maximum from the default in a reasonable number of steps', () => {
    let size = TEXT_SIZE_DEFAULT; let n = 0;
    while (size < TEXT_SIZE_MAX && n < 200) { size = stepTextSize(size, 1); n++; }
    expect(size).toBe(TEXT_SIZE_MAX);
    expect(n).toBeLessThan(40);
  });
});

describe('hidden column', () => {
  it('toggles and never hides both', () => {
    expect(toggleColumn('none', 'source')).toBe('source');
    expect(toggleColumn('source', 'source')).toBe('none');
    expect(toggleColumn('source', 'target')).toBe('target'); // Dutch is shown again
    expect(toggleColumn('target', 'source')).toBe('source');
  });

  it('picks the visible cell to focus', () => {
    expect(visibleCell('source', 'none')).toBe('source');
    expect(visibleCell('source', 'source')).toBe('target');
    expect(visibleCell('target', 'target')).toBe('source');
    expect(visibleCell('target', 'source')).toBe('target');
  });
});
