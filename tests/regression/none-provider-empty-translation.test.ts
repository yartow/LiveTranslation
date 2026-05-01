/**
 * Regression: provider=none must return translatedText="" (empty string), NOT
 * the original source text. The bug was in the Claude fallback: parseJsonResponse
 * returned { translatedText: originalText } instead of { translatedText: "" }.
 * These tests verify the correct behaviour at the HTTP layer.
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

afterAll(() => server.close());

describe('Regression: provider=none never returns source text as translation', () => {
  it('/api/translate returns translatedText="" not the original text', async () => {
    const text = 'This is the source text that must not appear as a translation.';
    const res = await request(server)
      .post('/api/translate')
      .send({ text, targetLanguage: 'nl', translationProvider: 'none' });

    expect(res.status).toBe(200);
    expect(res.body.translatedText).toBe('');
    expect(res.body.translatedText).not.toBe(text);
  });

  it('/api/retranslate returns translatedText="" not the original text', async () => {
    const text = 'Source text that must not appear as translation.';
    const res = await request(server)
      .post('/api/retranslate')
      .send({ originalText: text, targetLanguage: 'de', translationProvider: 'none' });

    expect(res.status).toBe(200);
    expect(res.body.translatedText).toBe('');
    expect(res.body.translatedText).not.toBe(text);
  });

  it('/api/retroactive-correct returns translatedText="" not the original text', async () => {
    const text = 'Accumulated text that must not appear as translation.';
    const res = await request(server)
      .post('/api/retroactive-correct')
      .send({ accumulatedText: text, targetLanguage: 'fr', translationProvider: 'none' });

    expect(res.status).toBe(200);
    expect(res.body.translatedText).toBe('');
    expect(res.body.translatedText).not.toBe(text);
  });
});
