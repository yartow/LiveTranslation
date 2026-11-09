// Builds translation test items from a corrected service: the English you wrote or fixed by hand becomes
// the reference for the Dutch next to it, so `npm run eval:translate` can score models and prompts against
// YOUR preferred wording. Needs a `npm run dev:record` session whose transcript.json has your corrections
// (the page posts it every minute and after Stop).
//
//   npx tsx scripts/build-translation-fixtures.ts <session folder> [--name <file>] [--min-words 3] [--force]
//       -> tests/fixtures/translation/<name>.json
//
// Only rows you wrote or changed by hand count (an untouched machine translation is what is being
// measured, not a reference). Segments recorded before the page kept `machineText` still work; they just
// carry no `machine` draft. The more English you correct, the better the test set.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { buildTranslationFixtures } from './lib/translation-fixtures';

const ROOT = join(import.meta.dirname, '..');

function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string, dflt: string) => { const i = argv.indexOf(name); if (i < 0) return dflt; const [, v] = argv.splice(i, 2); return v ?? dflt; };
  const force = (() => { const i = argv.indexOf('--force'); if (i < 0) return false; argv.splice(i, 1); return true; })();
  const minWords = Number(flag('--min-words', '3'));
  const dir = argv[0];
  if (!dir || !existsSync(dir)) {
    console.error('usage: npx tsx scripts/build-translation-fixtures.ts <session folder> [--name <file>] [--min-words 3] [--force]');
    process.exit(1);
  }
  const tPath = join(dir, 'transcript.json');
  if (!existsSync(tPath)) { console.error(`no transcript.json in ${dir} — was the page open while recording (and ASR_DEBUG_DIR on)?`); process.exit(1); }

  const name = flag('--name', `sess-${basename(dir).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40)}`).replace(/\.json$/, '');
  const snap = JSON.parse(readFileSync(tPath, 'utf8'));
  const items = buildTranslationFixtures(snap.segments ?? [], { minWords });

  const handWritten = (snap.segments ?? []).filter((s: { manualOverride?: boolean }) => s.manualOverride).length;
  console.log(`${dir}: ${(snap.segments ?? []).length} segments, ${handWritten} written or corrected by hand, ${items.length} usable as references (>= ${minWords} Dutch words).`);
  if (!items.length) {
    console.log('Nothing to write: correct some English in sermon mode during a dev:record session first.');
    return;
  }
  const outDir = join(ROOT, 'tests/fixtures/translation');
  const out = join(outDir, `${name}.json`);
  if (existsSync(out) && !force) { console.error(`${out} exists (--force to overwrite)`); process.exit(1); }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, JSON.stringify({ session: basename(dir), createdAt: new Date().toISOString(), items }, null, 2) + '\n');
  console.log(`wrote ${out}\nNext: npm run eval:translate -- ${name} --run openai --run claude`);
}

main();
