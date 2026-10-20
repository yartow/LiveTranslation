// "Add to glossary" (sermon mode): validates one operator-supplied term and
// appends it to the selected glossary CSV and/or the ASR corrections file.
// See CLAUDE.md "File-based glossary trust boundary" — this is the only code
// that writes into GLOSSARY_DIR, and it is append-only.

import { appendCsvRow, readGlossaryFile, isSafeGlossaryName } from './glossary-file';
import { KNOWN_CATEGORIES, parseGlossaryCsv } from './glossary-parse';
import { sanitizeGlossaryField, looksLikeInjection } from './prompt-safety';
import {
  CORRECTIONS_FILE, CORRECTIONS_HEADER, getAsrCorrectionRules, normalizePhrase, phraseWords, resetAsrCorrectionsCache,
} from './asr-corrections';

// Caps mirror glossary-parse.ts (a longer value would be truncated on load).
const MAX_NL_LEN = 80;
const MAX_EN_LEN = 120;
const GLOSSARY_HEADER = ['Nederlands', 'Engels', 'Categorie', 'Notitie'];
/** A shorter "heard" phrase would rewrite ordinary Dutch ("de", "en") everywhere. */
const MIN_HEARD_LETTERS = 3;

export interface AddGlossaryInput {
  csv: string;
  heard?: string;
  dutch: string;
  english?: string;
  category?: string;
  /** Add the glossary row even though the Dutch term is already in the CSV. */
  force?: boolean;
}

export type AddGlossaryResult =
  | { ok: true; glossaryRowAdded: boolean; correctionAdded: boolean }
  | { ok: false; status: 400 | 409 | 500; error: string; existingEnglish?: string };

function clean(raw: unknown, maxLen: number): string {
  return typeof raw === 'string' ? sanitizeGlossaryField(raw, maxLen) : '';
}

export function addToGlossary(input: AddGlossaryInput): AddGlossaryResult {
  if (!isSafeGlossaryName(input.csv, 'csv') || input.csv === CORRECTIONS_FILE) {
    return { ok: false, status: 400, error: 'Invalid glossary file' };
  }
  const dutch = clean(input.dutch, MAX_NL_LEN);
  const english = clean(input.english, MAX_EN_LEN);
  const heard = clean(input.heard, MAX_NL_LEN);
  const category = input.category && KNOWN_CATEGORIES.has(input.category) ? input.category : 'Theologisch';

  if (!dutch) return { ok: false, status: 400, error: 'The Dutch word is required' };
  // A row the loader would drop as an injection attempt must not be silently written either.
  if (looksLikeInjection(`${dutch} → ${english}`) || looksLikeInjection(dutch)) {
    return { ok: false, status: 400, error: 'That term looks like an instruction and cannot be added' };
  }

  const wantGlossaryRow = english.length > 0;
  const wantCorrection = heard.length > 0
    && normalizePhrase(heard) !== normalizePhrase(dutch)
    && phraseWords(heard).join('').length >= MIN_HEARD_LETTERS;
  if (heard && !wantCorrection && normalizePhrase(heard) !== normalizePhrase(dutch)) {
    return { ok: false, status: 400, error: `"Heard as" must have at least ${MIN_HEARD_LETTERS} letters` };
  }
  if (!wantGlossaryRow && !wantCorrection) {
    return { ok: false, status: 400, error: 'Nothing to add: give an English translation, or a different "heard as" phrase' };
  }

  try {
    if (wantGlossaryRow && !input.force) {
      let existing: { nl: string; en: string } | undefined;
      try {
        const parsed = parseGlossaryCsv(readGlossaryFile(input.csv, 'csv').text);
        const key = normalizePhrase(dutch);
        existing = [...parsed.fixed, ...parsed.context].find(r => normalizePhrase(r.nl) === key);
      } catch {
        // Missing file: it is created below.
      }
      if (existing) {
        return { ok: false, status: 409, error: `"${existing.nl}" is already in the glossary`, existingEnglish: existing.en };
      }
    }

    let glossaryRowAdded = false;
    let correctionAdded = false;
    if (wantGlossaryRow) {
      appendCsvRow(input.csv, [dutch, english, category, ''], GLOSSARY_HEADER);
      glossaryRowAdded = true;
    }
    if (wantCorrection) {
      const key = normalizePhrase(heard);
      const already = getAsrCorrectionRules().some(r => normalizePhrase(r.heard) === key && r.correct === dutch);
      if (!already) {
        appendCsvRow(CORRECTIONS_FILE, [heard, dutch], CORRECTIONS_HEADER);
        correctionAdded = true;
      }
    }
    resetAsrCorrectionsCache();
    return { ok: true, glossaryRowAdded, correctionAdded };
  } catch (err) {
    console.error('Add to glossary failed:', err);
    return { ok: false, status: 500, error: err instanceof Error ? err.message : 'Could not write the glossary file' };
  }
}
