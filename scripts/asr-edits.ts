// Shows what the human changed in a recorded sermon: the ASR text (per-chunk archive) against the
// text left on screen (transcript.json) — an ASR_DEBUG_DIR session (`npm run dev:record`).
//
//   npx tsx scripts/asr-edits.ts <session folder> [--stage raw|stripped|corrected] [--context n] [--gap n]
//       -> summary + recurring substitutions on stdout, full list in <session>/edits.md
//
// Original = every chunk's text in time order, with the same chunk-boundary dedupe the ingest buffer
// applies (client/src/lib/sermon/overlap-dedupe.ts). `--stage` picks which pipeline stage:
// `corrected` (default; what reached the screen, falls back to `stripped` when a chunk has no
// corrected text), `stripped` (Whisper after artifact filters) or `raw` (Whisper as-is).
// Edited = the segments' `sourceText` in order. transcript.json is only a snapshot (every 60 s
// while recording and after stop): an edit made after the last snapshot is not in it.
//
// Both sides are normalised like the ASR scorer (tests/lib/wer.ts: case, punctuation, diacritics,
// digits vs number words, fillers, spelling-variants.txt), so segment boundaries, sentence splitting
// and punctuation edits don't show up — only changed words do. The two word streams are aligned
// with a Myers diff; changes closer together than `--gap` unchanged words (default 2) merge into one.
// A change this script can't explain as an edit (a stretch > 40 words on either side, e.g. a chunk
// that was never shown or a block you deleted) is listed apart and kept out of the statistics.


import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { normalizeForScoring, parseAliases } from '../tests/lib/wer';
import {
  loadChunks, originalWords, editedWords, tokenize, render, myers, hunksFrom, mmss,
  type Stage, type Hunk,
} from './lib/edit-align';

const ROOT = join(import.meta.dirname, '..');
const MAX_EDIT_WORDS = 40;

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string, dflt: string) => { const i = argv.indexOf(name); if (i < 0) return dflt; const [, v] = argv.splice(i, 2); return v ?? dflt; };
  const stage = flag('--stage', 'corrected') as Stage;
  const ctx = Number(flag('--context', '6'));
  const gap = Number(flag('--gap', '2'));
  const dir = argv[0];
  if (!dir || !['raw', 'stripped', 'corrected'].includes(stage)) {
    console.error('usage: npx tsx scripts/asr-edits.ts <session folder> [--stage raw|stripped|corrected] [--context n] [--gap n]');
    process.exit(1);
  }
  const tPath = join(dir, 'transcript.json');
  if (!existsSync(tPath)) { console.error(`no transcript.json in ${dir} — was the page open while recording (and ASR_DEBUG_DIR on)?`); process.exit(1); }

  const aliasPath = join(ROOT, 'tests/fixtures/spelling-variants.txt');
  const aliases = existsSync(aliasPath) ? parseAliases(readFileSync(aliasPath, 'utf8')) : [];
  const score = (t: string) => normalizeForScoring(t, aliases);

  // Original side: chunk texts in time order, chunk-boundary overlap dropped like the ingest buffer does.
  const chunks = loadChunks(dir, stage);
  const aWords = originalWords(chunks);

  // Edited side: what is on screen.
  const snap = JSON.parse(readFileSync(tPath, 'utf8'));
  const segments: Array<{ index: number; sourceText: string; lastSourceChangeAt: number; id: string }> =
    [...snap.segments].sort((a: any, b: any) => a.index - b.index);
  const bWords = editedWords(segments);

  const a = tokenize(aWords, score), b = tokenize(bWords, score);
  const ops = myers(a.map(t => t.norm), b.map(t => t.norm));
  const hunks = hunksFrom(ops, gap);

  const edits: Hunk[] = [], large: Hunk[] = [];
  for (const h of hunks) (Math.max(h.aTo - h.aFrom, h.bTo - h.bFrom) > MAX_EDIT_WORDS ? large : edits).push(h);

  const timeOf = (h: Hunk) => a[Math.min(h.aFrom, a.length - 1)]?.time ?? 0;
  const segOf = (h: Hunk) => b[Math.min(h.bFrom, b.length - 1)]?.segment ?? -1;
  const line = (h: Hunk) => {
    const before = render(b, h.bFrom - ctx, h.bFrom), after = render(b, h.bTo, h.bTo + ctx);
    const o = render(a, h.aFrom, h.aTo), e = render(b, h.bFrom, h.bTo);
    return [
      `### ${mmss(timeOf(h))} · segment ${segOf(h)}`, '',
      `- **context:** …${before} **[${e || '∅'}]** ${after}…`,
      `- **ASR:** ${o || '_(nothing)_'}`,
      `- **you:** ${e || '_(deleted)_'}`, '',
    ];
  };

  // Statistics (edits only): words replaced / removed / added, recurring substitutions.
  let replaced = 0, removed = 0, added = 0;
  const subs = new Map<string, { n: number; from: string; to: string }>();
  const editedSegments = new Set<number>();
  for (const h of edits) {
    const dn = h.aTo - h.aFrom, in_ = h.bTo - h.bFrom;
    replaced += Math.min(dn, in_); removed += Math.max(0, dn - in_); added += Math.max(0, in_ - dn);
    editedSegments.add(segOf(h));
    if (dn > 0 && in_ > 0 && dn <= 4 && in_ <= 4) {
      const from = a.slice(h.aFrom, h.aTo).map(t => t.norm).join(' '), to = b.slice(h.bFrom, h.bTo).map(t => t.norm).join(' ');
      const key = `${from}→${to}`;
      const e = subs.get(key) ?? { n: 0, from: render(a, h.aFrom, h.aTo), to: render(b, h.bFrom, h.bTo) };
      e.n++; subs.set(key, e);
    }
  }
  const changed = replaced + removed + added;
  const recurring = Array.from(subs.values()).filter(s => s.n >= 2).sort((x, y) => y.n - x.n);

  const lastDelivered = Math.max(0, ...chunks.map(c => c.deliveredAt));
  const warnings: string[] = [];
  if (lastDelivered && lastDelivered > snap.savedAt) warnings.push(`transcript.json (saved ${new Date(snap.savedAt).toISOString()}) is older than the last delivered chunk (${new Date(lastDelivered).toISOString()}): the end of the recording, and any edits after the snapshot, are missing from it.`);
  if (a.length > b.length * 1.05 || b.length > a.length * 1.05) warnings.push(`word counts differ by >5% (${a.length} ASR vs ${b.length} on screen) — check the "unexplained" section.`);

  const summary = [
    `session:           ${dir}   (stage: ${stage})`,
    `ASR words:         ${a.length}`,
    `on-screen words:   ${b.length}   (${segments.length} segments)`,
    `edits:             ${edits.length} in ${editedSegments.size} segments`,
    `words changed:     ${changed}  (${replaced} replaced, ${removed} removed, ${added} added) = ${(100 * changed / Math.max(1, b.length)).toFixed(1)}% of on-screen words`,
    `unexplained:       ${large.length} stretches > ${MAX_EDIT_WORDS} words (not counted)`,
    ...warnings.map(w => `WARNING: ${w}`),
  ];

  const md = [
    `# Edits against ASR text`, '', '```', ...summary, '```', '',
    `Both sides are compared after normalisation (case, punctuation, diacritics, digits/number words, fillers): only changed words show. Listen to \`full.wav\` (\`scripts/asr-session-audio.ts\`) at the timestamp to see whether the ASR or the edit was right.`, '',
    `## Recurring substitutions (2+ times)`, '',
    ...(recurring.length ? ['| × | ASR | you |', '|---:|---|---|', ...recurring.slice(0, 40).map(s => `| ${s.n} | ${s.from} | ${s.to} |`)] : ['_none_']), '',
    `## All edits (${edits.length})`, '',
    ...edits.flatMap(line),
    ...(large.length ? [`## Unexplained: stretches > ${MAX_EDIT_WORDS} words (${large.length})`, '',
      'Not edits as such — a chunk the page never showed, a block that was deleted or pasted over, or a missing snapshot tail.', '',
      ...large.flatMap(h => [`### ${mmss(timeOf(h))} · segment ${segOf(h)} — ASR ${h.aTo - h.aFrom} words, on screen ${h.bTo - h.bFrom} words`, '',
        `- **ASR:** ${render(a, h.aFrom, h.aTo).slice(0, 400) || '_(nothing)_'}`, `- **you:** ${render(b, h.bFrom, h.bTo).slice(0, 400) || '_(nothing)_'}`, ''])] : []),
  ].join('\n');
  writeFileSync(join(dir, 'edits.md'), md + '\n');

  console.log(summary.join('\n'));
  if (recurring.length) {
    console.log('\nrecurring substitutions:');
    for (const s of recurring.slice(0, 15)) console.log(`  ${String(s.n).padStart(3)}×  ${s.from}  →  ${s.to}`);
  }
  console.log(`\nwrote ${join(dir, 'edits.md')}`);
}

main();
