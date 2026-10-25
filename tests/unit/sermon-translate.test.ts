import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { translateSegments, modelLabel, type TranslateItemInput, type TranslateOptions, type TranslationLogEntry } from '../../server/lib/sermon-translate.js';

const baseOpts: TranslateOptions = {
  targetLanguage: 'en',
  translationProvider: 'openai',
};

// These tests exercise the provider-dispatch layer, not the glossary — point
// GLOSSARY_DIR at a directory with no files so translateSegments falls back
// to bundle:null deterministically, regardless of what happens to be on
// disk in data/ (gitignored, not present in CI) for whoever runs this suite.
let previousGlossaryDir: string | undefined;
beforeAll(() => {
  previousGlossaryDir = process.env.GLOSSARY_DIR;
  process.env.GLOSSARY_DIR = '/nonexistent/no-glossary-here';
});
afterAll(() => {
  if (previousGlossaryDir === undefined) delete process.env.GLOSSARY_DIR;
  else process.env.GLOSSARY_DIR = previousGlossaryDir;
});

describe('translateSegments', () => {
  it('translates each item independently and returns ok results', async () => {
    const items: TranslateItemInput[] = [
      { id: 'a', text: 'Genade zij u.', before: [], after: [] },
      { id: 'b', text: 'Amen.', before: ['Genade zij u.'], after: [] },
    ];
    const callModel = vi.fn(async (_system: string, userMessage: string) => {
      // Distinguish by the TARGET sentence, not just any mention — item
      // 'b' also carries 'Genade zij u.' as read-only <CONTEXT_VOOR>.
      if (userMessage.includes('<TE_VERTALEN>\nGenade zij u.')) return 'Grace to you.';
      return 'Amen.';
    });

    const results = await translateSegments(items, baseOpts, { callModel });

    expect(results).toEqual([
      { id: 'a', status: 'ok', translation: 'Grace to you.' },
      { id: 'b', status: 'ok', translation: 'Amen.' },
    ]);
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it('isolates a per-item failure — one bad segment does not fail the batch', async () => {
    const items: TranslateItemInput[] = [
      { id: 'good', text: 'Dit gaat goed.', before: [], after: [] },
      { id: 'bad', text: 'Dit faalt.', before: [], after: [] },
    ];
    const callModel = vi.fn(async (_system: string, userMessage: string) => {
      if (userMessage.includes('faalt')) throw new Error('rate limit exceeded');
      return 'This goes well.';
    });

    const results = await translateSegments(items, baseOpts, { callModel });
    const byId = new Map(results.map(r => [r.id, r]));

    expect(byId.get('good')).toEqual({ id: 'good', status: 'ok', translation: 'This goes well.' });
    const bad = byId.get('bad');
    expect(bad?.status).toBe('error');
    expect((bad as { error: string }).error.toLowerCase()).toContain('rate limit');
  });

  it('treats an empty translation as an error rather than overwriting with a blank string', async () => {
    const items: TranslateItemInput[] = [{ id: 'a', text: 'Zin.', before: [], after: [] }];
    const callModel = vi.fn(async () => '');

    const results = await translateSegments(items, baseOpts, { callModel });
    expect(results[0]).toMatchObject({ id: 'a', status: 'error' });
  });

  it('passes the same stable system prompt to every call in a batch', async () => {
    const items: TranslateItemInput[] = [
      { id: 'a', text: 'Een.', before: [], after: [] },
      { id: 'b', text: 'Twee.', before: [], after: [] },
      { id: 'c', text: 'Drie.', before: [], after: [] },
    ];
    const seenPrompts: string[] = [];
    const callModel = vi.fn(async (system: string) => { seenPrompts.push(system); return 'ok'; });

    await translateSegments(items, baseOpts, { callModel });

    expect(new Set(seenPrompts).size).toBe(1); // identical prompt across the whole batch
  });

  it('builds the user message with the <TE_VERTALEN> tag around the item text', async () => {
    const items: TranslateItemInput[] = [{ id: 'a', text: 'Specifieke zin.', before: ['Context.'], after: [] }];
    let capturedUserMessage = '';
    const callModel = vi.fn(async (_system: string, userMessage: string) => {
      capturedUserMessage = userMessage;
      return 'Specific sentence.';
    });

    await translateSegments(items, baseOpts, { callModel });

    expect(capturedUserMessage).toContain('<TE_VERTALEN>\nSpecifieke zin.\n</TE_VERTALEN>');
    expect(capturedUserMessage).toContain('<CONTEXT_VOOR>');
  });
});

describe('translateSegments — glossary warnings', () => {
  it('attaches a warning when a glossary term is present in the source but missing from the translation, and omits the key otherwise', async () => {
    const { join } = await import('path');
    const { _resetGlossaryForTests } = await import('../../server/lib/glossary-store.js');
    const fixturesDir = join(__dirname, '..', 'fixtures', 'glossary');
    const prevDir = process.env.GLOSSARY_DIR;
    process.env.GLOSSARY_DIR = fixturesDir;
    _resetGlossaryForTests();

    try {
      const opts: TranslateOptions = { ...baseOpts, glossaryCsv: 'mini.csv', disambiguationPrompt: 'mini.md' };
      const items: TranslateItemInput[] = [
        { id: 'miss', text: 'Hij is de Heiland, de Verlosser.', before: [], after: [] }, // Heiland -> Savior, translation below omits it
        { id: 'hit', text: 'Hij is de Heiland.', before: [], after: [] },
      ];

      // Distinguish the two calls by inspecting the user message's content
      // (each item's distinct source text ends up in <TE_VERTALEN>) rather
      // than by invocation order, which Promise.all doesn't actually guarantee.
      const callModelOrdered = vi.fn(async (_systemPrompt: string, userMessage: string) => {
        return userMessage.includes('Verlosser') ? 'He is the Redeemer.' : 'He is the Savior.';
      });

      const results = await translateSegments(items, opts, { callModel: callModelOrdered });
      const byId = new Map(results.map(r => [r.id, r]));

      const missResult = byId.get('miss') as { warnings?: unknown };
      expect(missResult.warnings).toEqual([{ term: 'Heiland', expected: 'Savior' }]);

      const hitResult = byId.get('hit') as { warnings?: unknown };
      expect(hitResult.warnings).toBeUndefined(); // omitted, not an empty array — keeps existing toEqual() assertions elsewhere passing
    } finally {
      if (prevDir === undefined) delete process.env.GLOSSARY_DIR; else process.env.GLOSSARY_DIR = prevDir;
      _resetGlossaryForTests();
    }
  });
});

describe('translateSegments — scripture (Bijbelcitaten AC11/AC12)', () => {
  const JOHN_3_16 = 'Want alzo lief heeft God de wereld gehad, dat Hij Zijn eniggeboren Zoon gegeven heeft, opdat een iegelijk die in Hem gelooft, niet verderve, maar het eeuwige leven hebbe.';

  async function withBibleFixture<T>(fn: () => Promise<T>): Promise<T> {
    const { join } = await import('path');
    const { _resetBibleStoreForTests } = await import('../../server/lib/bible-store.js');
    const { _resetBibleBooksForTests } = await import('../../server/lib/bible-books.js');
    const prevDir = process.env.BIBLE_DIR;
    process.env.BIBLE_DIR = join(__dirname, '..', 'fixtures', 'bible');
    _resetBibleStoreForTests();
    _resetBibleBooksForTests();
    try {
      return await fn();
    } finally {
      if (prevDir === undefined) delete process.env.BIBLE_DIR; else process.env.BIBLE_DIR = prevDir;
      _resetBibleStoreForTests();
      _resetBibleBooksForTests();
    }
  }

  it('a verbatim reading substitutes the verse text and never calls the model (AC11)', () => withBibleFixture(async () => {
    const items: TranslateItemInput[] = [
      { id: 'a', text: JOHN_3_16, before: [], after: [], readingCandidate: { bookNumber: 43, chapter: 3, verse: 16 } },
    ];
    const callModel = vi.fn(async () => 'should never be called');

    const results = await translateSegments(items, { ...baseOpts, bibleVersion: 'KJV' }, { callModel });

    expect(callModel).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      id: 'a', status: 'ok', translation: expect.stringContaining('For God so loved the world'),
      scripture: { verbatim: true, readingEnded: false, version: 'KJV' },
    });
  }));

  it('substitutes the operator-chosen version (LSB) from local text, and "none" does not decline it', () => withBibleFixture(async () => {
    const items: TranslateItemInput[] = [
      { id: 'a', text: JOHN_3_16, before: [], after: [], readingCandidate: { bookNumber: 43, chapter: 3, verse: 16 } },
    ];
    const callModel = vi.fn(async () => 'should never be called');

    const results = await translateSegments(items, { ...baseOpts, bibleVersion: 'LSB', scriptureFallback: 'none' }, { callModel });

    expect(callModel).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ id: 'a', status: 'ok', scripture: { verbatim: true, version: 'LSB' } });
  }));

  it('a paraphrase is translated normally, with the verse text passed as <VERSTEKST_ESV> guidance (AC12)', () => withBibleFixture(async () => {
    const paraphrase = 'Want alzo lief heeft God de wereld gehad dat Hij zijn Zoon gaf zodat iedereen die gelooft niet verloren gaat';
    const items: TranslateItemInput[] = [
      { id: 'a', text: paraphrase, before: [], after: [], readingCandidate: { bookNumber: 43, chapter: 3, verse: 16 } },
    ];
    let capturedUserMessage = '';
    const callModel = vi.fn(async (_system: string, userMessage: string) => {
      capturedUserMessage = userMessage;
      return 'His own paraphrase, translated.';
    });

    const results = await translateSegments(items, baseOpts, { callModel });

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(capturedUserMessage).toContain('<VERSTEKST_ESV>');
    expect(capturedUserMessage).toContain('For God so loved the world');
    expect(capturedUserMessage).toContain(`<TE_VERTALEN>\n${paraphrase}\n</TE_VERTALEN>`);
    expect(results[0]).toMatchObject({ id: 'a', status: 'ok', translation: 'His own paraphrase, translated.' });
    // Flagged so the client knows the announced reading is really under way, but never substituted.
    expect((results[0] as { scripture?: unknown }).scripture).toEqual({ verbatim: false, readingEnded: false, paraphrase: true, verseStart: 16 });
  }));

  it('an unrelated sentence is translated normally and flags readingEnded so the client stops checking further segments', () => withBibleFixture(async () => {
    const items: TranslateItemInput[] = [
      { id: 'a', text: 'En dit is waarom wij vanavond hier bijeen zijn.', before: [], after: [], readingCandidate: { bookNumber: 43, chapter: 3, verse: 16 } },
    ];
    const callModel = vi.fn(async () => 'And this is why we are gathered here tonight.');

    const results = await translateSegments(items, baseOpts, { callModel });

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ id: 'a', status: 'ok', scripture: { verbatim: false, readingEnded: true } });
  }));

  it('scriptureEnabled:false ignores a readingCandidate entirely', () => withBibleFixture(async () => {
    const items: TranslateItemInput[] = [
      { id: 'a', text: JOHN_3_16, before: [], after: [], readingCandidate: { bookNumber: 43, chapter: 3, verse: 16 } },
    ];
    const callModel = vi.fn(async () => 'Translated normally.');

    const results = await translateSegments(items, { ...baseOpts, scriptureEnabled: false }, { callModel });

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ id: 'a', status: 'ok', translation: 'Translated normally.' });
    expect((results[0] as { scripture?: unknown }).scripture).toBeUndefined();
  }));

  it('scriptureFallback:"none" declines a KJV-sourced verbatim hit and falls through to a normal translation, flagged readingEnded', () => withBibleFixture(async () => {
    const items: TranslateItemInput[] = [
      { id: 'a', text: JOHN_3_16, before: [], after: [], readingCandidate: { bookNumber: 43, chapter: 3, verse: 16 } },
    ];
    const callModel = vi.fn(async () => 'Model-translated instead of substituted.');

    const results = await translateSegments(items, { ...baseOpts, bibleVersion: 'NASB', scriptureFallback: 'none' }, { callModel });

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({
      id: 'a', status: 'ok', translation: 'Model-translated instead of substituted.',
      scripture: { verbatim: false, readingEnded: true },
    });
  }));

  it('an item with no readingCandidate is unaffected by the scripture pipeline', () => withBibleFixture(async () => {
    const items: TranslateItemInput[] = [{ id: 'a', text: 'Gewone preekzin, geen citaat.', before: [], after: [] }];
    const callModel = vi.fn(async () => 'Ordinary sermon sentence, not a quote.');

    const results = await translateSegments(items, baseOpts, { callModel });

    expect(results[0]).toEqual({ id: 'a', status: 'ok', translation: 'Ordinary sermon sentence, not a quote.' });
  }));
});

describe('translateSegments — translation log (deps.log)', () => {
  it('logs one entry per item with source, context, model, latency and the result', async () => {
    const entries: TranslationLogEntry[] = [];
    const items: TranslateItemInput[] = [
      { id: 'a', text: 'Genade zij u.', before: ['Voor.'], after: ['Na.'] },
      { id: 'b', text: 'Amen.', before: [], after: [] },
    ];
    await translateSegments(items, baseOpts, { callModel: async () => 'Grace.', log: e => entries.push(e) });

    expect(entries).toHaveLength(2);
    const a = entries.find(e => e.id === 'a')!;
    expect(a).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', source: 'Genade zij u.', before: ['Voor.'], after: ['Na.'], translation: 'Grace.' });
    expect(a.error).toBeUndefined();
    expect(typeof a.latencyMs).toBe('number');
    expect(new Date(a.at).toString()).not.toBe('Invalid Date');
  });

  it('logs a failed item with its error and no translation', async () => {
    const entries: TranslationLogEntry[] = [];
    await translateSegments(
      [{ id: 'bad', text: 'Dit faalt.', before: [], after: [] }], baseOpts,
      { callModel: async () => { throw new Error('rate limit exceeded'); }, log: e => entries.push(e) },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].error).toMatch(/rate limit/i);
    expect(entries[0].translation).toBeUndefined();
  });

  it('a throwing logger never breaks the translation', async () => {
    const results = await translateSegments(
      [{ id: 'a', text: 'Amen.', before: [], after: [] }], baseOpts,
      { callModel: async () => 'Amen.', log: () => { throw new Error('disk full'); } },
    );
    expect(results).toEqual([{ id: 'a', status: 'ok', translation: 'Amen.' }]);
  });
});

describe('modelLabel', () => {
  it('names the model the provider will really use', () => {
    expect(modelLabel({ translationProvider: 'openai' })).toBe('gpt-4o-mini');
    expect(modelLabel({ translationProvider: 'openai', model: 'gpt-4o' })).toBe('gpt-4o');
    expect(modelLabel({ translationProvider: 'ollama', ollamaModel: 'qwen2.5:14b' })).toBe('qwen2.5:14b');
    expect(modelLabel({ translationProvider: 'claude', model: 'ignored' })).toBe('claude-haiku-4-5-20251001');
  });
});

// A helper for the tests below that need the mini glossary (Heiland -> Savior).
async function withMiniGlossary<T>(fn: (opts: TranslateOptions) => Promise<T>): Promise<T> {
  const { join } = await import('path');
  const { _resetGlossaryForTests } = await import('../../server/lib/glossary-store.js');
  const prevDir = process.env.GLOSSARY_DIR;
  process.env.GLOSSARY_DIR = join(__dirname, '..', 'fixtures', 'glossary');
  _resetGlossaryForTests();
  try {
    return await fn({ ...baseOpts, glossaryCsv: 'mini.csv', disambiguationPrompt: 'mini.md' });
  } finally {
    if (prevDir === undefined) delete process.env.GLOSSARY_DIR; else process.env.GLOSSARY_DIR = prevDir;
    _resetGlossaryForTests();
  }
}

describe('translateSegments — retry when a glossary term is missing', () => {
  const item: TranslateItemInput = { id: 'a', text: 'Hij is de Heiland van de wereld.', before: [], after: [] };

  it('asks once more, naming the terms, and keeps the better answer', () => withMiniGlossary(async (opts) => {
    const entries: TranslationLogEntry[] = [];
    const callModel = vi.fn(async (_s: string, user: string) => user.includes('<TERMINOLOGIE_CORRECTIE>') ? 'He is the Savior of the world.' : 'He is the Redeemer of the world.');
    const [r] = await translateSegments([item], opts, { callModel, log: e => entries.push(e) });

    expect(callModel).toHaveBeenCalledTimes(2);
    const retryMessage = callModel.mock.calls[1][1];
    expect(retryMessage).toContain('"Savior" for "Heiland"');
    expect(retryMessage.indexOf('<TERMINOLOGIE_CORRECTIE>')).toBeLessThan(retryMessage.indexOf('<TE_VERTALEN>'));
    expect(r).toEqual({ id: 'a', status: 'ok', translation: 'He is the Savior of the world.' }); // no warnings left -> key omitted
    expect(entries[0].retried).toBe(true);
  }));

  it('keeps the first answer when the retry is no better', () => withMiniGlossary(async (opts) => {
    const callModel = vi.fn(async (_s: string, user: string) => user.includes('<TERMINOLOGIE_CORRECTIE>') ? 'He is the Lord of the world.' : 'He is the Redeemer of the world.');
    const [r] = await translateSegments([item], opts, { callModel });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: 'ok', translation: 'He is the Redeemer of the world.', warnings: [{ term: 'Heiland', expected: 'Savior' }] });
  }));

  it('keeps the first answer when the retry fails or comes back empty', () => withMiniGlossary(async (opts) => {
    for (const second of [() => { throw new Error('rate limit'); }, () => '   ']) {
      let n = 0;
      const callModel = vi.fn(async () => { if (n++ === 0) return 'He is the Redeemer of the world.'; return second() as string; });
      const [r] = await translateSegments([item], opts, { callModel });
      expect(r).toMatchObject({ status: 'ok', translation: 'He is the Redeemer of the world.' });
    }
  }));

  it('retries only once, and not at all when the first answer is fine', () => withMiniGlossary(async (opts) => {
    const fine = vi.fn(async () => 'He is the Savior of the world.');
    await translateSegments([item], opts, { callModel: fine });
    expect(fine).toHaveBeenCalledTimes(1);

    const bad = vi.fn(async () => 'He is the Redeemer of the world.');
    await translateSegments([item], opts, { callModel: bad });
    expect(bad).toHaveBeenCalledTimes(2);
  }));

  it('does not retry when glossary warnings are switched off', () => withMiniGlossary(async (opts) => {
    const callModel = vi.fn(async () => 'He is the Redeemer of the world.');
    await translateSegments([item], { ...opts, glossaryWarningsEnabled: false }, { callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
  }));
});

describe('translateSegments — examples from the operator\'s corrections', () => {
  it('puts them in every item\'s user message, outside the system prompt', async () => {
    const calls: Array<{ system: string; user: string }> = [];
    const callModel = vi.fn(async (system: string, user: string) => { calls.push({ system, user }); return 'Grace.'; });
    await translateSegments(
      [{ id: 'a', text: 'Genade zij u.', before: [], after: [] }, { id: 'b', text: 'Vrede zij u.', before: [], after: [] }],
      { ...baseOpts, examples: [{ source: 'De Heer zij met u.', machine: 'The Lord be with you.', human: 'The Lord be with you all.' }] },
      { callModel },
    );
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.user).toContain('<VOORBEELDEN_CORRECTIES>');
      expect(c.user).toContain('HUMAN: The Lord be with you all.');
      expect(c.system).not.toContain('The Lord be with you all.');
    }
  });

  it('sends none when there are none', async () => {
    const callModel = vi.fn(async (_s: string, _u: string) => 'Grace.');
    await translateSegments([{ id: 'a', text: 'Genade zij u.', before: [], after: [] }], baseOpts, { callModel });
    expect(callModel.mock.calls[0][1]).not.toContain('VOORBEELDEN');
  });
});

describe('translateSegments — back-translation check', () => {
  const item: TranslateItemInput = { id: 'a', text: 'Wij mogen vertrouwen op de trouw van onze God.', before: [], after: [] };
  // The translating call and the back-translating call are told apart by their system prompt.
  const model = (back: string) => vi.fn(async (system: string, _user: string) => system.startsWith('Translate the English text') ? back : 'We may trust in the faithfulness of our God.');

  it('is off by default: no second call, no score', async () => {
    const callModel = model('x');
    const [r] = await translateSegments([item], baseOpts, { callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ id: 'a', status: 'ok', translation: 'We may trust in the faithfulness of our God.' });
  });

  it('scores a faithful back-translation and does not flag it', async () => {
    const entries: TranslationLogEntry[] = [];
    const [r] = await translateSegments([item], { ...baseOpts, backTranslationCheck: true }, { callModel: model('Wij mogen vertrouwen op de trouw van onze God.'), log: e => entries.push(e) });
    expect(r).toMatchObject({ status: 'ok', fidelity: 1 });
    expect((r as { lowFidelity?: boolean }).lowFidelity).toBeUndefined();
    expect(entries[0]).toMatchObject({ fidelity: 1, backTranslation: 'Wij mogen vertrouwen op de trouw van onze God.' });
  });

  it('flags a back-translation that drifted below the threshold', async () => {
    const [r] = await translateSegments([item], { ...baseOpts, backTranslationCheck: true }, { callModel: model('Het regent vandaag hard in de stad.') });
    expect(r).toMatchObject({ status: 'ok', fidelity: 0, lowFidelity: true });
  });

  it('honours a custom threshold', async () => {
    const half = model('Wij mogen vertrouwen op de zon van de stad.');
    const strict = await translateSegments([item], { ...baseOpts, backTranslationCheck: true, backTranslationThreshold: 0.6 }, { callModel: half });
    const lenient = await translateSegments([item], { ...baseOpts, backTranslationCheck: true, backTranslationThreshold: 0.05 }, { callModel: half });
    expect((strict[0] as { lowFidelity?: boolean }).lowFidelity).toBe(true);
    expect((lenient[0] as { lowFidelity?: boolean }).lowFidelity).toBeUndefined();
  });

  it('skips segments too short to score, and never fails the translation if the check fails', async () => {
    const callModel = model('x');
    const [short] = await translateSegments([{ id: 's', text: 'Amen zeggen wij.', before: [], after: [] }], { ...baseOpts, backTranslationCheck: true }, { callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect((short as { fidelity?: number }).fidelity).toBeUndefined();

    const failing = vi.fn(async (system: string) => { if (system.startsWith('Translate the English text')) throw new Error('boom'); return 'We may trust in God.'; });
    const [r] = await translateSegments([item], { ...baseOpts, backTranslationCheck: true }, { callModel: failing });
    expect(r).toEqual({ id: 'a', status: 'ok', translation: 'We may trust in God.' });
  });
});
