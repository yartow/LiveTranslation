// Integration tests for GET /api/sermon/glossary/status and
// POST /api/sermon/glossary/reload. Pattern mirrors
// tests/integration/sermon-translate-api.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { join } from 'path';
import { registerRoutes } from '../../server/routes.js';
import { _resetGlossaryForTests } from '../../server/lib/glossary-store.js';
import type { Server } from 'http';

let server: Server;
const FIXTURES = join(__dirname, '..', 'fixtures', 'glossary');
let previousGlossaryDir: string | undefined;

beforeAll(async () => {
  previousGlossaryDir = process.env.GLOSSARY_DIR;
  process.env.GLOSSARY_DIR = FIXTURES;
  const app = express();
  app.use(express.json());
  server = await registerRoutes(app);
});

afterAll(() => {
  server.close();
  if (previousGlossaryDir === undefined) delete process.env.GLOSSARY_DIR;
  else process.env.GLOSSARY_DIR = previousGlossaryDir;
});

beforeEach(() => {
  _resetGlossaryForTests();
});

describe('GET /api/sermon/glossary/status', () => {
  it('200 with loaded:true for a valid csv+md pair', async () => {
    const res = await request(server).get('/api/sermon/glossary/status?csv=mini.csv&prompt=mini.md');
    expect(res.status).toBe(200);
    expect(res.body.loaded).toBe(true);
    expect(res.body.csv.fixedRows).toBeGreaterThan(0);
  });

  it('200 with loaded:false — never an error — even when nothing is loaded', async () => {
    const res = await request(server).get('/api/sermon/glossary/status');
    expect(res.status).toBe(200);
    // server default filenames don't exist in the fixtures dir
    expect(res.body.loaded).toBe(false);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('200 with loaded:false for a valid-but-absent filename (not a 400)', async () => {
    const res = await request(server).get('/api/sermon/glossary/status?csv=nope.csv&prompt=mini.md');
    expect(res.status).toBe(200);
    expect(res.body.loaded).toBe(false);
  });

  it('400 for a traversal attempt, with no filesystem content in the response body', async () => {
    const res = await request(server).get('/api/sermon/glossary/status?csv=' + encodeURIComponent('../../../etc/passwd'));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('root:');
  });

  it('400 for the wrong extension', async () => {
    const res = await request(server).get('/api/sermon/glossary/status?csv=notes.txt');
    expect(res.status).toBe(400);
  });

  it('lists available csv/md files in the fixtures directory', async () => {
    const res = await request(server).get('/api/sermon/glossary/status?csv=mini.csv&prompt=mini.md');
    expect(res.body.available.csv).toContain('mini.csv');
    expect(res.body.available.md).toContain('mini.md');
  });
});

describe('POST /api/sermon/glossary/reload', () => {
  it('200 and rebuilds diagnostics for a valid selection', async () => {
    const res = await request(server).post('/api/sermon/glossary/reload').send({ csv: 'mini.csv', prompt: 'mini.md' });
    expect(res.status).toBe(200);
    expect(res.body.loaded).toBe(true);
  });

  it('400 for a traversal attempt, with no filesystem content in the response body', async () => {
    const res = await request(server).post('/api/sermon/glossary/reload').send({ csv: '../../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('root:');
  });

  it('400 for a name containing a path separator', async () => {
    const res = await request(server).post('/api/sermon/glossary/reload').send({ prompt: 'a/b.md' });
    expect(res.status).toBe(400);
  });

  it('200 with loaded:false for a valid-but-absent filename', async () => {
    const res = await request(server).post('/api/sermon/glossary/reload').send({ csv: 'nope.csv', prompt: 'mini.md' });
    expect(res.status).toBe(200);
    expect(res.body.loaded).toBe(false);
  });
});
