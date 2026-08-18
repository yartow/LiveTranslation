import { describe, it, expect } from 'vitest';
import { findBoundaries, lastBoundary, splitSentences } from '../../client/src/lib/sermon/sentence-split.js';

describe('lastBoundary / findBoundaries — Dutch sentence detection', () => {
  it('finds a single boundary in one complete sentence', () => {
    expect(lastBoundary('Dit is een zin.')).toBe('Dit is een zin.'.length);
  });

  it('returns -1 when there is no terminal punctuation', () => {
    expect(lastBoundary('Dit is een zin zonder punt')).toBe(-1);
  });

  it('finds multiple boundaries and the trailing partial is excluded', () => {
    const text = 'Zin een. Zin twee. Half';
    const boundaries = findBoundaries(text);
    expect(boundaries.length).toBe(2);
    expect(text.slice(0, boundaries[0])).toBe('Zin een.');
    expect(text.slice(0, boundaries[1])).toBe('Zin een. Zin twee.');
    expect(lastBoundary(text)).toBe(boundaries[1]);
  });

  it('does not split on "bijv." as an abbreviation', () => {
    expect(lastBoundary('Neem bijv. de gelijkenis van de zaaier.')).toBe(
      'Neem bijv. de gelijkenis van de zaaier.'.length,
    );
    // "bijv." is mid-sentence; the sentence still legitimately ends at "anders.",
    // and a second sentence follows — two real boundaries, none of them at "bijv.".
    const text = 'We doen dit bijv. anders. Toch?';
    const boundaries = findBoundaries(text);
    expect(boundaries.length).toBe(2);
    expect(text.slice(0, boundaries[0])).toBe('We doen dit bijv. anders.');
  });

  it('does not split on "ds." as an abbreviation', () => {
    const text = 'Ds. Jansen preekte gisteren. Het was goed.';
    const boundaries = findBoundaries(text);
    expect(boundaries.length).toBe(2);
    expect(text.slice(0, boundaries[0])).toBe('Ds. Jansen preekte gisteren.');
  });

  it('does not split on "vs." as an abbreviation', () => {
    const text = 'Zie vs. 3 hieronder. Dat is duidelijk.';
    const boundaries = findBoundaries(text);
    expect(boundaries.length).toBe(2);
    expect(text.slice(0, boundaries[0])).toBe('Zie vs. 3 hieronder.');
  });

  it('does not split inside a Bible reference like "Hebr. 11:1"', () => {
    const text = 'Denk aan Hebr. 11:1 vanmorgen. Amen.';
    const boundaries = findBoundaries(text);
    expect(boundaries.length).toBe(2);
    expect(text.slice(0, boundaries[0])).toBe('Denk aan Hebr. 11:1 vanmorgen.');
  });

  it('does not split inside "1 Kor. 13"', () => {
    const text = 'Paulus schrijft dit in 1 Kor. 13 over de liefde. Lees het na.';
    const boundaries = findBoundaries(text);
    expect(boundaries.length).toBe(2);
    expect(text.slice(0, boundaries[0])).toBe('Paulus schrijft dit in 1 Kor. 13 over de liefde.');
  });

  it('does not split inside "Joh. 3:16"', () => {
    const text = 'Iedereen kent Joh. 3:16 wel. Het is bekend.';
    const boundaries = findBoundaries(text);
    expect(boundaries.length).toBe(2);
    expect(text.slice(0, boundaries[0])).toBe('Iedereen kent Joh. 3:16 wel.');
  });

  it('does not treat a decimal point as a sentence end', () => {
    expect(lastBoundary('De verhouding is 3.5 ongeveer')).toBe(-1);
    const text = 'De verhouding is 3.5 tot 1. Dat is veel.';
    const boundaries = findBoundaries(text);
    expect(boundaries.length).toBe(2);
    expect(text.slice(0, boundaries[0])).toBe('De verhouding is 3.5 tot 1.');
  });

  it('does not split on a single-letter initial', () => {
    const text = 'J. Smith schreef dit boek. Het is goed.';
    const boundaries = findBoundaries(text);
    expect(boundaries.length).toBe(2);
    expect(text.slice(0, boundaries[0])).toBe('J. Smith schreef dit boek.');
  });

  it('treats an ellipsis as a boundary', () => {
    expect(lastBoundary('En toen viel er een stilte…')).toBe('En toen viel er een stilte…'.length);
    expect(lastBoundary('En toen viel er een stilte...')).toBe('En toen viel er een stilte...'.length);
  });

  it('places the boundary after a closing quote that follows the period', () => {
    const text = 'Hij zei: "Kom maar." Toen liep hij weg.';
    const boundaries = findBoundaries(text);
    expect(boundaries.length).toBe(2);
    expect(text.slice(0, boundaries[0])).toBe('Hij zei: "Kom maar."');
  });

  it('handles multi-dot abbreviations like "d.w.z."', () => {
    const text = 'Dit is, d.w.z. eigenlijk, heel simpel. Toch?';
    const boundaries = findBoundaries(text);
    expect(boundaries.length).toBe(2);
    expect(text.slice(0, boundaries[0])).toBe('Dit is, d.w.z. eigenlijk, heel simpel.');
  });

  it('does not treat "?!" as two boundaries', () => {
    expect(findBoundaries('Is dat waar?! Ongelooflijk.').length).toBe(2);
  });

  it('returns [] for an empty string', () => {
    expect(findBoundaries('')).toEqual([]);
  });
});

describe('splitSentences', () => {
  it('splits complete sentences and trims each one', () => {
    expect(splitSentences('Zin een.  Zin twee. ')).toEqual(['Zin een.', 'Zin twee.']);
  });

  it('includes a trailing partial sentence as the last element', () => {
    expect(splitSentences('Zin een. Half')).toEqual(['Zin een.', 'Half']);
  });

  it('returns [] for empty input', () => {
    expect(splitSentences('   ')).toEqual([]);
  });

  it('does not split abbreviations mid-sentence', () => {
    expect(splitSentences('Ds. Jansen preekte. Het was goed.')).toEqual([
      'Ds. Jansen preekte.',
      'Het was goed.',
    ]);
  });
});
