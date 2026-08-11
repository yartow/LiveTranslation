import { describe, it, expect, vi } from 'vitest';
import { translateSegments, type TranslateItemInput, type TranslateOptions } from '../../server/lib/sermon-translate.js';

const baseOpts: TranslateOptions = {
  targetLanguage: 'en',
  translationProvider: 'openai',
};

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
