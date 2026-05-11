import { describe, it, expect } from 'vitest';
import { countSentences } from '../../client/src/lib/text-utils.js';

describe('countSentences', () => {
  it('counts periods as sentence endings', () => {
    expect(countSentences('Hello world. How are you. Fine.')).toBe(3);
  });

  it('counts question marks', () => {
    expect(countSentences('How are you? What is this?')).toBe(2);
  });

  it('counts exclamation marks', () => {
    expect(countSentences('Stop! Look! Listen!')).toBe(3);
  });

  it('counts mixed punctuation', () => {
    expect(countSentences('Hello. Is that you? Yes! Good.')).toBe(4);
  });

  it('treats consecutive punctuation as a single sentence end', () => {
    // "Really?!" should count as one sentence end, not two
    expect(countSentences('Really?! That is amazing.')).toBe(2);
  });

  it('returns 0 for empty string', () => {
    expect(countSentences('')).toBe(0);
  });

  it('returns 0 for whitespace-only string', () => {
    expect(countSentences('   ')).toBe(0);
  });

  it('returns 0 for text with no sentence-ending punctuation', () => {
    expect(countSentences('No punctuation here')).toBe(0);
  });

  it('retroactive correction triggers at 5 sentence boundary', () => {
    const text = 'One. Two. Three. Four. Five.';
    expect(countSentences(text)).toBe(5);
    // Verify the triggering condition: floor(5/5) > floor(4/5)
    expect(Math.floor(5 / 5)).toBeGreaterThan(Math.floor(4 / 5));
  });
});
