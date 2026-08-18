import { describe, it, expect } from 'vitest';
import { isAsrArtifact } from '../../server/lib/asr-artifacts.js';

describe('isAsrArtifact', () => {
  it('treats an empty/whitespace-only string as not-an-artifact (handled by the caller\'s own empty check)', () => {
    expect(isAsrArtifact('', 'nl')).toBe(false);
    expect(isAsrArtifact('   ', 'nl')).toBe(false);
  });

  it('flags a string with nothing but punctuation/asterisks', () => {
    expect(isAsrArtifact('***', 'nl')).toBe(true);
    expect(isAsrArtifact('...', 'nl')).toBe(true);
  });

  it('flags the reported foreign-script hallucination during a Latin-script recording', () => {
    expect(isAsrArtifact('を を を', 'nl')).toBe(true);
    expect(isAsrArtifact('を を を', 'en')).toBe(true);
  });

  it('does not flag non-Latin script when the source language itself uses that script', () => {
    expect(isAsrArtifact('を を を', 'ja')).toBe(false);
    expect(isAsrArtifact('こんにちは', 'ja')).toBe(false);
  });

  it.each([
    'MUZIEK',
    'Zang en muziek.',
    'Zang en muziek',
    'Applaus.',
    'Stilte.',
    'Dank u wel.',
    'Dank je wel',
    'Bedankt voor het kijken.',
    'Ondertiteling door de Amara.org gemeenschap',
    '*ZANG EN MUZIEK*',
    '[Muziek]',
  ])('flags the whole-output Dutch caption artifact %j', (text) => {
    expect(isAsrArtifact(text, 'nl')).toBe(true);
  });

  it.each([
    'Music',
    'Applause.',
    'Thank you.',
    'Thanks for watching!',
    'Subtitles by',
    'Bye.',
  ])('flags the whole-output English caption artifact %j', (text) => {
    expect(isAsrArtifact(text, 'en')).toBe(true);
  });

  it.each([
    'Genade zij u en vrede van God onze Vader.',
    'Ja.',
    'Am.',
    'En dat is precies wat Paulus hier bedoelt, broeders en zusters.',
    // The artifact phrase mid-sentence must NOT trigger — only a
    // whole-output match does.
    'We danken u voor deze mooie muziek in de dienst.',
    'Dank u wel dat u geluisterd heeft naar deze preek.',
    'Laten we samen zingen.',
  ])('does not flag ordinary sermon speech %j', (text) => {
    expect(isAsrArtifact(text, 'nl')).toBe(false);
  });

  it('is case- and punctuation-insensitive', () => {
    expect(isAsrArtifact('  muziek!!  ', 'nl')).toBe(true);
    expect(isAsrArtifact('MUZIEK.', 'nl')).toBe(true);
  });
});
