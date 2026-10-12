import { describe, it, expect } from 'vitest';
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  SETTINGS_ITEMS,
  searchSettings,
  groupsForMode,
  defaultPageId,
  itemScope,
  getPage,
} from '../../client/src/components/settings/settings-index';

describe('settings index structure', () => {
  it('has unique page and item ids', () => {
    const pageIds = SETTINGS_PAGES.map((p) => p.id);
    const itemIds = SETTINGS_ITEMS.map((i) => i.id);
    expect(new Set(pageIds).size).toBe(pageIds.length);
    expect(new Set(itemIds).size).toBe(itemIds.length);
  });

  it('points every page at an existing group and every item at an existing page', () => {
    const groups = new Set(SETTINGS_GROUPS.map((g) => g.id));
    for (const p of SETTINGS_PAGES) expect(groups.has(p.group)).toBe(true);
    for (const i of SETTINGS_ITEMS) expect(getPage(i.page)).toBeDefined();
  });

  it('gives every page at least one item', () => {
    for (const p of SETTINGS_PAGES) {
      expect(SETTINGS_ITEMS.some((i) => i.page === p.id)).toBe(true);
    }
  });

  it('keeps the current mode group right after General, with Advanced last', () => {
    expect(groupsForMode('sermon').map((g) => g.id)).toEqual(['general', 'sermon', 'live', 'advanced']);
    expect(groupsForMode('live').map((g) => g.id)).toEqual(['general', 'live', 'sermon', 'advanced']);
    expect(groupsForMode('live').find((g) => g.isCurrent)?.id).toBe('live');
  });

  it("opens on the current mode's first page", () => {
    expect(getPage(defaultPageId('sermon'))?.group).toBe('sermon');
    expect(getPage(defaultPageId('live'))?.group).toBe('live');
  });

  it("lets an item override its page's scope", () => {
    const hints = SETTINGS_ITEMS.find((i) => i.id === 'vocab-hints')!;
    const csv = SETTINGS_ITEMS.find((i) => i.id === 'glossary-csv')!;
    expect(itemScope(hints)).toBe('both');
    expect(itemScope(csv)).toBe('sermon');
    // Falls back to the page scope when there is no override.
    expect(itemScope(SETTINGS_ITEMS.find((i) => i.id === 'ollama-url')!)).toBe('both');
  });
});

describe('searchSettings', () => {
  it('returns nothing for an empty or whitespace query', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('finds both the Sermon and Live correction settings', () => {
    const pages = searchSettings('correction').map((r) => r.page.id);
    expect(pages).toContain('sermon-correction');
    expect(pages).toContain('live-improve');
  });

  it('finds Local models for "ollama"', () => {
    expect(searchSettings('ollama').some((r) => r.page.id === 'ollama')).toBe(true);
  });

  it('is case-insensitive and requires every token to match', () => {
    expect(searchSettings('OLLAMA URL')[0].item.id).toBe('ollama-url');
    expect(searchSettings('ollama zzzzqq')).toEqual([]);
  });

  it('ranks label matches above description-only matches', () => {
    const results = searchSettings('silence');
    expect(results.length).toBeGreaterThan(0);
    const labelHit = results.findIndex((r) => r.item.label.toLowerCase().includes('silence'));
    const descOnlyHit = results.findIndex((r) => !r.item.label.toLowerCase().includes('silence'));
    if (labelHit !== -1 && descOnlyHit !== -1) expect(labelHit).toBeLessThan(descOnlyHit);
  });

  it('matches old Dutch labels via keywords so existing muscle memory still works', () => {
    expect(searchSettings('woordenlijst').some((r) => r.page.id === 'glossary')).toBe(true);
    expect(searchSettings('luisteraars').some((r) => r.page.id === 'sermon-listeners')).toBe(true);
  });
});
