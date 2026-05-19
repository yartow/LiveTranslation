/**
 * WER Benchmark — requires a running server and real API keys.
 * Skips automatically if OPENAI_API_KEY is not set.
 *
 * Usage:
 *   npm run test:regression -- --reporter=verbose
 *
 * Place audio files in tests/fixtures/audio/ and matching reference
 * transcripts in tests/fixtures/reference/. See tests/fixtures/README.md.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readdir, readFile, writeFile } from 'fs/promises';
import { join, basename, extname } from 'path';
import { existsSync } from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

import {
  computeWER,
  computeCER,
  countGlossaryHits,
  formatResultsTable,
  type BenchmarkResult,
} from '../lib/wer';

// ── Config ───────────────────────────────────────────────────────────────────

const SERVER_URL = process.env.TEST_SERVER_URL ?? 'http://localhost:5000';
const AUDIO_DIR = join(__dirname, '../fixtures/audio');
const REF_DIR = join(__dirname, '../fixtures/reference');
const RESULTS_DIR = join(__dirname, '../fixtures');

const THEOLOGICAL_GLOSSARY_TERMS = [
  'sanctification', 'atonement', 'covenant', 'eschatology',
  'soteriology', 'pneumatology', 'justification', 'redemption',
];

// Config matrix: each combination is tested per audio fixture.
const CONFIGS: Array<{
  chunkDurationSecs: number;
  chunkOverlapMs: number;
  useTranscriptContext: boolean;
}> = [
  { chunkDurationSecs: 5,  chunkOverlapMs: 0,   useTranscriptContext: false },
  { chunkDurationSecs: 5,  chunkOverlapMs: 500, useTranscriptContext: false },
  { chunkDurationSecs: 5,  chunkOverlapMs: 500, useTranscriptContext: true  },
  { chunkDurationSecs: 10, chunkOverlapMs: 0,   useTranscriptContext: false },
  { chunkDurationSecs: 10, chunkOverlapMs: 500, useTranscriptContext: true  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAudioFixtures(): Promise<string[]> {
  if (!existsSync(AUDIO_DIR)) return [];
  const files = await readdir(AUDIO_DIR);
  return files
    .filter(f => /\.(mp3|wav|m4a|ogg|flac)$/i.test(f))
    .map(f => join(AUDIO_DIR, f));
}

async function getReferenceForAudio(audioPath: string): Promise<string | null> {
  const stem = basename(audioPath, extname(audioPath));
  const refPath = join(REF_DIR, `${stem}.txt`);
  if (!existsSync(refPath)) return null;
  return (await readFile(refPath, 'utf8')).trim();
}

async function transcribeViaHttp(
  audioPath: string,
  chunkDurationSecs: number,
  chunkOverlapMs: number,
  useTranscriptContext: boolean,
  previousTranscript: string,
): Promise<string> {
  const form = new FormData();
  form.append('audio', await readFile(audioPath), {
    filename: basename(audioPath),
    contentType: 'audio/mpeg',
  });
  form.append('sourceLanguage', 'en');
  form.append('targetLanguage', 'en');
  form.append('translationProvider', 'none');
  form.append('chunkDurationSecs', String(chunkDurationSecs));
  form.append('chunkOverlapMs', String(chunkOverlapMs));
  if (useTranscriptContext && previousTranscript) {
    form.append('previousTranscript', previousTranscript.slice(-300));
  }

  const res = await fetch(`${SERVER_URL}/api/transcribe`, {
    method: 'POST',
    body: form as any,
    headers: form.getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const data = await res.json() as { originalText?: string };
  return data.originalText ?? '';
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WER Benchmark', () => {
  const hasApiKey = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'test-key-stub');

  beforeAll(() => {
    if (!hasApiKey) {
      console.log('⚠  OPENAI_API_KEY not set — WER benchmark skipped');
    }
  });

  it('WER unit tests — computeWER / computeCER', () => {
    expect(computeWER('hello world', 'hello world')).toBe(0);
    expect(computeWER('hello world', 'hello')).toBeCloseTo(0.5, 2);
    expect(computeWER('hello world', 'hello planet')).toBeCloseTo(0.5, 2);
    expect(computeWER('hello world', '')).toBe(1);
    expect(computeWER('', '')).toBe(0);
    expect(computeCER('abc', 'abc')).toBe(0);
    expect(computeCER('abc', 'ab')).toBeCloseTo(0.333, 2);
  });

  it('glossary hit counting', () => {
    const { hits, total } = countGlossaryHits(['sanctification', 'atonement'], 'sanctification is the process of atonement');
    expect(hits).toBe(2);
    expect(total).toBe(2);
  });

  it('full benchmark run', async () => {
    if (!hasApiKey) return;

    const audioFiles = await getAudioFixtures();
    if (audioFiles.length === 0) {
      console.log('No audio fixtures found — skipping. See tests/fixtures/README.md.');
      return;
    }

    const allResults: BenchmarkResult[] = [];

    for (const audioPath of audioFiles) {
      const reference = await getReferenceForAudio(audioPath);
      if (!reference) {
        console.log(`No reference for ${basename(audioPath)} — skipping`);
        continue;
      }

      const fixtureName = basename(audioPath, extname(audioPath));
      let prevTranscript = '';

      for (const cfg of CONFIGS) {
        const start = Date.now();
        let hypothesis: string;

        try {
          hypothesis = await transcribeViaHttp(
            audioPath,
            cfg.chunkDurationSecs,
            cfg.chunkOverlapMs,
            cfg.useTranscriptContext,
            prevTranscript,
          );
        } catch (err) {
          console.error(`  ✗ ${fixtureName} cfg=${JSON.stringify(cfg)}: ${err}`);
          continue;
        }

        const durationMs = Date.now() - start;
        const wer = computeWER(reference, hypothesis);
        const cer = computeCER(reference, hypothesis);
        const { hits: glossaryHits, total: glossaryTotal } = countGlossaryHits(
          THEOLOGICAL_GLOSSARY_TERMS, hypothesis,
        );

        if (cfg.useTranscriptContext) prevTranscript = hypothesis;

        allResults.push({
          fixture: fixtureName,
          ...cfg,
          wer,
          cer,
          glossaryHits,
          glossaryTotal,
          durationMs,
          hypothesis,
        });

        console.log(
          `  ${fixtureName} | ${cfg.chunkDurationSecs}s | overlap=${cfg.chunkOverlapMs}ms | ctx=${cfg.useTranscriptContext} → WER=${(wer * 100).toFixed(1)}% (${durationMs}ms)`,
        );
      }
    }

    if (allResults.length === 0) return;

    console.log('\n── WER Results ─────────────────────────────────────────────────');
    console.log(formatResultsTable(allResults));
    console.log('────────────────────────────────────────────────────────────────\n');

    // Write JSON results for later comparison
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = join(RESULTS_DIR, `results-${timestamp}.json`);
    await writeFile(outPath, JSON.stringify(allResults, null, 2));
    console.log(`Results written to ${outPath}`);

    // Soft assertion: at least one config should achieve WER < 50%
    const best = Math.min(...allResults.map(r => r.wer));
    expect(best).toBeLessThan(0.5);
  }, 300_000); // 5-minute timeout for real API calls
});
