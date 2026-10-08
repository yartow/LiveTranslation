import { describe, it, expect } from 'vitest';
import { isAsrArtifact, stripAsrArtifacts } from '../../server/lib/asr-artifacts.js';

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
    'TV Gelderland 2021',
    'TV Gelderland 2021.',
    'Omroep Gelderland',
    'Ondertitels ingediend door de Amara.org gemeenschap',
  ])('flags broadcaster-credit hallucination %j', (text) => {
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

describe('stripAsrArtifacts', () => {
  it.each([
    ['[Muziek] Goedemorgen allemaal.', 'Goedemorgen allemaal.'],
    ['Muziek. Muziek. Goedemorgen allemaal.', 'Goedemorgen allemaal.'],
    ['Goedemorgen allemaal. Muziek.', 'Goedemorgen allemaal.'],
    ['♪ la la la ♪ en toen zei Jezus', 'en toen zei Jezus'],
    ['*zang* Wij lezen uit Johannes.', 'Wij lezen uit Johannes.'],
    ['Wij lezen uit Johannes. Ondertiteling door de Amara.org gemeenschap', 'Wij lezen uit Johannes.'],
    ['MUZIEK Dank u wel dat u er bent.', 'Dank u wel dat u er bent.'],
    ['Het is goed (applaus) om hier te zijn.', 'Het is goed om hier te zijn.'],
  ])('removes the artifact in %j', (input, expected) => {
    expect(stripAsrArtifacts(input, 'nl')).toBe(expected);
  });

  it.each([
    'Muziek is een gave van God.',
    'We danken u voor deze mooie muziek in de dienst.',
    'Wat een mooie muziek.',
    'Dank u wel dat u geluisterd heeft.',
    'Lees mee in Johannes (3:16) en let op.',
    'Heel, heel goed.',
  ])('leaves real speech untouched: %j', (text) => {
    expect(stripAsrArtifacts(text, 'nl')).toBe(text);
  });

  it('strips a trailing broadcaster credit', () => {
    expect(stripAsrArtifacts('Wij lezen uit Johannes. TV Gelderland 2021', 'nl')).toBe('Wij lezen uit Johannes.');
  });

  it('returns empty when nothing real is left', () => {
    expect(stripAsrArtifacts('[Muziek] Muziek.', 'nl')).toBe('');
    expect(stripAsrArtifacts('♪ ♪', 'nl')).toBe('');
  });

  it('collapses a decoder loop repeating one phrase', () => {
    expect(stripAsrArtifacts('Amen amen amen amen amen amen', 'nl')).toBe('Amen');
    expect(stripAsrArtifacts('ik ben het licht ik ben het licht ik ben het licht van de wereld', 'nl'))
      .toBe('ik ben het licht van de wereld');
  });

  it('keeps a short genuine repetition', () => {
    expect(stripAsrArtifacts('heel heel goed', 'nl')).toBe('heel heel goed');
  });
});
