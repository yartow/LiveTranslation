// One-time build step producing sermon mode's Bible-quote data — see
// CLAUDE.md's "Scripture pipeline" section and the plan doc for context.
// NOT part of `npm run build` — regenerate manually (only needed again if
// the source repos below are updated) via:
//
//   npx tsx scripts/build-bible-data.ts
//
// Sources (both public domain, both already cloned locally per the plan):
//   - Dutch anchor: dut-statenvertaling.zefania.xml from
//     https://github.com/seven1m/open-bibles — carries Dutch book names
//     natively (<BIBLEBOOK bname="Johannes">), so no NL name-mapping table
//     is needed on that side.
//   - English fallback: verses-1769.json from
//     https://github.com/farskipper/kjv — a flat "Book C:V" -> text map.
//
// Both are joined into ONE numeric key space (bookNumber:chapter:verse) by
// canonical book position — both sources list all 66 books Genesis..
// Revelation in that order — which is what turns the anchor comparison in
// server/lib/scripture.ts into a plain key lookup instead of a name-matching
// problem on both sides. See books.json below for the join table itself.
//
// Output:
//   data/bible/sv-nl.json.gz   — { "43:3:16": "Want alzo lief heeft God..." }
//     (gitignored — data/* — regenerate rather than commit)
//   data/bible/kjv-en.json.gz  — { "43:3:16": "For God so loved the world..." }
//     (gitignored, same as above)
//   data/bible/books.json      — [{ n: 43, nl: "Johannes", en: "John", abbr: "Joh" }, ...]
//     (gitignored, same as above — server/lib/bible-books.ts reads this at runtime)
//   client/src/lib/sermon/bible-books.generated.ts — the SAME book table,
//     committed as source: bible-ref.ts (the client-side reference parser)
//     needs only this small table, never verse text, so it's bundled with
//     the client instead of fetched.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';

const SV_XML_PATH = process.env.SV_XML_PATH
  || path.join(os.homedir(), 'Documents/GitHub/open-bibles/dut-statenvertaling.zefania.xml');
const KJV_JSON_PATH = process.env.KJV_JSON_PATH
  || path.join(os.homedir(), 'Documents/GitHub/kjv/json/verses-1769.json');

const OUT_DIR = path.resolve(import.meta.dirname, '..', 'data', 'bible');
const CLIENT_BOOKS_PATH = path.resolve(import.meta.dirname, '..', 'client', 'src', 'lib', 'sermon', 'bible-books.generated.ts');

// A couple of KJV's book names are archaic relative to how anyone actually
// refers to them today. The source JSON's own key is what parsing needs, but
// the *display* name (books.json's `en`, used e.g. to build the "John 3:16"
// reference-announcement hint) should read the way a modern reader expects.
const EN_DISPLAY_OVERRIDES: Record<string, string> = {
  "Solomon's Song": 'Song of Solomon',
};

interface BookEntry {
  n: number;
  nl: string;
  en: string;
  /** Dutch short form from the Statenvertaling source (e.g. "Joh", "1Kor") — a starting point for sentence-split.ts's abbreviation list and bible-ref.ts's parser, not an exhaustive alias set (see server/lib/glossary-store.ts's Bijbelboek-row merge for operator-editable aliases). */
  abbr: string;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Regex-based, not a real XML parser — the Zefania format here is flat
// (BIBLEBOOK > CHAPTER > VERS, no nested markup inside a VERS element; see
// the plan's "What I verified in the real data" note), so a small parser
// would be pure overhead for a script that runs once and is thrown away.
function parseStatenvertaling(xmlPath: string): { books: BookEntry[]; verses: Record<string, string> } {
  const xml = readFileSync(xmlPath, 'utf-8');
  const verses: Record<string, string> = {};
  const books: BookEntry[] = [];

  const bookRe = /<BIBLEBOOK bnumber="(\d+)" bname="([^"]+)" bsname="([^"]+)">([\s\S]*?)<\/BIBLEBOOK>/g;
  const chapterRe = /<CHAPTER cnumber="(\d+)">([\s\S]*?)<\/CHAPTER>/g;
  const versRe = /<VERS vnumber="(\d+)">([^<]*)<\/VERS>/g;

  let bookMatch: RegExpExecArray | null;
  while ((bookMatch = bookRe.exec(xml))) {
    const [, bnumberStr, bname, bsname, bookBody] = bookMatch;
    const n = Number(bnumberStr);
    // The join with the KJV side (below) assumes bnumber IS canonical
    // insertion position (1-indexed, Genesis..Revelation in source order) —
    // fail loudly rather than silently mis-joining every subsequent book if
    // the source XML ever numbers/orders books differently than expected.
    const expectedPosition = books.length + 1;
    if (n !== expectedPosition) {
      throw new Error(`Statenvertaling XML book order mismatch: expected bnumber ${expectedPosition} at position ${books.length}, got ${n} (${bname})`);
    }
    // `en` is filled in below once the KJV side is parsed — both sides are
    // joined by canonical position, not written independently here.
    books.push({ n, nl: bname, en: '', abbr: bsname });

    chapterRe.lastIndex = 0;
    let chapterMatch: RegExpExecArray | null;
    while ((chapterMatch = chapterRe.exec(bookBody))) {
      const [, cnumberStr, chapterBody] = chapterMatch;

      versRe.lastIndex = 0;
      let versMatch: RegExpExecArray | null;
      while ((versMatch = versRe.exec(chapterBody))) {
        const [, vnumberStr, text] = versMatch;
        verses[`${n}:${cnumberStr}:${vnumberStr}`] = decodeXmlEntities(text.trim());
      }
    }
  }
  return { books, verses };
}

// The kjv package's keys are "Book C:V" strings sharing one flat namespace —
// re-key them onto the same bookNumber:chapter:verse space as the Dutch side
// by book-name insertion order (the JSON's keys are already Genesis..
// Revelation in file order, so first-seen order IS canonical order).
function parseKjv(jsonPath: string): { bookOrder: string[]; verses: Record<string, string> } {
  const raw: Record<string, string> = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const keyRe = /^(.+) (\d+):(\d+)$/;

  const bookOrder: string[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(raw)) {
    const m = key.match(keyRe);
    if (!m) continue; // not expected in this source — skip defensively rather than fail the whole build
    if (!seen.has(m[1])) { seen.add(m[1]); bookOrder.push(m[1]); }
  }
  if (bookOrder.length !== 66) {
    throw new Error(`Expected 66 books in the KJV source, found ${bookOrder.length} — check ${jsonPath}`);
  }
  const bookToNumber = new Map(bookOrder.map((name, i) => [name, i + 1]));

  const verses: Record<string, string> = {};
  for (const [key, rawText] of Object.entries(raw)) {
    const m = key.match(keyRe);
    if (!m) continue;
    const n = bookToNumber.get(m[1]);
    if (!n) continue;
    // "# " marks a new paragraph (only ever leading, never mid-verse — see
    // the plan's verification pass); "[word]" marks an italicized supplied
    // word. Neither is meaningful once this text is substituted into a
    // translated segment, so both are stripped rather than carried through.
    const text = rawText.replace(/^#\s*/, '').replace(/[[\]]/g, '');
    verses[`${n}:${m[2]}:${m[3]}`] = text;
  }
  return { bookOrder, verses };
}

function main() {
  console.log(`Reading Dutch Statenvertaling from ${SV_XML_PATH}`);
  const sv = parseStatenvertaling(SV_XML_PATH);
  console.log(`  ${sv.books.length} books, ${Object.keys(sv.verses).length} verses`);
  if (sv.books.length !== 66) {
    throw new Error(`Expected 66 books in the Statenvertaling source, found ${sv.books.length} — check ${SV_XML_PATH}`);
  }

  console.log(`Reading KJV from ${KJV_JSON_PATH}`);
  const kjv = parseKjv(KJV_JSON_PATH);
  console.log(`  ${kjv.bookOrder.length} books, ${Object.keys(kjv.verses).length} verses`);

  const books: BookEntry[] = sv.books.map((b, i) => {
    const enRaw = kjv.bookOrder[i];
    return { n: b.n, nl: b.nl, en: EN_DISPLAY_OVERRIDES[enRaw] ?? enRaw, abbr: b.abbr };
  });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'books.json'), JSON.stringify(books, null, 2) + '\n');
  writeFileSync(path.join(OUT_DIR, 'sv-nl.json.gz'), gzipSync(JSON.stringify(sv.verses)));
  writeFileSync(path.join(OUT_DIR, 'kjv-en.json.gz'), gzipSync(JSON.stringify(kjv.verses)));

  const generatedTs = [
    '// AUTO-GENERATED by scripts/build-bible-data.ts — do not edit by hand.',
    '// Canonical 66-book table joining the Dutch Statenvertaling\'s book names',
    '// with the KJV\'s, by canonical position (both list Genesis..Revelation in',
    '// the same order). Committed as source (unlike data/bible/*, which is',
    '// gitignored) because client/src/lib/sermon/bible-ref.ts needs only this',
    '// small table, never verse text — see CLAUDE.md "Scripture pipeline".',
    '',
    'export interface BibleBook {',
    '  n: number;',
    '  nl: string;',
    '  en: string;',
    '  /** Dutch short form from the Statenvertaling source (e.g. "Joh", "1Kor") — a starting point, not an exhaustive alias set. */',
    '  abbr: string;',
    '}',
    '',
    `export const BIBLE_BOOKS: BibleBook[] = ${JSON.stringify(books, null, 2)};`,
    '',
  ].join('\n');
  writeFileSync(CLIENT_BOOKS_PATH, generatedTs);

  console.log(`\nWrote ${path.join(OUT_DIR, 'books.json')} (${books.length} books)`);
  console.log(`Wrote ${path.join(OUT_DIR, 'sv-nl.json.gz')} (${Object.keys(sv.verses).length} verses)`);
  console.log(`Wrote ${path.join(OUT_DIR, 'kjv-en.json.gz')} (${Object.keys(kjv.verses).length} verses)`);
  console.log(`Wrote ${CLIENT_BOOKS_PATH}`);

  const spotKey = '43:3:16'; // John 3:16
  console.log(`\nSpot check ${spotKey} (John 3:16):`);
  console.log(`  NL: ${JSON.stringify(sv.verses[spotKey])}`);
  console.log(`  EN: ${JSON.stringify(kjv.verses[spotKey])}`);
}

main();
