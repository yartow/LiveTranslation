// The multi-language glossary as the listener translator uses it: English -> Hindi/Tamil/Chinese.
//
// The glossary CSV is Dutch -> English (Nederlands,Engels,Categorie,Notitie), with optional extra columns
// holding the fixed term in each listener language (glossary-parse.ts, LANGUAGE_COLUMNS). The phones'
// translation starts from the finished English (listener-translate.ts), so the lookup runs the other way
// round: which English terms of the CSV occur in the lines being translated, and what must each be called
// in that language. Only those few terms go into the prompt — never the whole 300-row glossary.
//
// Safety: the cells are sanitised in glossary-parse.ts (one line, length-capped, injection rows dropped) and
// reach the model as a fenced DATA-ONLY block (buildUserMessage). The file is read through the glossary
// sandbox (glossary-file.ts: a plain filename inside GLOSSARY_DIR, size-capped). Nothing here ever throws.

import { readGlossaryFile, statGlossaryFile } from './glossary-file';
import { parseGlossaryCsv, type GlossaryRow } from './glossary-parse';
import type { ExtraListenerLang } from './listener-lang';

export interface GlossaryTerm {
  /** The English term as it appears in the glossary (shown to the model). */
  en: string;
  /** What it is called in the listener language. */
  term: string;
}

interface Entry extends GlossaryTerm {
  pattern: RegExp;
  /** A Bible-book title that is also a person's name: only counts in a reference ("John 3:16", "the book of Daniel"). */
  reference: boolean;
}

export interface LanguageGlossary {
  /** Changes whenever the file does — part of the translation memo key. */
  version: string;
  entries: Entry[];
}

/** At most this many terms go into one request. */
export const MAX_TERMS_PER_REQUEST = 40;
/** Names are matched with their capital letter ("Mark", "Acts", "Judges" are also ordinary words); concepts are not. */
const CASE_SENSITIVE_CATEGORIES: ReadonlySet<string> = new Set(['Bijbelboek', 'Eigennaam', 'Plaatsnaam']);
const MIN_TERM_LEN = 3;
/** Bible books whose English title is also a person's name. In Chinese, say, the book (约翰福音) and the man (约翰) differ. */
const NAME_LIKE_BOOKS: ReadonlySet<string> = new Set([
  'matthew', 'mark', 'luke', 'john', 'james', 'jude', 'ruth', 'esther', 'job', 'joshua', 'samuel', 'ezra',
  'nehemiah', 'isaiah', 'jeremiah', 'ezekiel', 'daniel', 'hosea', 'joel', 'amos', 'obadiah', 'jonah', 'micah',
  'nahum', 'habakkuk', 'zephaniah', 'haggai', 'zechariah', 'malachi', 'titus', 'philemon', 'timothy', 'peter',
]);
// No `u` flag / \p{} (this project's tsconfig has no target) — the same explicit ranges as glossary-check.ts.
const WORD_CHAR = 'A-Za-z0-9À-ÿĀ-ɏ_';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BOOK_LABEL = ' (the Bible book)';
function wordingLength(entry: { en: string; reference: boolean }): number {
  return entry.reference ? entry.en.length - BOOK_LABEL.length : entry.en.length;
}

/** The English wordings one glossary row stands for: "A / B" is two, "(note)" parts are dropped. */
export function englishVariants(en: string): string[] {
  return en.split(' / ')
    .map(part => part.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(part => part.length >= MIN_TERM_LEN);
}

/**
 * The lookup for one language from the CSV's fixed rows. Rows without a cell in that language are skipped.
 * A wording that two rows give different renderings (the book Isaiah vs the prophet in Chinese: 以赛亚书 /
 * 以赛亚) is ambiguous from the English alone, so it is left out rather than guessed.
 */
export function buildLanguageGlossary(fixed: readonly GlossaryRow[], lang: ExtraListenerLang, version: string): LanguageGlossary {
  const byWording = new Map<string, { en: string; terms: Set<string>; term: string; caseSensitive: boolean; reference: boolean }>();
  for (const row of fixed) {
    const term = row.lang?.[lang];
    if (!term) continue;
    for (const variant of englishVariants(row.en)) {
      const reference = row.category === 'Bijbelboek' && NAME_LIKE_BOOKS.has(variant.toLowerCase());
      const key = `${variant.toLowerCase()}#${reference ? 'ref' : 'plain'}`;
      const caseSensitive = CASE_SENSITIVE_CATEGORIES.has(row.category);
      const found = byWording.get(key);
      if (found) {
        found.terms.add(term);
        found.caseSensitive = found.caseSensitive && caseSensitive;
      } else {
        byWording.set(key, { en: variant, terms: new Set([term]), term, caseSensitive, reference });
      }
    }
  }

  const entries: Entry[] = [];
  byWording.forEach(item => {
    if (item.terms.size !== 1) return;
    const body = escapeRegExp(item.en).replace(/ /g, '\\s+');
    const plain = `(?<![${WORD_CHAR}])${body}(?![${WORD_CHAR}])`;
    // "John 3:16" or "the book of John" — a bare "John" is the person.
    const source = item.reference
      ? `(?<![${WORD_CHAR}])${body}(?=\\s+\\d)|(?<![${WORD_CHAR}])[Bb]ook\\s+of\\s+${body}(?![${WORD_CHAR}])`
      : plain;
    entries.push({
      // Shown to the model, and what tells "Isaiah (the Bible book)" from the prophet "Isaiah" apart.
      en: item.reference ? item.en + BOOK_LABEL : item.en,
      term: item.term,
      reference: item.reference,
      pattern: new RegExp(source, item.caseSensitive ? 'g' : 'gi'),
    });
  });
  // A book hint that says the same as the plain name adds nothing (Hindi and Tamil write the prophet and the book alike).
  const plainTerm = new Map<string, string>();
  entries.forEach(e => { if (!e.reference) plainTerm.set(e.en.toLowerCase(), e.term); });
  const distinct = entries.filter(e => !(e.reference && plainTerm.get(e.en.slice(0, -BOOK_LABEL.length).toLowerCase()) === e.term));
  entries.length = 0;
  entries.push(...distinct);
  // Longest wording first, so "mercy seat" claims its words before "mercy" can; at equal length the
  // reference form first, so "Isaiah 53" is the book while "Isaiah said" is the prophet.
  entries.sort((a, b) => wordingLength(b) - wordingLength(a) || Number(b.reference) - Number(a.reference));
  return { version, entries };
}

/**
 * The glossary terms that occur in `texts`, in order of first appearance. A term inside a longer matched
 * term does not count ("Mercy" in "Mercy seat"); at most MAX_TERMS_PER_REQUEST are returned.
 */
export function findTerms(glossary: LanguageGlossary, texts: readonly string[]): GlossaryTerm[] {
  if (glossary.entries.length === 0) return [];
  const haystack = texts.join('\n');
  const spans: { start: number; end: number; entry: Entry }[] = [];
  for (const entry of glossary.entries) {
    entry.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = entry.pattern.exec(haystack)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, entry });
      if (m[0].length === 0) entry.pattern.lastIndex++;
    }
  }
  const claimed: { start: number; end: number }[] = [];
  const out: { at: number; term: GlossaryTerm }[] = [];
  const seen = new Set<string>();
  // Entries are longest first, so earlier spans win an overlap.
  for (const span of spans) {
    if (claimed.some(c => span.start < c.end && span.end > c.start)) continue;
    claimed.push(span);
    if (seen.has(span.entry.en.toLowerCase())) continue;
    seen.add(span.entry.en.toLowerCase());
    out.push({ at: span.start, term: { en: span.entry.en, term: span.entry.term } });
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(0, MAX_TERMS_PER_REQUEST).map(o => o.term);
}

// ── Reading the file ────────────────────────────────────────────────────────

const STAT_TTL_MS = 1000;

interface Loaded {
  mtimeMs: number;
  fixed: GlossaryRow[];
  perLang: Map<ExtraListenerLang, LanguageGlossary>;
}
const loaded = new Map<string, Loaded>();
const lastStat = new Map<string, { at: number; mtimeMs: number | null }>();

function mtimeOf(csv: string): number | null {
  const now = Date.now();
  const cached = lastStat.get(csv);
  if (cached && now - cached.at < STAT_TTL_MS) return cached.mtimeMs;
  const mtimeMs = statGlossaryFile(csv, 'csv');
  lastStat.set(csv, { at: now, mtimeMs });
  return mtimeMs;
}

function load(csv: string): Loaded | null {
  const mtimeMs = mtimeOf(csv);
  if (mtimeMs === null) { loaded.delete(csv); return null; }
  const cached = loaded.get(csv);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  try {
    const file = readGlossaryFile(csv, 'csv');
    const fixed = parseGlossaryCsv(file.text).fixedAll;
    const next: Loaded = { mtimeMs: file.mtimeMs, fixed, perLang: new Map() };
    loaded.set(csv, next);
    return next;
  } catch {
    loaded.delete(csv);
    return null;
  }
}

/** The English -> `lang` glossary of `csv` (a plain filename in GLOSSARY_DIR), or null when there is none or it has no such column. */
export function languageGlossary(csv: string | undefined, lang: ExtraListenerLang): LanguageGlossary | null {
  if (!csv) return null;
  const file = load(csv);
  if (!file) return null;
  let glossary = file.perLang.get(lang);
  if (!glossary) {
    glossary = buildLanguageGlossary(file.fixed, lang, `${csv}:${file.mtimeMs}`);
    file.perLang.set(lang, glossary);
  }
  return glossary.entries.length > 0 ? glossary : null;
}

/** What the engine plugs into listener-translate.ts: which terms to pass along, and a key that changes when they could. */
export const fileGlossary = {
  terms(csv: string | undefined, lang: ExtraListenerLang, texts: readonly string[]): GlossaryTerm[] {
    const glossary = languageGlossary(csv, lang);
    return glossary ? findTerms(glossary, texts) : [];
  },
  version(csv: string | undefined, lang: ExtraListenerLang): string {
    return languageGlossary(csv, lang)?.version ?? '';
  },
};

export function _resetListenerGlossaryForTests(): void {
  loaded.clear();
  lastStat.clear();
}
