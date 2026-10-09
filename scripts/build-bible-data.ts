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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';

const SV_XML_PATH = process.env.SV_XML_PATH
  || path.join(os.homedir(), 'Documents/GitHub/open-bibles/dut-statenvertaling.zefania.xml');
const KJV_JSON_PATH = process.env.KJV_JSON_PATH
  || path.join(os.homedir(), 'Documents/GitHub/kjv/json/verses-1769.json');

// Optional English texts (copyrighted — kept local, outputs are gitignored). Beblia
// "Holy-Bible-XML-Format" layout: <book number><chapter number><verse number>.
const ESV_XML_PATH = process.env.ESV_XML_PATH
  || path.join(os.homedir(), 'Documents/GitHub/Holy-Bible-XML-Format/EnglishESVBible.xml');
const LSB_XML_PATH = process.env.LSB_XML_PATH
  || path.join(os.homedir(), 'Documents/GitHub/Holy-Bible-XML-Format/EnglishLSBBible.xml');

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

// Beblia-format English Bible (ESV/LSB): flat <book number="n"><chapter
// number="c"><verse number="v">text</verse>. Joined onto the same
// bookNumber:chapter:verse key space by the book's own number (1..66, canonical
// order — asserted below). Empty verses (e.g. Matt 17:21 in ESV) are skipped.
function parseBebliaXml(xmlPath: string): Record<string, string> {
  const xml = readFileSync(xmlPath, 'utf-8').replace(/^﻿/, '');
  const verses: Record<string, string> = {};
  const bookRe = /<book number="(\d+)">([\s\S]*?)<\/book>/g;
  const chapterRe = /<chapter number="(\d+)">([\s\S]*?)<\/chapter>/g;
  const verseRe = /<verse number="(\d+)">([^<]*)<\/verse>/g;

  let books = 0;
  let bookMatch: RegExpExecArray | null;
  while ((bookMatch = bookRe.exec(xml))) {
    const [, n, bookBody] = bookMatch;
    books++;
    if (Number(n) !== books) {
      throw new Error(`${xmlPath}: book order mismatch — expected book ${books}, got ${n}`);
    }
    chapterRe.lastIndex = 0;
    let chapterMatch: RegExpExecArray | null;
    while ((chapterMatch = chapterRe.exec(bookBody))) {
      const [, c, chapterBody] = chapterMatch;
      verseRe.lastIndex = 0;
      let verseMatch: RegExpExecArray | null;
      while ((verseMatch = verseRe.exec(chapterBody))) {
        const text = decodeXmlEntities(verseMatch[2]).replace(/\s+/g, ' ').trim();
        if (text) verses[`${n}:${c}:${verseMatch[1]}`] = text;
      }
    }
  }
  if (books !== 66) throw new Error(`Expected 66 books in ${xmlPath}, found ${books}`);
  return verses;
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

// ─── Psalm superscriptions ──────────────────────────────────────────────────
// Two numbering problems, both confined to the Psalms:
//
// (a) The Statenvertaling file numbers like the Hebrew text: a psalm's
//     superscription that stands alone ("Een psalm van David, voor den
//     opperzangmeester.") is its own verse 1 (verses 1+2 for Ps 51/52/54/60),
//     pushing the first real verse to 2 (or 3). English Bibles leave titles
//     unnumbered, so SV verse v == English verse v - t, where t = the number
//     of stand-alone title verses. A title written inline ("Een psalm van
//     David. De HEERE is mijn Herder…", Ps 23) shifts nothing. We derive t per
//     psalm from the SV text and write it to data/bible/psalm-titles.json;
//     server/lib/bible-store.ts applies it when mapping a spoken (SV-numbered)
//     verse onto English text. (The source file also lacks the last t verses
//     of those psalms — not recoverable here, so those verses never match.)
//
// (b) The Beblia ESV/LSB texts prepend the superscription to English verse 1
//     ("A PSALM OF DAVID.The LORD is my shepherd…"), which must not leak into a
//     substituted quote — stripPsalmTitles() below removes it at build time.

// Opening words of an SV superscription. Anchored at the start of verse 1; a
// match plus nothing after the first sentence = a stand-alone title verse.
const SV_TITLE_CUE = /^(?:eene? )?(?:psalm|lied|onderwijzing|gebed|gouden kleinood|opschrift|lofzang|voor den opperzangmeester|davids )/i;
// The Hebrew superscription spans two verses only in these psalms (second verse begins
// "Toen de profeet…" / "Als Doeg…" / "Als de Zifieten…" / "Als hij gevochten…").
const SV_TWO_VERSE_TITLE = /^(?:toen|als) (?:de|hij|doeg)\b/i;

function detectPsalmTitleVerses(svVerses: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (let c = 1; c <= 150; c++) {
    const v1 = svVerses[`19:${c}:1`];
    const v2 = svVerses[`19:${c}:2`] ?? '';
    if (!v1 || !SV_TITLE_CUE.test(v1)) continue;
    // Text after the first sentence → the title shares its verse with the psalm's first line.
    const bodyAfterFirstSentence = /^[^.!?]*[.!?]\s+\S/.test(v1);
    if (bodyAfterFirstSentence) continue;
    out[String(c)] = SV_TWO_VERSE_TITLE.test(v2) ? 2 : 1;
  }
  return out;
}

const normWords = (t: string): Set<string> =>
  new Set(t.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean));

function dice(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  a.forEach((w) => { if (b.has(w)) shared++; });
  return a.size + b.size ? (2 * shared) / (a.size + b.size) : 0;
}

/** Offsets just after each sentence end (including a closing quote) — 0 first, so cuts[k] = start of the (k+1)th sentence. */
function sentenceStarts(text: string): number[] {
  const starts = [0];
  const re = /(?<=[.?!:][”’"')]?)\s*(?=[A-Z“‘"'(])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) re.lastIndex++;
    const at = m.index + m[0].length;
    if (at > 0 && at < text.length && starts[starts.length - 1] !== at) starts.push(at);
  }
  return starts;
}

/**
 * Removes the superscription the Beblia ESV/LSB files glue onto Psalm verse 1.
 *  - ESV renders titles in ALL CAPS, so the title is exactly the leading
 *    all-caps sentences (deterministic).
 *  - LSB uses ordinary case. A title exists iff the ESV one did (same Hebrew
 *    superscription); where it ends is chosen as the sentence boundary at which
 *    the remainder best overlaps (Dice) the title-free KJV + stripped-ESV
 *    verse 1. Checked by eye across all 116 titled psalms.
 * Mutates `english`; `esvBodies` carries the stripped ESV verse 1 of every
 * titled psalm from the ESV pass to the LSB pass. Returns the chapters stripped.
 */
function stripPsalmTitles(
  english: Record<string, string>, kind: 'ESV' | 'LSB',
  kjv: Record<string, string>, esvBodies: Map<number, string>,
): number[] {
  const stripped: number[] = [];
  for (let c = 1; c <= 150; c++) {
    const key = `19:${c}:1`;
    const v1 = english[key];
    if (!v1) continue;
    const starts = sentenceStarts(v1);
    let cut = 0;
    if (kind === 'ESV') {
      for (let i = 0; i < starts.length - 1; i++) {
        const sentence = v1.slice(starts[i], starts[i + 1]);
        if (/[a-z]/.test(sentence) || !/[A-Z]{2}/.test(sentence)) break;
        cut = i + 1;
      }
      if (cut === 0) continue;
      esvBodies.set(c, v1.slice(starts[cut]).trim());
    } else {
      const esvBody = esvBodies.get(c);
      if (esvBody === undefined) continue; // no ESV title → no LSB title
      const ref = new Set<string>(Array.from(normWords(kjv[key] ?? '')).concat(Array.from(normWords(esvBody))));
      let bestScore = -1;
      for (let i = 1; i < starts.length; i++) {
        const score = dice(normWords(v1.slice(starts[i])), ref);
        if (score > bestScore) { bestScore = score; cut = i; }
      }
      if (cut === 0) continue; // single-sentence verse: nothing safe to cut
    }
    english[key] = v1.slice(starts[cut]).trim();
    stripped.push(c);
  }
  return stripped;
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

  const psalmTitles = detectPsalmTitleVerses(sv.verses);
  writeFileSync(path.join(OUT_DIR, 'psalm-titles.json'), JSON.stringify(psalmTitles) + '\n');
  const counts = Object.values(psalmTitles).reduce<Record<number, number>>((a, t) => ({ ...a, [t]: (a[t] ?? 0) + 1 }), {});
  console.log(`Psalm stand-alone title verses: ${counts[1] ?? 0} psalms with 1, ${counts[2] ?? 0} with 2 -> psalm-titles.json`);

  const extras: Array<{ label: string; file: string; xmlPath: string }> = [
    { label: 'ESV', file: 'esv-en.json.gz', xmlPath: ESV_XML_PATH },
    { label: 'LSB', file: 'lsb-en.json.gz', xmlPath: LSB_XML_PATH },
  ];
  const extraVerses: Record<string, Record<string, string>> = {};
  const esvBodies = new Map<number, string>();
  for (const { label, file, xmlPath } of extras) {
    if (!existsSync(xmlPath)) {
      console.warn(`  (skipping ${label}: ${xmlPath} not found — set ${label}_XML_PATH to include it)`);
      continue;
    }
    const verses = parseBebliaXml(xmlPath);
    const stripped = stripPsalmTitles(verses, label as 'ESV' | 'LSB', kjv.verses, esvBodies);
    console.log(`  ${label}: stripped ${stripped.length} psalm superscriptions from verse 1`);
    extraVerses[label] = verses;
    writeFileSync(path.join(OUT_DIR, file), gzipSync(JSON.stringify(verses)));
    console.log(`Wrote ${path.join(OUT_DIR, file)} (${Object.keys(verses).length} verses)`);
  }

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
  console.log(`  KJV: ${JSON.stringify(kjv.verses[spotKey])}`);
  for (const [label, verses] of Object.entries(extraVerses)) {
    console.log(`  ${label}: ${JSON.stringify(verses[spotKey])}`);
  }
}

main();
