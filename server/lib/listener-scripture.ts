// Verbatim Bible readings on the phones that read Hindi, Tamil or Chinese (CLAUDE.md "Listener languages").
//
// When the operator's page shows a row that is a verbatim reading (status SCRIPTURE, English text still
// exactly the verse), it sends the row's English reference ("John 3:16-18", always English-numbered — see
// scripture.ts) as a hint next to the line. The hub then shows the verse in the congregation's own Bible
// (data/bible/{hi,ta,zh,zh-tw}-*.json.gz, built by scripts/build-bible-data.ts) instead of paying a model
// to translate the English wording. Nothing else about the line changes: it is still the same four-field
// ListenerLine, and no Dutch is involved anywhere.
//
// Never throws: an unknown book, a malformed reference or a Bible that isn't built just means "no
// substitution" and the line is translated like any other.

import { bookNumberByEnglishName } from './bible-books';
import { getListenerMismatchedChapters, getListenerVerseRange, type ListenerBibleLang } from './bible-store';
import { MAX_REFERENCE_LENGTH } from './listener-lines';

export interface ParsedReference {
  bookNumber: number;
  chapter: number;
  verseStart: number;
  verseEnd: number;
}

const REFERENCE_RE = /^(.+?) (\d{1,3}):(\d{1,3})(?:-(\d{1,3}))?$/;
/** "John 3:16" / "1 Corinthians 13:4-7" -> numbers, or null when it is not a reference the Bible table knows. */
export function parseReference(reference: string): ParsedReference | null {
  if (reference.length > MAX_REFERENCE_LENGTH) return null;
  const m = REFERENCE_RE.exec(reference.trim());
  if (!m) return null;
  const bookNumber = bookNumberByEnglishName(m[1]);
  if (!bookNumber) return null;
  const chapter = Number(m[2]);
  const verseStart = Number(m[3]);
  const verseEnd = m[4] ? Number(m[4]) : verseStart;
  if (chapter < 1 || verseStart < 1 || verseEnd < verseStart || verseEnd - verseStart > 40) return null;
  return { bookNumber, chapter, verseStart, verseEnd };
}

/** The verses of `reference` in `lang`'s Bible, or undefined when that is not available (the line is then translated normally). */
export function listenerScriptureText(lang: ListenerBibleLang, reference: string): string | undefined {
  const ref = parseReference(reference);
  if (!ref) return undefined;
  // A chapter this Bible numbers differently from English: the verse numbers may not be the same verses.
  if (getListenerMismatchedChapters(lang).has(`${ref.bookNumber}:${ref.chapter}`)) return undefined;
  const text = getListenerVerseRange(lang, ref.bookNumber, ref.chapter, ref.verseStart, ref.verseEnd);
  return text || undefined;
}
