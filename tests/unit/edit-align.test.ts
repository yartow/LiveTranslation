import { describe, it, expect } from 'vitest';
import { planWindows, indexRange, myers, tokenize, editedTimes, render } from '../../scripts/lib/edit-align.js';

describe('planWindows', () => {
  const chunks = (...secs: number[]) => {
    let t = 0;
    return secs.map(s => { const c = { start: t, secs: s }; t += s; return c; });
  };

  it('groups consecutive chunks until the minimum is reached, never cutting inside a chunk', () => {
    expect(planWindows(chunks(10, 10, 10, 10, 10, 10, 10, 10), 25))
      .toEqual([{ from: 0, to: 30 }, { from: 30, to: 80 }]); // the 20 s tail (< 25) joins the second window
  });

  it('merges a short tail into the previous window', () => {
    expect(planWindows(chunks(20, 20, 5), 30)).toEqual([{ from: 0, to: 45 }]);
  });

  it('keeps a single short recording as one window, and handles none', () => {
    expect(planWindows(chunks(12), 45)).toEqual([{ from: 0, to: 12 }]);
    expect(planWindows([], 45)).toEqual([]);
  });

  it('uses real chunk times (gaps included), sorts its input, and merges the short tail across a gap', () => {
    // sorted: 0-20, 50-70, 100-120. The first two reach 40 s at 70; the last is a 20 s tail, merged in.
    expect(planWindows([{ start: 100, secs: 20 }, { start: 0, secs: 20 }, { start: 50, secs: 20 }], 40))
      .toEqual([{ from: 0, to: 120 }]);
  });
});

describe('indexRange', () => {
  it('finds the slice of a non-decreasing time array inside [from, to)', () => {
    const times = [0, 1, 2, 5, 5, 6, 9];
    expect(indexRange(times, 2, 6)).toEqual([2, 5]);
    expect(indexRange(times, 0, 100)).toEqual([0, 7]);
    expect(indexRange(times, 10, 20)).toEqual([7, 7]);
    expect(indexRange([], 0, 5)).toEqual([0, 0]);
  });
});

describe('editedTimes — a time for every edited word', () => {
  const words = (text: string, t0 = 0) => text.split(' ').map((raw, i) => ({ raw, time: t0 + i, segment: -1 }));
  const id = (t: string) => t.toLowerCase();

  it('unchanged words take their ASR time; replaced and added words take the nearest earlier ASR time', () => {
    const a = tokenize(words('het kik is geboren in betlehem'), id);       // times 0..5
    const b = tokenize(words('het kind is geboren dit jaar in betlehem'), id);
    const ops = myers(a.map(t => t.norm), b.map(t => t.norm));
    const times = editedTimes(ops, a, b.length);
    expect(times).toHaveLength(b.length);
    const byWord = Object.fromEntries(b.map((t, i) => [t.norm, times[i]]));
    expect(byWord['het']).toBe(0);
    expect(byWord['kind']).toBe(1);        // replaced "kik" (time 1)
    expect(byWord['geboren']).toBe(3);
    expect(byWord['betlehem']).toBe(5);
    expect(times).toEqual([...times].sort((x, y) => x - y)); // non-decreasing, so indexRange works on it
  });

  it('cutting by time returns the edited words of that stretch', () => {
    const a = tokenize(words('een twee drie vier vijf zes'), id);
    const b = tokenize(words('een 2 drie vier vijf zes'), id);
    const times = editedTimes(myers(a.map(t => t.norm), b.map(t => t.norm)), a, b.length);
    const [j0, j1] = indexRange(times, 0, 3);
    expect(render(b, j0, j1)).toBe('een 2 drie');
  });
});
