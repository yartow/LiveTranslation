// Scores sermon translation against YOUR corrected English: runs the app's real translation path
// (server/lib/sermon-translate.ts — prompt, glossary, retry, optional back-translation check) over the
// items built by scripts/build-translation-fixtures.ts, for one or more providers/models side by side.
//
//   npm run eval:translate -- [fixture filter] --run openai --run claude --run ollama:qwen2.5:14b
//        [--glossary-csv x.csv --prompt y.md] [--back] [--limit n] [--verbose] [--dry] [--echo]
//
//   --run provider[:model]   what to test (repeatable; default openai:gpt-4o-mini). Keys come from .env.
//   --glossary-csv/--prompt  glossary files (basenames in GLOSSARY_DIR); default = the server's defaults
//   --back                   also run the back-translation check and report its score
//   --limit n                only the first n items (a cheap trial)
//   --dry                    print what would run and what it would cost in calls; call nothing
//   --echo                   self-test of this script: the "model" answers with the reference (no network)
//   --verbose                show the worst-scoring lines of each run
//
// Reported per run: chrF (character n-gram F-score against your English, 0-100), the share of lines that
// match your English apart from punctuation/case, lines missing a required glossary term, call latency.
// "recorded in service" scores the machine drafts you originally saw and then corrected: a run has to
// beat that line to be an improvement. A live run makes one model call per line per --run (twice with
// --back): a few hundred lines on gpt-4o-mini cost cents, but it is real API usage.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { chrF, exactMatch, summarize, parseRunSpec, type RunSpec } from './lib/translate-metrics';
import type { TranslationFixtureItem } from './lib/translation-fixtures';

const ROOT = join(import.meta.dirname, '..');
const FIXTURE_DIR = join(ROOT, 'tests/fixtures/translation');
const BATCH = 40;

interface Args {
  filter?: string;
  runs: RunSpec[];
  glossaryCsv?: string;
  prompt?: string;
  back: boolean;
  limit: number;
  verbose: boolean;
  dry: boolean;
  echo: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { runs: [], back: false, limit: Infinity, verbose: false, dry: false, echo: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--run') {
      const spec = parseRunSpec(argv[++i] ?? '');
      if (!spec) { console.error(`unknown --run value (expected openai, claude or ollama, optionally ":model")`); process.exit(1); }
      a.runs.push(spec);
    }
    else if (t === '--glossary-csv') a.glossaryCsv = argv[++i];
    else if (t === '--prompt') a.prompt = argv[++i];
    else if (t === '--limit') a.limit = Number(argv[++i]) || Infinity;
    else if (t === '--back') a.back = true;
    else if (t === '--verbose') a.verbose = true;
    else if (t === '--dry') a.dry = true;
    else if (t === '--echo') a.echo = true;
    else rest.push(t);
  }
  a.filter = rest[0];
  if (!a.runs.length) a.runs.push({ provider: 'openai', model: 'gpt-4o-mini' });
  return a;
}

function loadItems(filter?: string): TranslationFixtureItem[] {
  if (!existsSync(FIXTURE_DIR)) return [];
  const items: TranslationFixtureItem[] = [];
  for (const f of readdirSync(FIXTURE_DIR).sort()) {
    if (!f.endsWith('.json') || f.startsWith('results-') || (filter && !f.includes(filter))) continue;
    const data = JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8'));
    for (const it of data.items ?? []) items.push({ ...it, id: `${f.replace(/\.json$/, '')}/${it.id}` });
  }
  return items;
}

const label = (r: RunSpec) => (r.model ? `${r.provider}:${r.model}` : r.provider);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`.padStart(6);
const num = (x: number, d = 1) => x.toFixed(d).padStart(5 + (d ? 0 : -1));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = loadItems(args.filter);
  if (!all.length) {
    console.error(`No translation fixtures${args.filter ? ` matching "${args.filter}"` : ''} in ${FIXTURE_DIR}.`);
    console.error('Make some with: npx tsx scripts/build-translation-fixtures.ts <session folder>  (needs English you corrected by hand)');
    process.exit(1);
  }
  const items = all.slice(0, args.limit);
  const calls = items.length * args.runs.length * (args.back ? 2 : 1);
  console.log(`${items.length} line(s) from ${new Set(items.map(i => i.id.split('/')[0])).size} fixture file(s); ${args.runs.map(label).join(', ')}${args.back ? ' (+ back-translation)' : ''}`);
  console.log(`${calls} model call(s)${args.echo ? ' — none made: --echo' : args.dry ? ' — none made: --dry' : ''}\n`);
  if (args.dry) return;

  // The server modules build an OpenAI client at import; a missing key must not stop an --echo self-test.
  if (args.echo) process.env.OPENAI_API_KEY ??= 'unused-by-echo';
  const { translateSegments, modelLabel } = await import('../server/lib/sermon-translate');
  type Entry = import('../server/lib/sermon-translate').TranslationLogEntry;

  const bySource = new Map(items.map(i => [i.source, i.reference]));
  const echoModel = async (_system: string, user: string): Promise<string> => {
    const m = /<TE_VERTALEN>\n([\s\S]*?)\n<\/TE_VERTALEN>/.exec(user);
    return (m && bySource.get(m[1])) || '';
  };

  interface Row { label: string; scored: number; errors: number; chrf: number[]; exact: number; glossaryMiss: number; latency: number[]; fidelity: number[]; worst: Array<{ source: string; reference: string; hypothesis: string; chrf: number }> }
  const rows: Row[] = [];

  // What the app showed during the service, before the operator changed it.
  const drafts = items.filter(i => i.machine);
  if (drafts.length) {
    const scores = drafts.map(i => chrF(i.machine!, i.reference));
    rows.push({ label: `recorded in service (${drafts.length} lines)`, scored: drafts.length, errors: 0, chrf: scores, exact: drafts.filter(i => exactMatch(i.machine!, i.reference)).length, glossaryMiss: 0, latency: [], fidelity: [], worst: [] });
  }

  for (const spec of args.runs) {
    const log: Entry[] = [];
    const results = new Map<string, { translation?: string; warnings?: number; fidelity?: number; error?: string }>();
    process.stdout.write(`${label(spec)} `);
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      const out = await translateSegments(
        batch.map(b => ({ id: b.id, text: b.source, before: b.before, after: b.after })),
        {
          targetLanguage: 'en', translationProvider: spec.provider, model: spec.provider === 'openai' ? spec.model : undefined,
          ollamaModel: spec.provider === 'ollama' ? spec.model : undefined,
          openaiApiKey: process.env.OPENAI_API_KEY, anthropicApiKey: process.env.ANTHROPIC_API_KEY,
          glossaryCsv: args.glossaryCsv, disambiguationPrompt: args.prompt,
          scriptureEnabled: false, bibleVersion: 'ESV', glossaryWarningsEnabled: true, backTranslationCheck: args.back,
        },
        { log: e => log.push(e), ...(args.echo ? { callModel: echoModel } : {}) },
      );
      for (const r of out) results.set(r.id, r.status === 'ok' ? { translation: r.translation, warnings: r.warnings?.length ?? 0, fidelity: r.fidelity } : { error: r.error });
      process.stdout.write('.');
    }
    process.stdout.write('\n');

    const row: Row = { label: `${label(spec)} → ${modelLabel({ translationProvider: spec.provider, model: spec.model, ollamaModel: spec.model })}`, scored: 0, errors: 0, chrf: [], exact: 0, glossaryMiss: 0, latency: log.map(e => e.latencyMs), fidelity: [], worst: [] };
    for (const it of items) {
      const r = results.get(it.id);
      if (!r || r.error || r.translation === undefined) { row.errors++; continue; }
      const score = chrF(r.translation, it.reference);
      row.scored++;
      row.chrf.push(score);
      if (exactMatch(r.translation, it.reference)) row.exact++;
      if (r.warnings) row.glossaryMiss++;
      if (r.fidelity !== undefined) row.fidelity.push(r.fidelity);
      row.worst.push({ source: it.source, reference: it.reference, hypothesis: r.translation, chrf: score });
    }
    row.worst.sort((a, b) => a.chrf - b.chrf);
    rows.push(row);
  }

  console.log('\nrun                                                   lines  err   chrF  exact  glossary-miss  latency p50 / p95');
  for (const r of rows) {
    const c = summarize(r.chrf), l = summarize(r.latency);
    console.log(
      `${r.label.padEnd(52).slice(0, 52)}  ${String(r.scored).padStart(5)} ${String(r.errors).padStart(4)}  ${num(c.mean)}  ${pct(r.exact / Math.max(1, r.scored))}  ${String(r.glossaryMiss).padStart(13)}  ` +
      (r.latency.length ? `${(l.median / 1000).toFixed(1)} s / ${(l.p95 / 1000).toFixed(1)} s` : '—') +
      (r.fidelity.length ? `   back-translation ${num(summarize(r.fidelity).mean, 2)}` : ''),
    );
  }
  if (args.verbose) {
    for (const r of rows.filter(x => x.worst.length)) {
      console.log(`\n── worst lines: ${r.label}`);
      for (const w of r.worst.slice(0, 5)) console.log(`  chrF ${w.chrf.toFixed(0).padStart(3)}  NL:  ${w.source}\n           REF: ${w.reference}\n           HYP: ${w.hypothesis}`);
    }
  }

  mkdirSync(FIXTURE_DIR, { recursive: true });
  const out = join(FIXTURE_DIR, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), lines: items.length, echo: args.echo, rows: rows.map(r => ({ label: r.label, scored: r.scored, errors: r.errors, chrF: summarize(r.chrf), exact: r.exact, glossaryMiss: r.glossaryMiss, latencyMs: summarize(r.latency) })) }, null, 2) + '\n');
  console.log(`\nSaved ${out}`);
  process.exit(0); // the Ollama/OpenAI clients can keep sockets open
}

main().catch(err => { console.error(err); process.exit(1); });
