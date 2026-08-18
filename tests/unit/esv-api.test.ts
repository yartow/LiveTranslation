import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fetchEsvPassage } from '../../server/lib/esv-api.js';

describe('fetchEsvPassage', () => {
  let cacheDir: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'esv-cache-test-'));
    process.env.ESV_CACHE_DIR = cacheDir;
  });
  afterEach(() => {
    delete process.env.ESV_CACHE_DIR;
    delete process.env.ESV_API_KEY;
    global.fetch = originalFetch;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns null (never throws) when no API key is configured', async () => {
    delete process.env.ESV_API_KEY;
    const result = await fetchEsvPassage('John', 3, 16, 16, {});
    expect(result).toBeNull();
  });

  it('fetches and returns passage text, stripped of whitespace runs', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ passages: ['  For God so loved   the world...  '] }),
    }) as unknown as typeof fetch;

    const result = await fetchEsvPassage('John', 3, 16, 16, { apiKey: 'test-key' });
    expect(result).toBe('For God so loved the world...');
  });

  it('caches a fetched passage to disk and serves it without calling fetch again', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ passages: ['For God so loved the world...'] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = await fetchEsvPassage('John', 3, 16, 16, { apiKey: 'test-key' });
    expect(first).toBe('For God so loved the world...');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(join(cacheDir, 'john-3-16-16.txt'))).toBe(true);

    const second = await fetchEsvPassage('John', 3, 16, 16, { apiKey: 'test-key' });
    expect(second).toBe('For God so loved the world...');
    expect(fetchMock).toHaveBeenCalledTimes(1); // still 1 — served from cache
  });

  it('returns null (never throws) on a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;
    const result = await fetchEsvPassage('John', 3, 16, 16, { apiKey: 'bad-key' });
    expect(result).toBeNull();
  });

  it('returns null (never throws) when fetch itself rejects', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const result = await fetchEsvPassage('John', 3, 16, 16, { apiKey: 'test-key' });
    expect(result).toBeNull();
  });

  it('returns null (never throws) for an empty passages array', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ passages: [] }) }) as unknown as typeof fetch;
    const result = await fetchEsvPassage('John', 3, 16, 16, { apiKey: 'test-key' });
    expect(result).toBeNull();
  });
});
