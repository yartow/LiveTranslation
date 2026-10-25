// Turns a recorded service into ASR test clips: audio slices of the session plus the text the human
// left on screen as the reference. Every service you correct by hand becomes hours of test data for
// `npm run eval:asr` — a tuning change (chunk limits, prompt, model, audio front end) can then be
// measured against many minutes of real speech instead of the four fixture clips.
//
//   npx tsx scripts/build-asr-fixtures.ts <session folder> [--min-secs 45] [--max-diff 0.35]
//                                         [--stage corrected] [--name <prefix>] [--max-clips n] [--dry] [--force]
//
// How: the session's chunk texts (the ASR side, with known times) are aligned to the on-screen text
// (transcript.json) exactly like asr-edits.ts does, which gives every on-screen word a time. Chunks are
// grouped into windows of >= --min-secs (never cutting through a chunk); the window's audio is cut from
// <session>/full.wav (made with asr-session-audio.ts when missing) and its on-screen words become
// tests/fixtures/reference/<name>-NN.txt, tests/fixtures/audio/<name>-NN.wav.
//
// A window is skipped, with the reason printed, when it can't be trusted as a reference: it overlaps a
// stretch the alignment couldn't explain (> 40 changed words: a chunk that was never shown, a deleted
// block), it has very little text, or more than --max-diff of its words differ from the ASR (a stale
// snapshot or a misaligned stretch — real edits are ~6%). Existing files are kept unless --force.
// The reference is only as good as the edits: listen to one window by ear before trusting a score.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { spawnSync } from 'child_process';
import { computeWER, normalizeForScoring, parseAliases } from '../tests/lib/wer';
import {
  loadChunks, originalWords, editedWords, tokenize, render, myers, hunksFrom, editedTimes, planWindows, indexRange,
  type Stage,
} from './lib/edit-align';

const ROOT = join(import.meta.dirname, '..');
const MAX_EDIT_WORDS = 40;
const MIN_REFERENCE_WORDS = 20;

function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string, dflt: string) => { const i = argv.indexOf(name); if (i < 0) return dflt; const [, v] = argv.splice(i, 2); return v ?? dflt; };
  const bool = (name: string) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
  const minSecs = Number(flag('--min-secs', '45'));
  const maxDiff = Number(flag('--max-diff', '0.35'));
  const stage = flag('--stage', 'corrected') as Stage;
  const maxClips = Number(flag('--max-clips', '0')) || Infinity;
  const dry = bool('--dry');
  const force = bool('--force');
  const dir = argv[0];
  const prefix = flag('--name', dir ? `sess-${basename(dir).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40)}` : '');
  if (!dir || !existsSync(dir) || !['raw', 'stripped', 'corrected'].includes(stage)) {
    console.error('usage: npx tsx scripts/build-asr-fixtures.ts <session folder> [--min-secs 45] [--max-diff 0.35] [--stage raw|stripped|corrected] [--name prefix] [--max-clips n] [--dry] [--force]');
    process.exit(1);
  }
  const tPath = join(dir, 'transcript.json');
  if (!existsSync(tPath)) { console.error(`no transcript.json in ${dir} — was the page open while recording (and ASR_DEBUG_DIR on)?`); process.exit(1); }

  const aliasPath = join(ROOT, 'tests/fixtures/spelling-variants.txt');
  const aliases = existsSync(aliasPath) ? parseAliases(readFileSync(aliasPath, 'utf8')) : [];
  const score = (t: string) => normalizeForScoring(t, aliases);

  const chunks = loadChunks(dir, stage);
  if (!chunks.length) { console.error(`no chunk json files in ${dir}`); process.exit(1); }
  const snap = JSON.parse(readFileSync(tPath, 'utf8'));
  const a = tokenize(originalWords(chunks), score);
  const b = tokenize(editedWords(snap.segments), score);
  const ops = myers(a.map(t => t.norm), b.map(t => t.norm));
  const times = editedTimes(ops, a, b.length);
  const aTimes = a.map(t => t.time);

  // Stretches the alignment could not explain as edits: a window touching one is no reference.
  const unexplained = hunksFrom(ops, 2)
    .filter(h => Math.max(h.aTo - h.aFrom, h.bTo - h.bFrom) > MAX_EDIT_WORDS)
    .map(h => ({ from: a[Math.min(h.aFrom, a.length - 1)]?.time ?? 0, to: a[Math.min(Math.max(h.aTo - 1, h.aFrom), a.length - 1)]?.time ?? 0 }));

  const windows = planWindows(chunks, minSecs);
  const wavPath = join(dir, 'full.wav');
  if (!dry && !existsSync(wavPath)) {
    console.log('no full.wav yet — running asr-session-audio.ts …');
    const r = spawnSync('npx', ['tsx', join(ROOT, 'scripts/asr-session-audio.ts'), dir], { stdio: 'inherit' });
    if (r.status !== 0 || !existsSync(wavPath)) { console.error('could not build full.wav'); process.exit(1); }
  }

  const audioDir = join(ROOT, 'tests/fixtures/audio');
  const refDir = join(ROOT, 'tests/fixtures/reference');
  if (!dry) { mkdirSync(audioDir, { recursive: true }); mkdirSync(refDir, { recursive: true }); }

  let written = 0, skipped = 0, seconds = 0, words = 0;
  console.log(`${dir}: ${chunks.length} chunks, ${windows.length} windows of >= ${minSecs}s (stage ${stage})\n`);
  let usable = 0;
  windows.forEach((w, n) => {
    if (usable >= maxClips) return;
    const label = `${String(n + 1).padStart(2, '0')}  ${w.from.toFixed(0).padStart(5)}s-${w.to.toFixed(0).padStart(5)}s`;
    const [b0, b1] = indexRange(times, w.from, w.to);
    const [a0, a1] = indexRange(aTimes, w.from, w.to);
    const reference = render(b, b0, b1);
    const asr = render(a, a0, a1);
    const refWords = reference.split(/\s+/).filter(Boolean).length;
    const diff = asr && reference ? computeWER(score(reference), score(asr)) : 1;

    const bad = unexplained.some(u => u.from <= w.to && u.to >= w.from) ? 'overlaps an unexplained stretch'
      : refWords < MIN_REFERENCE_WORDS ? `only ${refWords} reference words`
      : diff > maxDiff ? `${(diff * 100).toFixed(0)}% of words differ from the ASR (limit ${(maxDiff * 100).toFixed(0)}%)`
      : null;
    if (bad) { skipped++; console.log(`${label}  skip: ${bad}`); return; }

    const stem = `${prefix}-${String(n + 1).padStart(2, '0')}`;
    const wav = join(audioDir, `${stem}.wav`), txt = join(refDir, `${stem}.txt`);
    if (!force && (existsSync(wav) || existsSync(txt))) { skipped++; console.log(`${label}  skip: ${stem} already exists (--force to overwrite)`); return; }
    usable++;
    console.log(`${label}  ${String(refWords).padStart(4)} words  ${(diff * 100).toFixed(1).padStart(5)}% edited  -> ${stem}`);
    if (dry) return;
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(w.from), '-t', String(w.to - w.from), '-i', wavPath, '-ac', '1', '-ar', '16000', wav]);
    if (r.status !== 0) { skipped++; console.error(`   ffmpeg failed: ${String(r.stderr)}`); return; }
    writeFileSync(txt, reference + '\n');
    written++; seconds += w.to - w.from; words += refWords;
  });

  console.log(`\n${dry ? 'would write' : 'wrote'} ${dry ? usable : written} clip(s)${dry ? '' : ` (${(seconds / 60).toFixed(1)} min, ${words} words)`}, skipped ${skipped}.`);
  if (!dry && written) console.log('Next: npm run eval:asr -- ' + prefix + '   (and check one reference against the audio by ear)');
}

main();
