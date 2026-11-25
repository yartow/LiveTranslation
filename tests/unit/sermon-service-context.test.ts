import { describe, it, expect } from 'vitest';
import {
  EMPTY_SERVICE_CONTEXT, normalizeServiceContext, isEmptyServiceContext, parseServiceTerms, glossaryWithService,
  parsePassages, plannedPassages, serviceContextForPrompt, serviceContextOverflow, glossaryWithServiceParts, passageKey, type ServiceContext,
} from '../../client/src/lib/sermon/service-context.js';
import { pickReadingCandidate } from '../../client/src/lib/sermon/reading-candidate.js';
import type { ActiveReading } from '../../client/src/lib/sermon/segment-store.js';

const ctx = (patch: Partial<ServiceContext> = {}): ServiceContext => ({ ...EMPTY_SERVICE_CONTEXT, ...patch });

describe('normalizeServiceContext', () => {
  it('keeps strings, drops everything else and caps the lengths', () => {
    expect(normalizeServiceContext({ title: 'T', passages: 'P', terms: 'X', notes: 'N' })).toEqual({ title: 'T', passages: 'P', terms: 'X', notes: 'N' });
    expect(normalizeServiceContext({ title: 5, passages: null, terms: {}, notes: [] })).toEqual(EMPTY_SERVICE_CONTEXT);
    expect(normalizeServiceContext('nonsense')).toEqual(EMPTY_SERVICE_CONTEXT);
    expect(normalizeServiceContext(undefined)).toEqual(EMPTY_SERVICE_CONTEXT);
    const big = normalizeServiceContext({ title: 'x'.repeat(999), terms: 'y'.repeat(99999) });
    expect(big.title).toHaveLength(200);
    expect(big.terms).toHaveLength(4000);
  });
  it('knows when it is empty', () => {
    expect(isEmptyServiceContext(EMPTY_SERVICE_CONTEXT)).toBe(true);
    expect(isEmptyServiceContext(ctx({ notes: '  \n ' }))).toBe(true);
    expect(isEmptyServiceContext(ctx({ title: 'x' }))).toBe(false);
  });
});

describe('parseServiceTerms / glossaryWithService', () => {
  it('reads plain terms and "heard = correct" lines, skipping blanks', () => {
    expect(parseServiceTerms('Reinier Milort\n\n  evengeven = evangelie  \n= \nKik=kind')).toEqual([
      { heard: '', correct: 'Reinier Milort' },
      { heard: 'evengeven', correct: 'evangelie' },
      { heard: 'Kik', correct: 'kind' },
    ]);
  });

  it('puts today\'s correct spellings (and the title) first, without "=" and without duplicates', () => {
    const g = glossaryWithService('genade\nverzoening = reconciliation', ctx({ title: 'Hebreeën 12', terms: 'evengeven = evangelie\nEvangelie\nReinier Milort' }));
    expect(g.split('\n')).toEqual(['Hebreeën 12', 'evangelie', 'Reinier Milort', 'genade', 'verzoening = reconciliation']);
  });

  it('leaves the standing glossary untouched when there is nothing for today', () => {
    expect(glossaryWithService('genade', EMPTY_SERVICE_CONTEXT)).toBe('genade');
    expect(glossaryWithService('', ctx({ terms: 'Milort' }))).toBe('Milort');
  });
});

describe('passages', () => {
  const c = ctx({ passages: 'Hebreeën 12:1-3\nonzin hier\nJohannes 3\nJohannes 3:16' });

  it('reads Dutch references and flags what it cannot read', () => {
    const p = parsePassages(c.passages);
    expect(p.map(x => !!x.ref)).toEqual([true, false, true, true]);
    expect(p[0].ref?.canonicalEn).toBe('Hebrews 12:1-3');
  });

  it('plannedPassages keeps only verse-level references, in order', () => {
    const planned = plannedPassages(c);
    expect(planned).toHaveLength(2); // "Johannes 3" has no verse
    expect(planned[0]).toMatchObject({ chapter: 12, verse: 1 });
    expect(planned[1]).toMatchObject({ chapter: 3, verse: 16 });
  });
});

describe('serviceContextForPrompt', () => {
  it('writes labelled lines the server can fence and filter', () => {
    const text = serviceContextForPrompt(ctx({
      title: 'Het geloof', passages: 'Hebreeën 12:1-3\nvaag', terms: 'Reinier Milort\nevengeven = evangelie', notes: 'Jongeren aanwezig\n',
    }));
    expect(text.split('\n')).toEqual([
      'Title: Het geloof',
      'Passage: Hebrews 12:1-3',
      'Passage: vaag',
      'Name/term: Reinier Milort',
      'Name/term: evangelie (may be heard as "evengeven")',
      'Note: Jongeren aanwezig',
    ]);
  });
  it('is empty when there is nothing', () => {
    expect(serviceContextForPrompt(EMPTY_SERVICE_CONTEXT)).toBe('');
  });
});

describe('pickReadingCandidate — own reference, then active reading, then planned passage', () => {
  const planned = plannedPassages(ctx({ passages: 'Hebreeën 12:1-3\nJohannes 3:16' }));
  const reading: ActiveReading = { bookNumber: 58, chapter: 12, nextVerse: 2, matched: true, misses: 0 };
  const none = new Set<string>();

  it('a reference in the text wins over everything and starts a reading', () => {
    const r = pickReadingCandidate({ text: 'Laten we lezen Johannes 3:16.', activeReading: reading, plannedPassages: planned, usedPlanned: none });
    expect(r).toMatchObject({ ownRef: true, planned: false, referenceHint: 'John 3:16', readingCandidate: { chapter: 3, verse: 16 } });
  });

  it('without a reference, an active reading continues at its next verse', () => {
    const r = pickReadingCandidate({ text: 'En laat ons de loopbaan lopen.', activeReading: reading, plannedPassages: planned, usedPlanned: none });
    expect(r).toMatchObject({ ownRef: false, planned: false, readingCandidate: { bookNumber: 58, chapter: 12, verse: 2 } });
  });

  it('with neither, the first planned passage not yet seen is the candidate', () => {
    const r = pickReadingCandidate({ text: 'Daarom ook wij, door zo\'n grote wolk.', activeReading: null, plannedPassages: planned, usedPlanned: none });
    expect(r).toMatchObject({ planned: true, ownRef: false, readingCandidate: { chapter: 12, verse: 1 } });

    const second = pickReadingCandidate({ text: 'x', activeReading: null, plannedPassages: planned, usedPlanned: new Set([passageKey(planned[0])]) });
    expect(second.readingCandidate).toMatchObject({ chapter: 3, verse: 16 });

    const all = pickReadingCandidate({ text: 'x', activeReading: null, plannedPassages: planned, usedPlanned: new Set(planned.map(passageKey)) });
    expect(all.readingCandidate).toBeUndefined();
  });

  it('nothing planned and nothing under way: no candidate', () => {
    expect(pickReadingCandidate({ text: 'Gewone zin.', activeReading: null, usedPlanned: none }).readingCandidate).toBeUndefined();
  });

  it('"not scripture" (scriptureOverride) switches detection off entirely', () => {
    const r = pickReadingCandidate({ text: 'Johannes 3:16', scriptureOverride: true, activeReading: reading, plannedPassages: planned, usedPlanned: none });
    expect(r).toEqual({ ownRef: false, planned: false });
  });

  it('a chapter-only reference gives a hint but no candidate, and does not fall through to the active reading', () => {
    const r = pickReadingCandidate({ text: 'We lezen Johannes 3 vanavond.', activeReading: reading, plannedPassages: planned, usedPlanned: none });
    expect(r.referenceHint).toBe('John 3');
    expect(r.readingCandidate).toBeUndefined();
    expect(r.ownRef).toBe(false);
  });
});

describe('serviceContextForPrompt size limit', () => {
  const terms = Array.from({ length: 100 }, (_, i) => `Naam nummer ${i} met een lange toevoeging`).join('\n');
  it('drops whole lines from the end (notes first) so the server never cuts mid-line', () => {
    const c = ctx({ title: 'Titel', terms, notes: 'Belangrijk thema' });
    const text = serviceContextForPrompt(c);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.startsWith('Title: Titel\nName/term: Naam nummer 0')).toBe(true);
    expect(text).not.toContain('Note:');
    expect(text.endsWith('toevoeging')).toBe(true);
    expect(serviceContextOverflow(c)).toBeGreaterThan(1);
  });
  it('sends everything that fits, and reports no overflow', () => {
    const c = ctx({ title: 'Titel', notes: 'Kort' });
    expect(serviceContextForPrompt(c)).toBe('Title: Titel\nNote: Kort');
    expect(serviceContextOverflow(c)).toBe(0);
  });
});

describe('glossaryWithServiceParts', () => {
  it('counts the service lines that must stay first', () => {
    expect(glossaryWithServiceParts('verbond', ctx({ title: 'Titel', terms: 'A\nB = C' }))).toEqual({ glossary: 'Titel\nA\nC\nverbond', priorityLines: 3 });
    expect(glossaryWithServiceParts('verbond', EMPTY_SERVICE_CONTEXT)).toEqual({ glossary: 'verbond', priorityLines: 0 });
  });
});
