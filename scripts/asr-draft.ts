// Drafts a reference transcript for an audio clip with the local MLX Whisper,
// so you can CORRECT it by hand instead of typing it from scratch.
//
//   npm run draft:asr -- ~/Movies/sermon3-60s.m4a
//   npm run draft:asr -- ~/Movies/sermon3-60s.m4a --glossary data/preek_woordenlijst_NL_EN_clean.csv
//
// Writes <same folder>/<same name>.txt (one sentence per line) and refuses to
// overwrite an existing file. Then: listen to the clip and fix the text -- see
// the checklist this prints. A draft you only skim will score Whisper against
// itself, which flatters it.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';

const ROOT = join(import.meta.dirname, '..');
const LANGUAGE = 'nl';

async function main() {
  const argv = process.argv.slice(2);
  const audio = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--glossary');
  const gi = argv.indexOf('--glossary');
  const glossaryPath = gi >= 0 ? argv[gi + 1] : undefined;
  if (!audio) { console.error('Usage: npm run draft:asr -- <audio file> [--glossary <file>]'); process.exit(1); }

  const audioPath = resolve(audio.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  if (!existsSync(audioPath)) { console.error(`Not found: ${audioPath}`); process.exit(1); }
  const out = join(dirname(audioPath), `${basename(audioPath, extname(audioPath))}.txt`);
  if (existsSync(out)) { console.error(`Refusing to overwrite ${out} (delete or rename it first).`); process.exit(1); }

  try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* optional */ }
  process.env.OPENAI_API_KEY ??= 'unused-by-asr-draft';
  const { transcribeWithMlx } = await import('../server/lib/mlx-whisper');
  const { buildWhisperPrompt } = await import('../server/lib/openai');
  const { stripAsrArtifacts } = await import('../server/lib/asr-artifacts');

  let prompt: string | undefined;
  if (glossaryPath) {
    const raw = readFileSync(glossaryPath, 'utf8');
    let terms: string;
    if (/\.csv$/i.test(glossaryPath)) {
      const { parseGlossaryCsv } = await import('../server/lib/glossary-parse');
      const g = parseGlossaryCsv(raw);
      const priority = ['Eigennaam', 'Bijbelboek', 'Plaatsnaam'];
      const rank = (c: string) => { const i = priority.indexOf(c); return i === -1 ? priority.length : i; };
      terms = [...g.fixed, ...g.context].sort((a, b) => rank(a.category) - rank(b.category)).map(r => r.nl).join('\n');
    } else {
      terms = raw;
    }
    prompt = buildWhisperPrompt(terms, undefined, undefined, LANGUAGE);
  }

  console.log(`Transcribing ${audioPath} (whole clip, one pass)…`);
  const text = stripAsrArtifacts((await transcribeWithMlx(audioPath, LANGUAGE, prompt)).trim(), LANGUAGE);
  const lines = text.split(/(?<=[.!?…])\s+/).map(l => l.trim()).filter(Boolean);
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\nWrote ${out} (${lines.length} sentences, ${text.split(/\s+/).length} words)\n`);
  console.log([
    'Now correct it BY EAR -- do not just read it:',
    '  1. Play the clip (QuickTime: space = pause, Left arrow = back 1s) with the .txt open next to it.',
    '  2. Go sentence by sentence; after each, pause and check every word against what you hear.',
    '  3. Whisper tends to DROP words and whole clauses, and to smooth over stumbles -- a missing',
    '     phrase is invisible when reading. Listen for what is said that is not on the page.',
    '  4. Write what was actually SAID, including colloquial forms ("goeie") and repeats. Fillers',
    '     (ehm, eh) are optional; punctuation, capitals and 5-vs-vijf do not matter to the scorer.',
    '  5. Names/terms: spell them the way the glossary does (e.g. Filippenzen).',
    'Then copy the pair (audio + txt) into tests/fixtures/audio and tests/fixtures/reference.',
  ].join('\n'));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
