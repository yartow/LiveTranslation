// "Add lyrics" (CLAUDE.md "Song lyrics"): a song from the operator's AllSongs app becomes rows of the
// sermon grid — a title row and one row per sung section. Pure, so it is unit-tested; fetching is in
// useLyricsInsert.ts (via the server's GET /api/lyrics, server/lib/allsongs.ts).

import type { LyricsRow } from './segment-store';

/** Mirrors server/lib/allsongs.ts's SongLyrics (client and server share no code). */
export interface SongLyrics {
  id: string;
  song_id: string | null;
  title: string | null;
  language: string | null;
  sections: Array<{ id: string; type: string; label: string; text: string }>;
  alternates: Array<{ id: string; language: string | null; title: string | null }>;
}

export type LyricsCell = 'source' | 'target';

export interface LyricsPlan {
  rows: LyricsRow[];
  /** How the English was obtained, for the operator's toast. */
  english: 'as-is' | 'from-allsongs' | 'translate';
  /** Something the operator should check (verses that don't line up, a link pasted on the other side). */
  warnings: string[];
}

/**
 * The song's language decides what happens; the side it was pasted on only matters when AllSongs
 * doesn't know the language (then the right side means "this is English").
 *  - English: English on the right, Dutch side blank (a blank source is never translated).
 *  - Not English, with AllSongs' English version: paired by position (Dutch left, English right).
 *  - Not English, no English version: Dutch on the left, translated like any row.
 */
export function lyricsRows(song: SongLyrics, english: SongLyrics | undefined, pastedIn: LyricsCell): LyricsPlan {
  const warnings: string[] = [];
  const isEnglish = song.language === 'en' || (!song.language && pastedIn === 'target');
  if (song.language === 'en' && pastedIn === 'source') warnings.push('This is an English song, so it is shown as is (not translated).');
  if (song.language && song.language !== 'en' && pastedIn === 'target') {
    warnings.push(english ? 'This is not an English song; its English version from AllSongs is used.' : 'This is not an English song, so it is translated.');
  }
  const title = (song.title ?? '').trim();
  const info = (part: 'title' | 'verse') => ({ part, songId: song.id, ...(title ? { title } : {}) });
  const rows: LyricsRow[] = [];

  if (isEnglish) {
    if (title) rows.push({ sourceText: '', translatedText: title, lyrics: info('title') });
    for (const s of song.sections) rows.push({ sourceText: '', translatedText: s.text, lyrics: info('verse') });
    return { rows, english: 'as-is', warnings };
  }

  const enSections = english?.sections ?? [];
  if (english) {
    const sameShape = enSections.length === song.sections.length
      && enSections.every((s, i) => s.type === song.sections[i].type);
    if (!sameShape) {
      warnings.push(`The Dutch (${song.sections.length} parts) and English (${enSections.length} parts) versions don't line up exactly — check the rows.`);
    }
  }
  const enTitle = (english?.title ?? '').trim();
  if (title || enTitle) {
    rows.push({ sourceText: title, ...(enTitle ? { translatedText: enTitle } : {}), lyrics: info('title') });
  }
  const n = Math.max(song.sections.length, enSections.length);
  for (let i = 0; i < n; i++) {
    const nl = song.sections[i]?.text ?? '';
    const en = enSections[i]?.text;
    rows.push({ sourceText: nl, ...(en ? { translatedText: en } : {}), lyrics: info('verse') });
  }
  return { rows, english: english ? 'from-allsongs' : 'translate', warnings };
}

/** What a pending lyrics row accepts on paste: a single link or a bare AllSongs display code. The server checks the host. */
export function looksLikeSongLink(text: string): boolean {
  return /^\s*(?:https?:\/\/\S+|\d{1,7}(?:-\d{1,3})?)\s*$/.test(text);
}
