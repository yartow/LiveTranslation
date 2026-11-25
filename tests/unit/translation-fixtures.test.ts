import { describe, it, expect } from 'vitest';
import { buildTranslationFixtures, type SnapshotSegment } from '../../scripts/lib/translation-fixtures.js';

const row = (index: number, sourceText: string, translatedText = '', manualOverride = false, machineText?: string): SnapshotSegment =>
  ({ index, sourceText, translatedText, manualOverride, machineText });

describe('buildTranslationFixtures', () => {
  const rows = [
    row(0, 'Goedemorgen allemaal, welkom.', 'Good morning everyone, welcome.'),                       // machine only: no reference
    row(1, 'De Heer zij met u allen.', 'The Lord be with you all.', true, 'The Lord be with you.'),   // corrected
    row(2, 'Laten we samen bidden voor de kerk.', 'Let us pray together for the church.'),
    row(3, 'Amen.', 'So be it.', true),                                                               // too short
    row(4, 'Wij lezen uit Hebreeën twaalf vers een.', 'We read from Hebrews twelve verse one.', true),// typed from scratch
    row(5, 'Daarom ook wij.', '', true),                                                              // empty reference
  ];

  it('keeps only rows the operator wrote or changed, with enough Dutch', () => {
    const items = buildTranslationFixtures(rows);
    expect(items.map(i => i.id)).toEqual(['seg-1', 'seg-4']);
  });

  it('carries the reference, the machine draft when there was one, and the neighbours as context', () => {
    const [first, second] = buildTranslationFixtures(rows);
    expect(first).toEqual({
      id: 'seg-1', source: 'De Heer zij met u allen.', reference: 'The Lord be with you all.', machine: 'The Lord be with you.',
      before: ['Goedemorgen allemaal, welkom.'], after: ['Laten we samen bidden voor de kerk.'],
    });
    expect(second.machine).toBeUndefined(); // typed from scratch
    expect(second.before).toEqual(['Laten we samen bidden voor de kerk.', 'Amen.']);
    expect(second.after).toEqual(['Daarom ook wij.']);
  });

  it('follows the app\'s context settings and the minimum length', () => {
    const [a] = buildTranslationFixtures(rows, { contextBefore: 0, contextAfter: 0 });
    expect(a.before).toEqual([]);
    expect(a.after).toEqual([]);
    expect(buildTranslationFixtures(rows, { minWords: 1 }).map(i => i.id)).toEqual(['seg-1', 'seg-3', 'seg-4']);
  });

  it('strips markdown from the reference and skips a formatting-only edit', () => {
    const items = buildTranslationFixtures([
      row(0, 'Psalm 23 vers 1. De Heere is mijn Herder.', 'Psalm 23:1.\n> The Lord is my shepherd.', true, 'Psalm 23:1. The Lord is my shepherd.'),
      row(1, 'Mij zal niets ontbreken, zegt hij.', '> **I shall not want**, he says.', true, 'I will lack nothing, he says.'),
    ]);
    expect(items.map(i => [i.id, i.reference])).toEqual([['seg-1', 'I shall not want, he says.']]);
  });

  it('works on rows given out of order, and on none', () => {
    expect(buildTranslationFixtures([...rows].reverse()).map(i => i.id)).toEqual(['seg-1', 'seg-4']);
    expect(buildTranslationFixtures([])).toEqual([]);
  });
});
