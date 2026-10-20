// Compares two ASR archive folders (an ASR_DEBUG_DIR session and/or an asr-replay.ts output).
//
//   npx tsx scripts/asr-compare.ts <old session> <new session>
//       -> summary table + <new session>/compare.md (30 s windows, most-different first)
//
//   npx tsx scripts/asr-compare.ts --score <session> <reference.txt> <fromSecs> <toSecs>
//       -> WER of that session's text for the time range against a hand-corrected reference,
//          so "what Sunday actually produced" can be scored next to a replay (eval:asr).
//
// Text compared is each chunk's `strippedText` (Whisper after the artifact filters), not the
// LLM-corrected text, so a replay (which has no correction step) is like-for-like.
// Chunk boundaries differ between runs, so words are spread over 30 s windows by time,
// not assigned by chunk. Scoring ignores spelling-only differences (tests/lib/wer.ts).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { computeWER, countAsrArtifacts, normalizeForScoring, parseAliases } from '../tests/lib/wer';

const RATE = 16_000;
const WINDOW_SECS = 30;
const ROOT = join(import.meta.dirname, '..');

interface Chunk { start: number; secs: number; text: string; guardRetried: boolean; cut: string; dropped: number; }
interface Session { dir: string; chunks: Chunk[]; endSecs: number }

function loadSession(dir: string): Session {
  if (!existsSync(dir)) { console.error(`not found: ${dir}`); process.exit(1); }
  const chunks: Chunk[] = [];
  for (const f of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    let d: any;
    try { d = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    const m = d.meta;
    if (!m || typeof m.startSample !== 'number') continue;
    const prefix = m.prefixSamples ?? 0;
    const attempts: any[] = d.attempts ?? [];
    chunks.push({
      start: (m.startSample) / RATE, secs: (m.samples - prefix) / RATE,
      text: String(d.strippedText ?? d.rawText ?? '').trim(),
      guardRetried: !!d.guardRetried, cut: m.cut ?? '?',
      dropped: attempts.flatMap(a => a.diag?.segments ?? []).filter((x: any) => x.dropped).length,
    });
  }
  chunks.sort((a, b) => a.start - b.start);
  return { dir, chunks, endSecs: chunks.length ? Math.max(...chunks.map(c => c.start + c.secs)) : 0 };
}

/** Words of the session whose (interpolated) time falls in [from, to). */
function wordsIn(s: Session, from: number, to: number): string[] {
  const out: string[] = [];
  for (const c of s.chunks) {
    if (c.start + c.secs < from || c.start >= to) continue;
    const words = c.text.split(/\s+/).filter(Boolean);
    words.forEach((w, k) => {
      const t = c.start + ((k + 0.5) / words.length) * c.secs;
      if (t >= from && t < to) out.push(w);
    });
  }
  return out;
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function stats(s: Session) {
  const text = s.chunks.map(c => c.text).join(' ');
  const words = text.split(/\s+/).filter(Boolean).length;
  return {
    chunks: s.chunks.length,
    avgChunkSecs: s.chunks.length ? s.chunks.reduce((n, c) => n + c.secs, 0) / s.chunks.length : 0,
    words, wordsPerMin: s.chunks.length ? words / (s.chunks.reduce((n, c) => n + c.secs, 0) / 60) : 0,
    guardRetries: s.chunks.filter(c => c.guardRetried).length,
    droppedSegments: s.chunks.reduce((n, c) => n + c.dropped, 0),
    noText: s.chunks.filter(c => !c.text).length,
    artifacts: countAsrArtifacts(text),
    ellipses: (text.match(/\.\.\.|…/g) ?? []).length,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const aliasPath = join(ROOT, 'tests/fixtures/spelling-variants.txt');
  const aliases = existsSync(aliasPath) ? parseAliases(readFileSync(aliasPath, 'utf8')) : [];
  const score = (t: string) => normalizeForScoring(t, aliases);

  if (argv[0] === '--score') {
    const [, dir, refPath, from, to] = argv;
    if (!dir || !refPath || from === undefined || to === undefined) { console.error('usage: --score <session> <reference.txt> <fromSecs> <toSecs>'); process.exit(1); }
    const s = loadSession(dir);
    const hyp = wordsIn(s, Number(from), Number(to)).join(' ');
    const ref = readFileSync(refPath, 'utf8').trim();
    console.log(`${dir} [${mmss(Number(from))}-${mmss(Number(to))}]: ${hyp.split(/\s+/).filter(Boolean).length} words vs ${ref.split(/\s+/).length} reference words`);
    console.log(`WER ${(computeWER(score(ref), score(hyp)) * 100).toFixed(1)}%`);
    return;
  }

  const [oldDir, newDir] = argv;
  if (!oldDir || !newDir) { console.error('usage: npx tsx scripts/asr-compare.ts <old session> <new session>'); process.exit(1); }
  const a0 = loadSession(oldDir), b0 = loadSession(newDir);
  // Only compare the time range both sessions cover (a replay of a slice, or a recording that stopped early).
  const lo = Math.max(...[a0, b0].map(x => Math.min(...x.chunks.map(c => c.start))));
  const hi = Math.min(a0.endSecs, b0.endSecs);
  const clip = (x: Session): Session => ({ ...x, chunks: x.chunks.filter(c => c.start < hi && c.start + c.secs > lo) });
  const a = clip(a0), b = clip(b0);
  const sa = stats(a), sb = stats(b);

  type Stats = ReturnType<typeof stats>;
  const rows: Array<[string, (x: Stats) => string]> = [
    ['chunks', x => String(x.chunks)], ['avg chunk (s)', x => x.avgChunkSecs.toFixed(1)],
    ['words', x => String(x.words)], ['words / min', x => x.wordsPerMin.toFixed(0)],
    ['guard retries', x => String(x.guardRetries)], ['dropped segments', x => String(x.droppedSegments)],
    ['chunks with no text', x => String(x.noText)], ['caption artifacts', x => String(x.artifacts)],
    ['leftover ellipses', x => String(x.ellipses)],
  ];
  const summary = ['| | old | new |', '|---|---:|---:|', ...rows.map(([n, f]) => `| ${n} | ${f(sa)} | ${f(sb)} |`)];

  const windows: Array<{ from: number; diff: number; oldText: string; newText: string; oldWords: number; newWords: number }> = [];
  for (let from = Math.floor(lo / WINDOW_SECS) * WINDOW_SECS; from < hi; from += WINDOW_SECS) {
    const oldW = wordsIn(a, from, from + WINDOW_SECS), newW = wordsIn(b, from, from + WINDOW_SECS);
    const o = oldW.join(' '), n = newW.join(' ');
    // WER against the longer side so an empty side reads as 100%, not infinite.
    const diff = o === n ? 0 : Math.min(1, computeWER(score(oldW.length >= newW.length ? o : n), score(oldW.length >= newW.length ? n : o)));
    windows.push({ from, diff: oldW.length + newW.length === 0 ? 0 : diff, oldText: o, newText: n, oldWords: oldW.length, newWords: newW.length });
  }
  const meanDiff = windows.reduce((n, w) => n + w.diff, 0) / Math.max(1, windows.length);
  const differing = windows.filter(w => w.diff >= 0.15).length;
  const ranked = [...windows].sort((x, y) => y.diff - x.diff);

  const md = [
    `# ASR comparison`, '', `old: \`${oldDir}\``, `new: \`${newDir}\``, '', ...summary, '',
    `Range ${mmss(lo)}–${mmss(hi)}; ${windows.length} windows of ${WINDOW_SECS}s; mean difference ${(meanDiff * 100).toFixed(1)}%; ${differing} windows differ by >= 15%.`,
    `Difference is word-level and ignores spelling-only variants. It says the texts differ, not which is right: listen to \`full.wav\` at the timestamp.`, '',
    `## Most different windows`, '',
    ...ranked.slice(0, 20).flatMap(w => [
      `### ${mmss(w.from)}–${mmss(w.from + WINDOW_SECS)}  (${(w.diff * 100).toFixed(0)}% different, ${w.oldWords} → ${w.newWords} words)`, '',
      `- **old:** ${w.oldText || '_(nothing)_'}`, `- **new:** ${w.newText || '_(nothing)_'}`, '',
    ]),
  ].join('\n');
  writeFileSync(join(newDir, 'compare.md'), md + '\n');

  console.log(summary.join('\n'));
  console.log(`\n${windows.length} windows; mean difference ${(meanDiff * 100).toFixed(1)}%; ${differing} differ by >= 15%`);
  console.log(`Wrote ${join(newDir, 'compare.md')}`);
}

main();
