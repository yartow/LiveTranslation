// Lightweight, non-blocking check: did a fixed glossary term that appears in
// the Dutch source survive into the English translation? This is advisory
// only — no auto-correction, just a signal the human translator should
// glance at the row. See CLAUDE.md / the plan doc for the rationale.
//
// Deliberately excludes: Contextafhankelijk terms (no single "expected"
// answer — that's the whole point of that category), glossary entries whose
// Engels column lists alternatives via " / " (same reason), and very short
// terms (<5 chars) — words like "Job", "Gij", "Eer", "Amos" would otherwise
// fire on nearly every sentence.

import type { GlossaryRow } from './glossary-parse';

export interface GlossaryWarning {
  term: string;
  expected: string;
}

export interface GlossaryCheckIndex {
  pattern: RegExp | null;
  expectedByTerm: Map<string, string>; // lowercased nl -> expected en
  displayByTerm: Map<string, string>; // lowercased nl -> original-case nl
}

const MIN_TERM_LEN = 5;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildCheckIndex(fixed: GlossaryRow[], contextTerms: ReadonlySet<string>): GlossaryCheckIndex {
  const expectedByTerm = new Map<string, string>();
  const displayByTerm = new Map<string, string>();

  for (const row of fixed) {
    const key = row.nl.toLowerCase();
    if (contextTerms.has(key)) continue; // defensive — should already be excluded upstream
    if (row.en.includes(' / ')) continue; // no single expected answer
    if (row.nl.length < MIN_TERM_LEN) continue;
    const expected = (row.en.includes('(') ? row.en.slice(0, row.en.indexOf('(')) : row.en).trim();
    if (!expected) continue;
    expectedByTerm.set(key, expected);
    displayByTerm.set(key, row.nl);
  }

  if (expectedByTerm.size === 0) {
    return { pattern: null, expectedByTerm, displayByTerm };
  }

  // Longest-first so a multi-word term matches before a shorter term it contains.
  const terms = Array.from(expectedByTerm.keys()).sort((a, b) => b.length - a.length).map(escapeRegExp);
  // No `u` flag / \p{} property escapes (see glossary-file.ts for why) — an
  // explicit Latin-1 Supplement + Latin Extended-A range covers Dutch
  // diacritics without needing Unicode property escapes.
  const WORD_CHAR = 'A-Za-z0-9À-ÿĀ-ɏ_';
  const pattern = new RegExp(`(?<![${WORD_CHAR}])(${terms.join('|')})(?![${WORD_CHAR}])`, 'gi');

  return { pattern, expectedByTerm, displayByTerm };
}

export function checkGlossaryAdherence(
  source: string,
  translation: string,
  index: GlossaryCheckIndex,
  max = 3,
): GlossaryWarning[] {
  if (!index.pattern) return [];

  const normalizedSource = source.normalize('NFC');
  const normalizedTranslation = translation.normalize('NFC').toLowerCase();
  const warnings: GlossaryWarning[] = [];
  const seen = new Set<string>();

  index.pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = index.pattern.exec(normalizedSource)) !== null) {
    const key = m[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const expected = index.expectedByTerm.get(key);
    if (!expected) continue;
    if (normalizedTranslation.includes(expected.toLowerCase())) continue;

    warnings.push({ term: index.displayByTerm.get(key) ?? m[1], expected });
    if (warnings.length >= max) break;
  }

  return warnings;
}
