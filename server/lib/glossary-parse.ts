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
]);

const EXPECTED_HEADER = ['Nederlands', 'Engels', 'Categorie', 'Notitie'];
const MAX_NL_LEN = 80;
const MAX_EN_LEN = 120;
const MAX_NOTE_LEN = 200;

export interface GlossaryRow {
  nl: string;
  en: string;
  category: string;
  note: string;
}

export interface ParsedGlossary {
  fixed: GlossaryRow[];
  context: GlossaryRow[];
  totalRows: number;
  repairedRows: number;
  droppedRows: number;
  warnings: string[];
}

/**
 * Repairs a >4-field row using the closed category vocabulary as an anchor.
 * Returns null if no field matches a known category (unrecoverable).
 */
function repairRow(fields: string[]): { nl: string; en: string; category: string; note: string } | null {
  const anchorIndex = fields.findIndex((f, i) => i > 0 && KNOWN_CATEGORIES.has(f.trim()));
  if (anchorIndex === -1) return null;
  // Rejoin with a bare comma (not ", ") — the split fragments already carry
  // whatever whitespace originally followed the comma, so this reconstructs
  // the exact original text rather than doubling it up.
  return {
    nl: fields[0],
    en: fields.slice(1, anchorIndex).join(','),
    category: fields[anchorIndex].trim(),
    note: fields.slice(anchorIndex + 1).join(','),
  };
}

interface RawRow { nl: string; en: string; category: string; note: string }

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
          `'${fixedRows[0].nl}' staat zowel als vaste term (${categories}) als Contextafhankelijk in de CSV — Contextafhankelijk heeft voorrang, de vaste vertaling(en) zijn genegeerd.`,
        );
      }
      if (contextRows.length > 1) {
        warnings.push(`'${contextRows[0].nl}' komt meerdere keren voor als Contextafhankelijk; alleen de eerste rij is gebruikt.`);
      }
    } else if (fixedRows.length > 0) {
      fixed.push(fixedRows[0]);
      const distinctEn = Array.from(new Set(fixedRows.map(r => r.en)));
      if (fixedRows.length > 1 && distinctEn.length > 1) {
        warnings.push(
          `'${fixedRows[0].nl}' komt meerdere keren voor met verschillende vertalingen (${distinctEn.join(' / ')}); de eerste is gebruikt.`,
        );
      }
    }
  }

  return { fixed, context };
}

export function parseGlossaryCsv(text: string): ParsedGlossary {
  const rows = parseCsv(text).filter(r => r.some(f => f.trim().length > 0));
  const warnings: string[] = [];
  if (rows.length === 0) {
    return { fixed: [], context: [], totalRows: 0, repairedRows: 0, droppedRows: 0, warnings };
  }

  const header = rows[0].map(f => f.trim());
  if (header.join(',') !== EXPECTED_HEADER.join(',')) {
    warnings.push(`Onverwachte CSV-header: verwacht "${EXPECTED_HEADER.join(',')}", gevonden "${header.join(',')}".`);
  }

  const dataRows = rows.slice(1);
  let repairedRows = 0;
  let droppedRows = 0;
  const raw: RawRow[] = [];

  for (const fields of dataRows) {
    let rec: { nl: string; en: string; category: string; note: string };

    if (fields.length === 4) {
      rec = { nl: fields[0], en: fields[1], category: fields[2].trim(), note: fields[3] };
    } else if (fields.length > 4) {
      const repaired = repairRow(fields);
      if (!repaired) {
        droppedRows++;
        warnings.push(`Rij overgeslagen (categorie niet herkend): '${fields[0]}'`);
        continue;
      }
      rec = repaired;
      repairedRows++;
    } else if (fields.length === 3) {
      rec = { nl: fields[0], en: fields[1], category: fields[2].trim(), note: '' };
    } else {
      droppedRows++;
      warnings.push(`Rij overgeslagen (te weinig velden): '${fields[0] ?? ''}'`);
      continue;
    }

    if (!KNOWN_CATEGORIES.has(rec.category)) {
      droppedRows++;
      warnings.push(`Rij overgeslagen (onbekende categorie '${rec.category}'): '${rec.nl}'`);
      continue;
    }

    const nl = sanitizeGlossaryField(rec.nl, MAX_NL_LEN);
    const en = sanitizeGlossaryField(rec.en, MAX_EN_LEN);
    const note = sanitizeGlossaryField(rec.note, MAX_NOTE_LEN);
    if (!nl || !en) {
      droppedRows++;
      warnings.push(`Rij overgeslagen (leeg NL/EN veld na sanitatie): '${rec.nl}'`);
      continue;
    }

    // Injection check on the rendered "NL → EN" line — the anchored
    // INJECTION_RE only ever matches the first word, i.e. the Dutch term
    // itself, so a Notitie starting with "Niet ..." can never trip this.
    if (looksLikeInjection(`${nl} → ${en}`)) {
      droppedRows++;
      warnings.push(`Rij overgeslagen (lijkt op prompt-injectie): '${nl}'`);
      continue;
    }

    raw.push({ nl, en, category: rec.category, note });
  }

  const { fixed, context } = resolveDuplicates(raw, warnings);

  return { fixed, context, totalRows: dataRows.length, repairedRows, droppedRows, warnings };
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
      warnings.push(`'${term}' staat in de disambiguatie-tabel maar is niet als Contextafhankelijk gemarkeerd in de CSV.`);
    }
  }
  for (const term of Array.from(csvSet)) {
    if (!docSet.has(term)) {
      warnings.push(`'${term}' is Contextafhankelijk in de CSV maar heeft geen rij in de disambiguatie-tabel.`);
    }
  }
  return warnings;
}
