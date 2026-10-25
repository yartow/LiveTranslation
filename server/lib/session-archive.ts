// Append-only extras for a `dev:record` session folder (ASR_DEBUG_DIR, see chunk-transcription.ts): the
// translation log, the operator's edit log and browser errors. Every writer is a no-op when the archive is
// off or no recording has opened a folder yet, and never throws — debugging aids must not break a service.
//
// Nothing here stores API keys: callers pass the content of prompts/segments only.

import { appendFile } from 'fs/promises';
import { join } from 'path';
import { archiveEnabled, getCurrentArchiveDir } from './chunk-transcription';
import type { TranslationLogEntry } from './sermon-translate';

/** Appends `text` (already newline-terminated lines) to `<current session folder>/<fileName>`. */
export function appendToArchive(fileName: string, text: string): boolean {
  if (!archiveEnabled()) return false;
  const dir = getCurrentArchiveDir();
  if (!dir || !text) return false;
  appendFile(join(dir, fileName), text).catch(() => {});
  return true;
}

export function logTranslation(entry: TranslationLogEntry): void {
  appendToArchive('translations.jsonl', JSON.stringify(entry) + '\n');
}
