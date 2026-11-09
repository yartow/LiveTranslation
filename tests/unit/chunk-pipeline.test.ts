// Characterization tests for the per-chunk pipeline (processChunk in
// server/lib/chunk-transcription.ts): convert → Whisper → guard → artifact
// filters → learned corrections → correct/translate → ordered delivery.
// They pin what the browser receives and what the archive records, so the
// function can be split into steps without changing behaviour.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const m = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
  correctAndTranslateText: vi.fn(),
  correctTranscript: vi.fn(),
  correctAndTranslateWithClaude: vi.fn(),
  correctTranscriptWithClaude: vi.fn(),
  correctAndTranslateWithOllama: vi.fn(),
  correctTranscriptWithOllama: vi.fn(),
  transcribeWithMlxDetailed: vi.fn(),
}));

vi.mock('../../server/lib/openai.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/lib/openai.js')>()),
  transcribeAudio: m.transcribeAudio,
  correctAndTranslateText: m.correctAndTranslateText,
  correctTranscript: m.correctTranscript,
}));
vi.mock('../../server/lib/anthropic.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/lib/anthropic.js')>()),
  correctAndTranslateWithClaude: m.correctAndTranslateWithClaude,
  correctTranscriptWithClaude: m.correctTranscriptWithClaude,
}));
vi.mock('../../server/lib/ollama.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/lib/ollama.js')>()),
  correctAndTranslateWithOllama: m.correctAndTranslateWithOllama,
  correctTranscriptWithOllama: m.correctTranscriptWithOllama,
}));
vi.mock('../../server/lib/mlx-whisper.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/lib/mlx-whisper.js')>()),
  transcribeWithMlxDetailed: m.transcribeWithMlxDetailed,
}));

import { processChunk } from '../../server/lib/chunk-transcription.js';
import { resetAsrCorrectionsCache } from '../../server/lib/asr-corrections.js';

type Sent = Record<string, unknown>;

// 44-byte WAV header + 1 s of 16 kHz mono 16-bit silence: long enough to be a
// chunk, short of the 5 s the truncation guard looks at.
const WAV = Buffer.alloc(44 + 32_000);

function makeSession(over: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const clientWs = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) };
  const session = {
    clientWs,
    targetLanguage: 'en',
    sourceLanguage: 'nl',
    detectSpeakers: false,
    engine: 'openai',
    outputMode: 'translate',
    translationProvider: 'openai',
    openaiApiKey: 'ok',
    anthropicApiKey: 'ak',
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'qwen',
    glossary: '',
    sermonContext: '',
    debugMode: false,
    previousTranscript: '',
    nextExpectedChunk: 0,
    pendingResults: new Map(),
    abortController: new AbortController(),
    pendingChunkPromises: new Set(),
    archiveDir: null,
    chunkMeta: new Map(),
    ...over,
  };
  return { session: session as unknown as Parameters<typeof processChunk>[0], sent };
}

let glossaryDir: string;
const savedGlossaryDir = process.env.GLOSSARY_DIR;

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.transcribeAudio.mockResolvedValue('Goedemorgen allemaal');
  m.correctAndTranslateText.mockResolvedValue({ correctedText: 'Goedemorgen allemaal.', translatedText: 'Good morning everyone.' });
  m.correctTranscript.mockResolvedValue({ correctedText: 'Goedemorgen allemaal.' });
  m.correctAndTranslateWithClaude.mockResolvedValue({ correctedText: 'Goedemorgen, allemaal.', translatedText: 'Good morning, all.' });
  m.correctTranscriptWithClaude.mockResolvedValue({ correctedText: 'Goedemorgen, allemaal.' });
  m.correctAndTranslateWithOllama.mockResolvedValue({ correctedText: 'Goedemorgen!', translatedText: 'Good morning!' });
  m.correctTranscriptWithOllama.mockResolvedValue({ correctedText: 'Goedemorgen!' });
  glossaryDir = mkdtempSync(join(tmpdir(), 'chunk-pipeline-'));
  process.env.GLOSSARY_DIR = glossaryDir; // no asr-corrections.csv in here
  resetAsrCorrectionsCache();
});

afterEach(() => {
  if (savedGlossaryDir === undefined) delete process.env.GLOSSARY_DIR;
  else process.env.GLOSSARY_DIR = savedGlossaryDir;
  resetAsrCorrectionsCache();
  rmSync(glossaryDir, { recursive: true, force: true });
});

describe('processChunk: what the browser receives', () => {
  it('translate mode: raw preview, then the corrected + translated chunk, then progress', async () => {
    const { session, sent } = makeSession();
    await processChunk(session, WAV, 0, true);
    expect(sent).toEqual([
      { type: 'raw_transcript', text: 'Goedemorgen allemaal', chunkIndex: 0 },
      { type: 'translation', original: 'Goedemorgen allemaal.', translated: 'Good morning everyone.', chunkIndex: 0, isFinal: true },
      { type: 'chunk_progress', done: 1 },
    ]);
    expect(m.correctAndTranslateText).toHaveBeenCalledTimes(1);
  });

  it('sermon (correct-only) mode: corrects with the chosen provider and never translates', async () => {
    const { session, sent } = makeSession({ outputMode: 'correct-only', translationProvider: 'claude' });
    await processChunk(session, WAV, 0, true);
    expect(m.correctTranscriptWithClaude).toHaveBeenCalledTimes(1);
    expect(m.correctAndTranslateWithClaude).not.toHaveBeenCalled();
    expect(sent.find(s => s.type === 'translation')).toEqual({
      type: 'translation', original: 'Goedemorgen, allemaal.', translated: '', chunkIndex: 0, isFinal: true,
    });
  });

  it.each([
    ['ollama', 'correctTranscriptWithOllama', 'Goedemorgen!'],
    ['openai', 'correctTranscript', 'Goedemorgen allemaal.'],
  ] as const)('sermon mode routes %s to %s', async (provider, fn, expected) => {
    const { session, sent } = makeSession({ outputMode: 'correct-only', translationProvider: provider });
    await processChunk(session, WAV, 0, true);
    expect(m[fn]).toHaveBeenCalledTimes(1);
    expect((sent.find(s => s.type === 'translation') as Sent).original).toBe(expected);
  });

  it('sermon mode with provider "none" keeps the Whisper text untouched', async () => {
    const { session, sent } = makeSession({ outputMode: 'correct-only', translationProvider: 'none' });
    await processChunk(session, WAV, 0, true);
    expect((sent.find(s => s.type === 'translation') as Sent).original).toBe('Goedemorgen allemaal');
    expect(m.correctTranscript).not.toHaveBeenCalled();
  });

  it('translate mode with provider "none" skips the LLM and sends no translation text', async () => {
    const { session, sent } = makeSession({ translationProvider: 'none' });
    await processChunk(session, WAV, 0, true);
    expect(sent.find(s => s.type === 'translation')).toMatchObject({ original: 'Goedemorgen allemaal', translated: '' });
    expect(m.correctAndTranslateText).not.toHaveBeenCalled();
  });

  it('keeps the raw text when the optional correction step fails', async () => {
    m.correctTranscript.mockRejectedValue(new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { session, sent } = makeSession({ outputMode: 'correct-only' });
    await processChunk(session, WAV, 0, true);
    err.mockRestore();
    expect((sent.find(s => s.type === 'translation') as Sent).original).toBe('Goedemorgen allemaal');
    expect(sent.find(s => s.type === 'chunk_error')).toBeUndefined();
  });

  it('strips asterisk artifacts from the LLM output', async () => {
    m.correctAndTranslateText.mockResolvedValue({ correctedText: '*** Goedemorgen.', translatedText: 'Good ** morning.' });
    const { session, sent } = makeSession();
    await processChunk(session, WAV, 0, true);
    expect(sent.find(s => s.type === 'translation')).toMatchObject({ original: 'Goedemorgen.', translated: 'Good morning.' });
  });
});

describe('processChunk: chunks that produce no text', () => {
  it('silence: nothing but progress is sent, and the LLM is never called', async () => {
    m.transcribeAudio.mockResolvedValue('   ');
    const { session, sent } = makeSession();
    await processChunk(session, WAV, 0, true);
    expect(sent).toEqual([{ type: 'chunk_progress', done: 1 }]);
    expect(m.correctAndTranslateText).not.toHaveBeenCalled();
  });

  it('a caption hallucination is discarded', async () => {
    m.transcribeAudio.mockResolvedValue('Muziek');
    const { session, sent } = makeSession();
    await processChunk(session, WAV, 0, true);
    expect(sent).toEqual([{ type: 'chunk_progress', done: 1 }]);
    expect(m.correctAndTranslateText).not.toHaveBeenCalled();
  });

  it('removes a caption from real speech and sends the rest', async () => {
    m.transcribeAudio.mockResolvedValue('[Muziek] Goedemorgen allemaal');
    const { session, sent } = makeSession();
    await processChunk(session, WAV, 0, true);
    expect(sent[0]).toEqual({ type: 'raw_transcript', text: 'Goedemorgen allemaal', chunkIndex: 0 });
    expect(m.correctAndTranslateText.mock.calls[0][0]).toBe('Goedemorgen allemaal');
  });

  it('a session aborted before transcription ends the chunk quietly', async () => {
    const { session, sent } = makeSession();
    session.abortController.abort();
    await processChunk(session, WAV, 0, true);
    expect(sent).toEqual([{ type: 'chunk_progress', done: 1 }]);
    expect(m.transcribeAudio).not.toHaveBeenCalled();
  });

  it('an AbortError from the LLM is not reported as an error', async () => {
    m.correctAndTranslateText.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const { session, sent } = makeSession();
    await processChunk(session, WAV, 0, true);
    expect(sent.map(s => s.type)).toEqual(['raw_transcript', 'chunk_progress']);
  });

  it('a transcription failure sends chunk_error and still advances the queue', async () => {
    m.transcribeAudio.mockRejectedValue(Object.assign(new Error('401'), { status: 401 }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { session, sent } = makeSession();
    await processChunk(session, WAV, 3, true);
    err.mockRestore();
    // chunk 3 is not next in line (0 is), so only the error is visible yet…
    expect(sent).toEqual([{ type: 'chunk_error', message: 'API key invalid or missing', chunkIndex: 3 }]);
    expect(session.pendingResults.has(3)).toBe(true);
  });
});

describe('processChunk: ordering', () => {
  it('holds a finished chunk until the earlier one is done', async () => {
    const { session, sent } = makeSession();
    await processChunk(session, WAV, 1, true);
    expect(sent.some(s => s.type === 'translation')).toBe(false);
    await processChunk(session, WAV, 0, true);
    const translations = sent.filter(s => s.type === 'translation').map(s => s.chunkIndex);
    expect(translations).toEqual([0, 1]);
    expect(sent.at(-1)).toEqual({ type: 'chunk_progress', done: 2 });
  });
});

describe('processChunk: Whisper input', () => {
  it('passes the session glossary, context and previous text to Whisper', async () => {
    const { session } = makeSession({ glossary: 'Genade', sermonContext: 'Romeinen 8', previousTranscript: 'En zo verder.' });
    await processChunk(session, WAV, 0, true);
    const args = m.transcribeAudio.mock.calls[0];
    expect(args[1]).toBe('nl');
    expect(args[3]).toBe('Genade');
    expect(args[4]).toBe('Romeinen 8');
    expect(args[6]).toBe('En zo verder.');
  });

  it('MLX engine: forwards low-confidence words and records the attempt in the archive', async () => {
    m.transcribeWithMlxDetailed.mockResolvedValue({
      text: 'Goedemorgen allemaal',
      diag: { duration: 1, segments: [], uncovered: [] },
      // most doubtful first; "Ja" is under the 4-letter minimum, 0.9 is above the threshold
      uncertain: [{ word: 'allemaal', p: 0.2 }, { word: 'Goed', p: 0.1 }, { word: 'Ja', p: 0.05 }, { word: 'morgen', p: 0.9 }],
    });
    const archiveDir = mkdtempSync(join(tmpdir(), 'chunk-archive-'));
    try {
      const { session, sent } = makeSession({ engine: 'mlx', archiveDir });
      await processChunk(session, WAV, 0, true);
      expect(sent.find(s => s.type === 'translation')).toMatchObject({ lowWords: ['Goed', 'allemaal'] });
      const record = JSON.parse(readFileSync(join(archiveDir, '0.json'), 'utf8'));
      expect(record).toMatchObject({
        chunkIndex: 0,
        rawText: 'Goedemorgen allemaal',
        strippedText: 'Goedemorgen allemaal',
        correctedText: 'Goedemorgen allemaal.',
        guardRetried: false,
      });
      expect(record.attempts).toHaveLength(1);
      expect(record.transcribedAt).toBeTruthy();
      expect(record.correctedAt).toBeTruthy();
      expect(record.deliveredAt).toBeTruthy();
      expect(existsSync(join(archiveDir, '0.wav'))).toBe(true);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });

  describe('archive: where the time went, and whether the chunk was cut off', () => {
    const withArchive = async (run: (archiveDir: string) => Promise<void>) => {
      const archiveDir = mkdtempSync(join(tmpdir(), 'chunk-archive-'));
      try { await run(archiveDir); } finally { rmSync(archiveDir, { recursive: true, force: true }); }
    };
    const record = (archiveDir: string, idx = 0) => JSON.parse(readFileSync(join(archiveDir, `${idx}.json`), 'utf8'));

    it('records how long the chunk waited for the Whisper slot and the worker\'s own decode time', () => withArchive(async (archiveDir) => {
      m.transcribeWithMlxDetailed.mockResolvedValue({ text: 'Goedemorgen allemaal', diag: null, decodeSecs: 1.8 });
      const { session } = makeSession({ engine: 'mlx', archiveDir });
      await processChunk(session, WAV, 0, true);
      const r = record(archiveDir);
      expect(r.slotWaitMs).toBeGreaterThanOrEqual(0);
      expect(r.slotWaitMs).toBeLessThan(2000);
      expect(r.attempts[0].decodeSecs).toBe(1.8);
      expect(r.aborted).toBeUndefined();
    }));

    it('marks a chunk the session gave up on as aborted, so it is not mistaken for silence', () => withArchive(async (archiveDir) => {
      const { session } = makeSession({ engine: 'mlx', archiveDir });
      session.abortController.abort();
      await processChunk(session, WAV, 0, true);
      expect(record(archiveDir)).toMatchObject({ aborted: true });
      expect(m.transcribeWithMlxDetailed).not.toHaveBeenCalled();
    }));

    it('marks a chunk aborted while Whisper was running (an aborted transcription answers with empty text)', () => withArchive(async (archiveDir) => {
      const { session } = makeSession({ engine: 'mlx', archiveDir });
      m.transcribeWithMlxDetailed.mockImplementation(async () => { session.abortController.abort(); return { text: '', diag: null }; });
      await processChunk(session, WAV, 0, true);
      expect(record(archiveDir)).toMatchObject({ aborted: true, rawText: '' });
    }));

    it('does not mark a chunk Whisper genuinely heard nothing in', () => withArchive(async (archiveDir) => {
      m.transcribeWithMlxDetailed.mockResolvedValue({ text: '', diag: null, decodeSecs: 0.4 });
      const { session } = makeSession({ engine: 'mlx', archiveDir });
      await processChunk(session, WAV, 0, true);
      expect(record(archiveDir).aborted).toBeUndefined();
    }));
  });
});
