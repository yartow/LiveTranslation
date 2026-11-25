// Parses the two source files behind sermon mode's file-based glossary:
//   - a CSV of NL->EN terms (Nederlands,Engels,Categorie,Notitie)
//   - a markdown "disambiguation" doc for terms with no fixed 1-to-1 translation
//
// The real CSV on disk is malformed: 10 of 287 rows contain an unquoted
// comma inside the Engels or Notitie column, which a strict RFC4180 parser
// silently misreads (the comma shifts every following column left by one —
// e.g. Categorie ends up holding a fragment like " archaic form)"). This
// module repairs those rows using Categorie's closed vocabulary as an
// anchor: scan the row for the first field that is a known category name,
// and treat everything before it as Engels and everything after it as
// Notitie. See the plan doc's "What I verified in the real data" section.
//
// A second, independent problem: some terms (Genade, Bekering, Zaligheid,
// Gerechtigheid) appear BOTH under a fixed category AND as
// "Contextafhankelijk". The disambiguation-prompt's own precedence rule
// (glossary fixed entry wins) would defeat its own disambiguation table for
// exactly its most important terms if honored literally — so here,
// Contextafhankelijk wins instead, and the fixed entry is dropped with a
// warning. See resolveDuplicates() below.

import { parseCsv } from './csv-parse';
import { sanitizeGlossaryField, looksLikeInjection } from './prompt-safety';
import { EXTRA_LISTENER_LANGUAGES, type ExtraListenerLang } from './listener-lang';

export const KNOWN_CATEGORIES: ReadonlySet<string> = new Set([
  'Theologisch',
  'Bijbelboek',
  'Eigennaam',
  'Eschatologisch/Leerstellig',
  'Archaïsch',
  'Plaatsnaam',
  'Contextafhankelijk',
  'Psalmberijming',
  'Theologisch/Archaïsch',
  // Everyday language, not only theology. These are plain tags (like Theologisch): they are not treated
  // specially by the prompt or the adherence check, but a row with a category missing from this set is dropped.
  'Algemeen',
  'Gezegde',
  'Spreekwoord',
  'Beeldspraak',
  'Afkorting',
]);

const EXPECTED_HEADER = ['Nederlands', 'Engels', 'Categorie', 'Notitie'];
const MAX_NL_LEN = 80;
const MAX_EN_LEN = 120;
const MAX_NOTE_LEN = 200;
const MAX_TRANSLATION_LEN = 120;

// Optional extra columns after Notitie: the fixed term for each listener language (listener-translate.ts).
// They are read BY HEADER NAME, so their order does not matter; the first four columns keep their
// positions (that is what the comma repair below relies on). A file with only the four original
// columns is unchanged.
export const LANGUAGE_COLUMNS: Record<ExtraListenerLang, string> = {
  hi: 'Hindi',
  ta: 'Tamil',
  zh: 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
};

/** The fixed term per listener language, as found in a row's language columns (empty cells are absent). */
export type LanguageTerms = Partial<Record<ExtraListenerLang, string>>;

export interface GlossaryRow {
  nl: string;
  en: string;
  category: string;
  note: string;
  /** Hindi/Tamil/Chinese terms from the CSV's language columns — see LANGUAGE_COLUMNS. */
  lang?: LanguageTerms;
}

export interface ParsedGlossary {
  fixed: GlossaryRow[];
  /**
   * Every fixed row that survived sanitising — `fixed` keeps one row per Dutch term (the Dutch -> English
   * lookup needs exactly one answer), this keeps them all: the book "Jesaja" and the prophet "Jesaja" are
   * two rows, and the English -> Hindi/Tamil/Chinese lookup needs both. Terms that are Contextafhankelijk are not in it.
   */
  fixedAll: GlossaryRow[];
  context: GlossaryRow[];
  totalRows: number;
  repairedRows: number;
  droppedRows: number;
  warnings: string[];
  /** Language columns present in the header (Hindi, Tamil, ...), whether or not any row fills them. */
  languageColumns: ExtraListenerLang[];
  /** How many of the kept rows have a term in each language column. */
  languageCounts: Partial<Record<ExtraListenerLang, number>>;
}

/**
 * Repairs a row with more fields than the header, using the closed category vocabulary as an anchor:
 * everything between the Dutch term and the category is the English, and — the header says how many
 * columns follow the category — surplus fields are glued back onto the Notitie. (A comma inside a
 * language cell cannot be told apart from one inside the Notitie; files this app writes are properly
 * quoted, so that only matters for hand-edited rows.) Returns the row at exactly `width` fields, or null
 * if no field matches a known category (unrecoverable).
 */
function repairRow(fields: string[], width: number): string[] | null {
  const anchorIndex = fields.findIndex((f, i) => i > 0 && KNOWN_CATEGORIES.has(f.trim()));
  if (anchorIndex === -1) return null;
  const tail = fields.slice(anchorIndex + 1);
  const wanted = width - 3; // Notitie + the language columns
  const surplus = tail.length - wanted;
  if (surplus < 0) return null;
  // Rejoin with a bare comma (not ", ") — the split fragments already carry
  // whatever whitespace originally followed the comma, so this reconstructs
  // the exact original text rather than doubling it up.
  return [
    fields[0],
    fields.slice(1, anchorIndex).join(','),
    fields[anchorIndex].trim(),
    tail.slice(0, surplus + 1).join(','),
    ...tail.slice(surplus + 1),
  ];
}

/** One CSV row as written, repaired where needed but not yet sanitised or checked. */
export interface GlossaryRecord { nl: string; en: string; category: string; note: string; lang: LanguageTerms }

export interface ReadGlossary {
  records: GlossaryRecord[];
  languageColumns: ExtraListenerLang[];
  /** Data rows seen (before any were dropped). */
  totalRows: number;
  repairedRows: number;
  droppedRows: number;
  warnings: string[];
}

/**
 * Reads the CSV into one record per data row — header-driven, with the comma repair applied — without
 * sanitising, duplicate resolution or category checks. parseGlossaryCsv builds on it; scripts that
 * rewrite the file (e.g. adding language columns) use it to keep every row.
 */
export function readGlossaryRecords(text: string): ReadGlossary {
  const rows = parseCsv(text).filter(r => r.some(f => f.trim().length > 0));
  const warnings: string[] = [];
  if (rows.length === 0) {
    return { records: [], languageColumns: [], totalRows: 0, repairedRows: 0, droppedRows: 0, warnings };
  }

  const header = rows[0].map(f => f.trim());
  const standard = EXPECTED_HEADER.every((name, i) => header[i] === name);
  if (!standard) {
    warnings.push(`Unexpected CSV header: expected "${EXPECTED_HEADER.join(',')}" first, found "${header.join(',')}".`);
  }
  // Without the standard first four columns the file is read as the original 4-column layout.
  const width = standard ? header.length : EXPECTED_HEADER.length;

  const columnOf = new Map<ExtraListenerLang, number>();
  if (standard) {
    for (let i = EXPECTED_HEADER.length; i < header.length; i++) {
      const lang = EXTRA_LISTENER_LANGUAGES.find(l => LANGUAGE_COLUMNS[l] === header[i]);
      if (!lang) warnings.push(`Unknown CSV column '${header[i]}' is ignored.`);
      else if (columnOf.has(lang)) warnings.push(`Duplicate CSV column '${header[i]}' — only the first is used.`);
      else columnOf.set(lang, i);
    }
  }

  const dataRows = rows.slice(1);
  let repairedRows = 0;
  let droppedRows = 0;
  const records: GlossaryRecord[] = [];

  for (const original of dataRows) {
    let fields = original;
    if (fields.length > width) {
      const repaired = repairRow(fields, width);
      if (!repaired) {
        droppedRows++;
        warnings.push(`Row skipped (category not recognised): '${fields[0]}'`);
        continue;
      }
      fields = repaired;
      repairedRows++;
    } else if (fields.length >= 3) {
      // A short row (the legacy 3-column form, or language cells left off the end) reads as empty cells.
      fields = fields.concat(new Array<string>(width - fields.length).fill(''));
    } else {
      droppedRows++;
      warnings.push(`Row skipped (too few fields): '${fields[0] ?? ''}'`);
      continue;
    }

    const lang: LanguageTerms = {};
    columnOf.forEach((col, l) => { if (fields[col]?.trim()) lang[l] = fields[col]; });
    records.push({ nl: fields[0], en: fields[1], category: fields[2].trim(), note: fields[3], lang });
  }

  return {
    records,
    languageColumns: EXTRA_LISTENER_LANGUAGES.filter(l => columnOf.has(l)),
    totalRows: dataRows.length,
    repairedRows,
    droppedRows,
    warnings,
  };
}

interface RawRow { nl: string; en: string; category: string; note: string; lang?: LanguageTerms }

function resolveDuplicates(rows: RawRow[], warnings: string[]): { fixed: GlossaryRow[]; context: GlossaryRow[] } {
  const groups = new Map<string, RawRow[]>();
  for (const row of rows) {
    const key = row.nl.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const fixed: GlossaryRow[] = [];
  const context: GlossaryRow[] = [];

  for (const group of Array.from(groups.values())) {
    const contextRows = group.filter(r => r.category === 'Contextafhankelijk');
    const fixedRows = group.filter(r => r.category !== 'Contextafhankelijk');

    if (contextRows.length > 0) {
      context.push(contextRows[0]);
      if (fixedRows.length > 0) {
        const categories = Array.from(new Set(fixedRows.map(r => r.category))).join(', ');
        warnings.push(
          `'${fixedRows[0].nl}' is listed both as a fixed term (${categories}) and as Contextafhankelijk in the CSV — Contextafhankelijk takes precedence and the fixed translation(s) were ignored.`,
        );
      }
      if (contextRows.length > 1) {
        warnings.push(`'${contextRows[0].nl}' appears more than once as Contextafhankelijk; only the first row was used.`);
      }
    } else if (fixedRows.length > 0) {
      fixed.push(fixedRows[0]);
      const distinctEn = Array.from(new Set(fixedRows.map(r => r.en)));
      if (fixedRows.length > 1 && distinctEn.length > 1) {
        warnings.push(
          `'${fixedRows[0].nl}' appears several times with different translations (${distinctEn.join(' / ')}); the first one was used.`,
        );
      }
    }
  }

  return { fixed, context };
}

export function parseGlossaryCsv(text: string): ParsedGlossary {
  const read = readGlossaryRecords(text);
  const warnings = read.warnings;
  let droppedRows = read.droppedRows;
  const raw: RawRow[] = [];

  for (const rec of read.records) {
    if (!KNOWN_CATEGORIES.has(rec.category)) {
      droppedRows++;
      warnings.push(`Row skipped (unknown category '${rec.category}'): '${rec.nl}'`);
      continue;
    }

    const nl = sanitizeGlossaryField(rec.nl, MAX_NL_LEN);
    const en = sanitizeGlossaryField(rec.en, MAX_EN_LEN);
    const note = sanitizeGlossaryField(rec.note, MAX_NOTE_LEN);
    if (!nl || !en) {
      droppedRows++;
      warnings.push(`Row skipped (empty NL/EN field after sanitising): '${rec.nl}'`);
      continue;
    }

    // Injection check on the rendered "NL → EN" line — the anchored
    // INJECTION_RE only ever matches the first word, i.e. the Dutch term
    // itself, so a Notitie starting with "Niet ..." can never trip this.
    if (looksLikeInjection(`${nl} → ${en}`)) {
      droppedRows++;
      warnings.push(`Row skipped (looks like prompt injection): '${nl}'`);
      continue;
    }

    // The language cells are embedded in listener-translation prompts as data, so they get the same
    // sanitising as every other glossary field.
    const lang: LanguageTerms = {};
    for (const l of EXTRA_LISTENER_LANGUAGES) {
      const cell = rec.lang[l];
      const clean = cell ? sanitizeGlossaryField(cell, MAX_TRANSLATION_LEN) : '';
      if (clean) lang[l] = clean;
    }

    raw.push(Object.keys(lang).length > 0 ? { nl, en, category: rec.category, note, lang } : { nl, en, category: rec.category, note });
  }

  const { fixed, context } = resolveDuplicates(raw, warnings);

  const contextKeys = new Set(context.map(r => r.nl.toLowerCase()));
  const fixedAll = raw.filter(r => r.category !== 'Contextafhankelijk' && !contextKeys.has(r.nl.toLowerCase()));
  const languageCounts: Partial<Record<ExtraListenerLang, number>> = {};
  for (const l of read.languageColumns) {
    languageCounts[l] = fixedAll.filter(r => r.lang?.[l]).length;
  }

  return {
    fixed, fixedAll, context, totalRows: read.totalRows, repairedRows: read.repairedRows, droppedRows, warnings,
    languageColumns: read.languageColumns, languageCounts,
  };
}

export interface DisambiguationDoc {
  systemBlock: string;
  examplesBlock: string;
}

export function parseDisambiguationDoc(md: string): DisambiguationDoc {
  const blocks: string[] = [];
  // The opening fence's info string (e.g. "```text") must not leak into the
  // captured content — match past the rest of that line, capture only what
  // follows it up to the closing fence.
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    blocks.push(m[1].trim());
  }
  return {
    systemBlock: blocks[0] ?? '',
    examplesBlock: blocks[1] ?? '',
  };
}

/**
 * Extracts the NL terms named in the v2 disambiguation table's first
 * column: rows of the form "| term | ... |" that follow the "| --- |"
 * header separator, up to the next blank line.
 */
export function extractDisambiguationTableTerms(systemBlock: string): string[] {
  const lines = systemBlock.split('\n');
  const terms: string[] = [];
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) { inTable = false; continue; }
    if (/^\|[\s-]+\|/.test(trimmed)) { inTable = true; continue; } // header separator row
    if (!inTable) continue;
    const firstCol = trimmed.split('|')[1]?.trim();
    if (firstCol) terms.push(firstCol.toLowerCase());
  }
  return terms;
}

/** Both-direction diff between the CSV's Contextafhankelijk terms and the v2 table's terms — the requirement-2 consistency check. */
export function crossCheckContextTerms(csvContextTerms: string[], docTerms: string[]): string[] {
  const csvSet = new Set(csvContextTerms.map(t => t.toLowerCase()));
  const docSet = new Set(docTerms.map(t => t.toLowerCase()));
  const warnings: string[] = [];

  for (const term of Array.from(docSet)) {
    if (!csvSet.has(term)) {
      warnings.push(`'${term}' is in the disambiguation table but is not marked Contextafhankelijk in the CSV.`);
    }
  }
  for (const term of Array.from(csvSet)) {
    if (!docSet.has(term)) {
      warnings.push(`'${term}' is marked Contextafhankelijk in the CSV but has no row in the disambiguation table.`);
    }
  }
  return warnings;
}
