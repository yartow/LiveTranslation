import { describe, it, expect } from 'vitest';
import { editSuggestions, segmentSubstitutions } from '../../client/src/lib/sermon/edit-suggestions.js';

const seg = (id: string, asrText: string, sourceText: string) => ({ id, asrText, sourceText });

describe('segmentSubstitutions', () => {
  it('finds a replaced word', () => {
    expect(segmentSubstitutions('Het evengeven is goed nieuws.', 'Het evangelie is goed nieuws.'))
      .toEqual([{ key: 'evengeven→evangelie', heard: 'evengeven', correct: 'evangelie' }]);
  });

  it('finds a replaced phrase and keeps it as one substitution', () => {
    const subs = segmentSubstitutions('Dat zei de bijbehouding van Paulus.', 'Dat zei de bijbelse houding van Paulus.');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ heard: 'bijbehouding', correct: 'bijbelse houding' });
  });

  it('ignores case, punctuation and accent-only changes', () => {
    expect(segmentSubstitutions('jezus zei: kom!', 'Jezus zei, kom.')).toEqual([]);
    expect(segmentSubstitutions('de Hebreeen', 'de Hebreeën')).toEqual([]);
  });

  it('ignores digit changes, pure insertions/deletions and rewordings of common words', () => {
    expect(segmentSubstitutions('in vers drie', 'in vers 3')).toEqual([]);
    expect(segmentSubstitutions('dit is goed', 'dit is heel goed')).toEqual([]);
    expect(segmentSubstitutions('dit is heel goed', 'dit is goed')).toEqual([]);
    expect(segmentSubstitutions('dan is het goed', 'dus is dat goed')).toEqual([]);
  });

  it('ignores a big rewrite instead of calling it a mishearing', () => {
    expect(segmentSubstitutions('a b c d e f g', 'x y z w q r s')).toEqual([]);
  });

  it('is empty for identical text', () => {
    expect(segmentSubstitutions('Genade zij u.', 'Genade zij u.')).toEqual([]);
  });
});

describe('editSuggestions', () => {
  it('suggests a correction seen in two rows, most frequent first', () => {
    const s = editSuggestions([
      seg('a', 'Het evengeven is goed.', 'Het evangelie is goed.'),
      seg('b', 'Kik is geboren.', 'Kind is geboren.'),
      seg('c', 'Wij horen het evengeven vandaag.', 'Wij horen het evangelie vandaag.'),
      seg('d', 'Een Kik in de kribbe.', 'Een kind in de kribbe.'),
      seg('e', 'Zo luidt het evengeven.', 'Zo luidt het evangelie.'),
    ]);
    expect(s.map(x => [x.heard, x.correct, x.count])).toEqual([['evengeven', 'evangelie', 3], ['Kik', 'kind', 2]]);
    expect(s[0].segmentIds).toEqual(['a', 'c', 'e']);
  });

  it('does not suggest a one-off correction of an ordinary word', () => {
    expect(editSuggestions([seg('a', 'Het vrouw was daar.', 'Het kind was daar.')])).toEqual([]);
  });

  it('does suggest a one-off that looks like a name close to what was heard', () => {
    const s = editSuggestions([seg('a', 'We gaan naar betlehem toe.', 'We gaan naar Bethlehem toe.')]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ heard: 'betlehem', correct: 'Bethlehem', count: 1 });
  });

  it('counts a row once however often the same fix is repeated inside it', () => {
    expect(editSuggestions([seg('a', 'kik en kik', 'kind en kind')])).toEqual([]);
  });

  it('leaves out what was dismissed', () => {
    const rows = [seg('a', 'Het evengeven.', 'Het evangelie.'), seg('b', 'Dat evengeven.', 'Dat evangelie.')];
    expect(editSuggestions(rows)).toHaveLength(1);
    expect(editSuggestions(rows, new Set(['evengeven→evangelie']))).toEqual([]);
  });

  it('skips untouched rows and survives a huge row', () => {
    const long = Array.from({ length: 800 }, (_, i) => `woord${i}`).join(' ');
    expect(editSuggestions([seg('a', 'zelfde', 'zelfde'), seg('b', long, long.replace('woord5', 'anders'))])).toEqual([]);
  });
});
