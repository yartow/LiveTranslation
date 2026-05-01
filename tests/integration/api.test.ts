/**
 * Integration tests for the HTTP API endpoints.
 * All tests use translationProvider=none so no external API calls are made.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registerRoutes } from '../../server/routes.js';
import type { Server } from 'http';

let server: Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  server = await registerRoutes(app);
});

afterAll(() => {
  server.close();
});

// ── /api/translate ────────────────────────────────────────────────────────────

describe('POST /api/translate', () => {
  it('returns correctedText = input and translatedText = "" for provider=none', async () => {
    const res = await request(server)
      .post('/api/translate')
      .send({ text: 'Hello world', targetLanguage: 'nl', translationProvider: 'none' });

    expect(res.status).toBe(200);
    expect(res.body.correctedText).toBe('Hello world');
    expect(res.body.translatedText).toBe('');
  });

  it('returns 400 when text is missing', async () => {
    const res = await request(server)
      .post('/api/translate')
      .send({ targetLanguage: 'nl', translationProvider: 'none' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('passes through non-ASCII text unchanged with provider=none', async () => {
    const res = await request(server)
      .post('/api/translate')
      .send({ text: 'Привет мир', targetLanguage: 'en', translationProvider: 'none' });

    expect(res.status).toBe(200);
    expect(res.body.correctedText).toBe('Привет мир');
  });
});

// ── /api/retranslate ──────────────────────────────────────────────────────────

describe('POST /api/retranslate', () => {
  it('returns originalText unchanged and translatedText="" for provider=none', async () => {
    const res = await request(server)
      .post('/api/retranslate')
      .send({ originalText: 'Some text', targetLanguage: 'nl', translationProvider: 'none' });

    expect(res.status).toBe(200);
    expect(res.body.translatedText).toBe('');
  });

  it('returns 400 when originalText is missing', async () => {
    const res = await request(server)
      .post('/api/retranslate')
      .send({ targetLanguage: 'nl', translationProvider: 'none' });

    expect(res.status).toBe(400);
  });
});

// ── /api/retroactive-correct ──────────────────────────────────────────────────

describe('POST /api/retroactive-correct', () => {
  it('returns accumulatedText unchanged and translatedText="" for provider=none', async () => {
    const res = await request(server)
      .post('/api/retroactive-correct')
      .send({ accumulatedText: 'Some long text.', targetLanguage: 'nl', translationProvider: 'none' });

    expect(res.status).toBe(200);
    expect(res.body.correctedText).toBe('Some long text.');
    expect(res.body.translatedText).toBe('');
  });

  it('returns 400 when accumulatedText is missing', async () => {
    const res = await request(server)
      .post('/api/retroactive-correct')
      .send({ targetLanguage: 'nl', translationProvider: 'none' });

    expect(res.status).toBe(400);
  });
});
