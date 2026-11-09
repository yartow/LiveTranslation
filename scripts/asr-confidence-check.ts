// Calibrates "show low-confidence words": on a recorded service, how often is a word Whisper doubted the
// word you then corrected by hand? Prints precision / recall / lift per probability threshold, so the app's
// threshold (server/lib/low-confidence.ts, LOW_CONFIDENCE_BELOW) is chosen from data, not by feel.
//
//   npx tsx scripts/asr-confidence-check.ts <session folder> [--stage stripped|raw|corrected]
//
// Needs a session recorded with `npm run dev:record` AFTER word probabilities were archived (chunk json
// `attempts[].uncertain`, MLX engine) and a transcript.json with your corrections — older sessions have
// no probabilities and say so. The same alignment as asr-edits.ts decides which words were edited.
// Stage `stripped` (default) is closest to what Whisper itself wrote, which is what the probabilities describe.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { normalizeForScoring, parseAliases } from '../tests/lib/wer';
import { loadChunks, originalWords, editedWords, tokenize, myers, hunksFrom, type Stage } from './lib/edit-align';
import { matchDoubts, scoreThresholds, type FlagRecord } from './lib/confidence-eval';

const ROOT = join(import.meta.dirname, '..');
const MAX_EDIT_WORDS = 40;
const THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6];

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--stage');
  const stage = (i >= 0 ? argv.splice(i, 2)[1] : 'stripped') as Stage;
  const dir = argv[0];
  if (!dir || !existsSync(dir) || !['raw', 'stripped', 'corrected'].includes(stage)) {
    console.error('usage: npx tsx scripts/asr-confidence-check.ts <session folder> [--stage stripped|raw|corrected]');
    process.exit(1);
  }
  const tPath = join(dir, 'transcript.json');
  if (!existsSync(tPath)) { console.error(`no transcript.json in ${dir}`); process.exit(1); }

  const aliasPath = join(ROOT, 'tests/fixtures/spelling-variants.txt');
  const aliases = existsSync(aliasPath) ? parseAliases(readFileSync(aliasPath, 'utf8')) : [];
  const score = (t: string) => normalizeForScoring(t, aliases);
  const normWord = (w: string) => score(w).split(' ').filter(Boolean).join(' ');

  const chunks = loadChunks(dir, stage);
  const withDoubts = chunks.filter(c => c.uncertain?.length);
  if (!withDoubts.length) {
    console.log(`${dir}: no word probabilities in this session (recorded before they were archived, or not the MLX engine).`);
    console.log('Record a service with `npm run dev:record` and run this again.');
    return;
  }

  const snap = JSON.parse(readFileSync(tPath, 'utf8'));
  const a = tokenize(originalWords(chunks), score);
  const b = tokenize(editedWords(snap.segments), score);
  const ops = myers(a.map(t => t.norm), b.map(t => t.norm));
  const edited = new Array<boolean>(a.length).fill(false);
  for (const h of hunksFrom(ops, 2)) {
    if (Math.max(h.aTo - h.aFrom, h.bTo - h.bFrom) > MAX_EDIT_WORDS) continue; // unexplained stretch, not an edit
    for (let k = h.aFrom; k < h.aTo; k++) edited[k] = true;
  }

  // Only chunks that carry probabilities count toward recall, so older chunks don't dilute it.
  const records: FlagRecord[] = [];
  let totalWords = 0, totalEdited = 0;
  for (const c of withDoubts) {
    const idx: number[] = [];
    a.forEach((t, k) => { if (t.time >= c.start && t.time < c.start + c.secs) idx.push(k); });
    totalWords += idx.length;
    totalEdited += idx.filter(k => edited[k]).length;
    records.push(...matchDoubts(c.uncertain, idx.map(k => a[k].norm), idx.map(k => edited[k]), normWord));
  }

  const scores = scoreThresholds(records, totalEdited, totalWords, THRESHOLDS);
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`.padStart(6);
  console.log(`${dir}: ${withDoubts.length}/${chunks.length} chunks with word probabilities, ${totalWords} words, ${totalEdited} edited (${pct(totalEdited / Math.max(1, totalWords)).trim()})`);
  console.log(`${records.length} doubted words (p < 0.6) found in the text\n`);
  console.log('below  flagged   hits  precision  recall   lift');
  for (const s of scores) {
    console.log(`${s.below.toFixed(1)}   ${String(s.flagged).padStart(7)}  ${String(s.hits).padStart(5)}  ${pct(s.precision)}    ${pct(s.recall)}  ${s.lift.toFixed(1).padStart(5)}x`);
  }
  const best = [...scores].sort((x, y) => y.f1 - x.f1)[0];
  console.log(`\nbest balance of precision and recall: below ${best.below.toFixed(1)}. The app uses LOW_CONFIDENCE_BELOW = 0.4 (server/lib/low-confidence.ts).`);
  console.log('lift = how many times more likely a flagged word is to be one you corrected than a random word. Around 1x means the flags carry no signal.');
}

main();
