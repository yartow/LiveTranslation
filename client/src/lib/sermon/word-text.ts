// Word helpers shared by confidence-store.ts (the "check" chips) and edit-suggestions.ts (glossary suggestions),
// so both agree on what counts as the same word.

/** Lowercase letters and digits only, accents folded away: the form two spellings are compared in. */
export const norm = (w: string): string => w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Latin letters (incl. accents, À-ɏ) and digits count as part of a word; everything else at its edges is punctuation.
export const stripPunct = (w: string): string => w.replace(/^[^A-Za-z0-9À-ɏ]+|[^A-Za-z0-9À-ɏ]+$/g, '');

export const isWordChar = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9À-ɏ]/.test(ch);
