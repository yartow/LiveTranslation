/**
 * Validation tests for POST /api/sermon/translate. Only the validation
 * paths are exercised here (all return 400 before any provider is called) —
 * dispatch/success-path behaviour is covered without network calls in
 * tests/unit/sermon-translate.test.ts via an injected deps.callModel.
 * Sermon mode has no translationProvider:'none' escape hatch (unlike
 * /api/translate), so there's no way to hit the success path here without
 * a real API key — matching the pattern in tests/regression/api-validation.test.ts.
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

const validItem = { id: 'seg_1', text: 'Genade zij u.', before: [], after: [] };

describe('POST /api/sermon/translate — validation', () => {
  it('400 with no body at all', async () => {
    const res = await request(server).post('/api/sermon/translate').send({});
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });

  it('400 when items is missing', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({ translationProvider: 'openai', targetLanguage: 'en' });
    expect(res.status).toBe(400);
  });

  it('400 when items is an empty array', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({ translationProvider: 'openai', items: [] });
    expect(res.status).toBe(400);
  });

  it('400 when items exceeds 100 entries', async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, text: `Zin ${i}.` }));
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({ translationProvider: 'openai', items });
    expect(res.status).toBe(400);
  });

  it('400 when an item has empty text', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({ translationProvider: 'openai', items: [{ id: 'a', text: '' }] });
    expect(res.status).toBe(400);
  });

  it('400 when an item text exceeds 2000 characters', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({ translationProvider: 'openai', items: [{ id: 'a', text: 'x'.repeat(2001) }] });
    expect(res.status).toBe(400);
  });

  it('400 when before/after exceed 5 context sentences', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({
        translationProvider: 'openai',
        items: [{ id: 'a', text: 'Zin.', before: ['1', '2', '3', '4', '5', '6'], after: [] }],
      });
    expect(res.status).toBe(400);
  });

  it('400 when translationProvider is missing', async () => {
    const res = await request(server).post('/api/sermon/translate').send({ items: [validItem] });
    expect(res.status).toBe(400);
  });

  it('400 when translationProvider is "none" — sermon mode always requires a real provider', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({ translationProvider: 'none', items: [validItem] });
    expect(res.status).toBe(400);
  });

  it('400 when translationProvider is unrecognised', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({ translationProvider: 'not-a-provider', items: [validItem] });
    expect(res.status).toBe(400);
  });

  it('400 when glossaryCsv is a traversal attempt — rejected before any provider call', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({ translationProvider: 'openai', items: [validItem], glossaryCsv: '../../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('root:');
  });

  it('400 when disambiguationPrompt has the wrong extension', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({ translationProvider: 'openai', items: [validItem], disambiguationPrompt: 'notes.txt' });
    expect(res.status).toBe(400);
  });

  it('400 when an item\'s readingCandidate has a bookNumber out of the 1-66 range', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({
        translationProvider: 'openai',
        items: [{ ...validItem, readingCandidate: { bookNumber: 67, chapter: 1, verse: 1 } }],
      });
    expect(res.status).toBe(400);
  });

  it('400 when an item\'s readingCandidate has a non-integer chapter/verse', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({
        translationProvider: 'openai',
        items: [{ ...validItem, readingCandidate: { bookNumber: 43, chapter: 3.5, verse: 16 } }],
      });
    expect(res.status).toBe(400);
  });

  it('400 when referenceHint exceeds the length cap', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({ translationProvider: 'openai', items: [{ ...validItem, referenceHint: 'x'.repeat(61) }] });
    expect(res.status).toBe(400);
  });

  it('400 when scriptureFallback is not "kjv" or "none"', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({ translationProvider: 'openai', items: [validItem], scriptureFallback: 'esv-only' });
    expect(res.status).toBe(400);
  });

  it('a well-formed readingCandidate/referenceHint pass validation (fails later only for lack of a real provider key)', async () => {
    const res = await request(server)
      .post('/api/sermon/translate')
      .send({
        translationProvider: 'openai',
        items: [{ ...validItem, readingCandidate: { bookNumber: 43, chapter: 3, verse: 16 }, referenceHint: 'John 3:16' }],
      });
    // Not a 400 — validation passed; it may still fail downstream (no API key in this test env).
    expect(res.status).not.toBe(400);
  });
});
