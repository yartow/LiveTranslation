/**
 * Regression: API endpoints must return 400 (not 500) for missing required
 * fields. A 500 means the handler crashed rather than validated the input.
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

describe('Regression: missing required fields return 400, not 500', () => {
  it('/api/translate with no body → 400', async () => {
    const res = await request(server).post('/api/translate').send({});
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });

  it('/api/retranslate with no body → 400', async () => {
    const res = await request(server).post('/api/retranslate').send({});
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });

  it('/api/retroactive-correct with no body → 400', async () => {
    const res = await request(server).post('/api/retroactive-correct').send({});
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });

  it('/api/export-format with no body → 400', async () => {
    const res = await request(server).post('/api/export-format').send({});
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });

  it('/api/upload-to-drive with missing fileName → 400', async () => {
    const res = await request(server)
      .post('/api/upload-to-drive')
      .send({ fileContent: 'content' }); // missing fileName
    expect(res.status).toBe(400);
  });
});
