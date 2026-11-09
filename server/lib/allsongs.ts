// Song lyrics from the operator's AllSongs app (https://allsongs.pages.dev, repo AllSongs), for
// sermon mode's "Add lyrics" (client/src/hooks/useLyricsInsert.ts). AllSongs serves one song at
// GET /api/lyrics?id=<record id | display code> (AllSongs' functions/_lib/lyrics.ts).
//
// The operator pastes a song link; only the song id is taken from it. The host is always
// ALLSONGS_URL, never one from the pasted text, so this can't be turned into a fetch of an
// arbitrary URL.

export const DEFAULT_ALLSONGS_URL = 'https://allsongs.pages.dev';
const TIMEOUT_MS = 8000;
const MAX_ID = 500;

export function allSongsBase(): string {
  return (process.env.ALLSONGS_URL || DEFAULT_ALLSONGS_URL).replace(/\/+$/, '');
}

export interface SongSection { id: string; type: string; label: string; text: string }
export interface SongLyrics {
  id: string;
  song_id: string | null;
  title: string | null;
  language: string | null;
  sections: SongSection[];
  alternates: Array<{ id: string; language: string | null; title: string | null }>;
}

const DISPLAY_CODE = /^\d{1,7}(?:-\d{1,3})?$/;

/**
 * The song id in what the operator pasted, or null when it isn't an AllSongs link:
 *   <base>/#<record id>            (a song page, as copied from the address bar)
 *   <base>/api/lyrics?id=<id>      (the API link)
 *   11961-1                        (a bare display code)
 * Only links to `base`'s own host are accepted.
 */
export function parseAllSongsLink(input: string, base: string = allSongsBase()): string | null {
  const text = input.trim();
  if (DISPLAY_CODE.test(text)) return text;
  let url: URL, baseUrl: URL;
  try {
    url = new URL(text);
    baseUrl = new URL(base);
  } catch {
    return null;
  }
  if (url.host !== baseUrl.host || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  let id: string | null = null;
  if (url.pathname.replace(/\/+$/, '') === '/api/lyrics') id = url.searchParams.get('id');
  else if (url.hash.length > 1) {
    try { id = decodeURIComponent(url.hash.slice(1)); } catch { return null; }
  }
  id = id?.trim() ?? null;
  // A Browse-tab hash (`#q=...`) is not a song.
  if (!id || id.length > MAX_ID || id.startsWith('q=')) return null;
  return id;
}

export class AllSongsError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 502) { super(message); }
}

function isSong(v: any): v is SongLyrics {
  return v && typeof v.id === 'string' && Array.isArray(v.sections)
    && v.sections.every((s: any) => s && typeof s.text === 'string' && typeof s.id === 'string')
    && Array.isArray(v.alternates);
}

async function getSong(id: string, base: string, fetchImpl: typeof fetch): Promise<SongLyrics> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/lyrics?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new AllSongsError(`AllSongs could not be reached (${err instanceof Error ? err.message : 'network error'})`, 502);
  }
  if (res.status === 404) throw new AllSongsError('AllSongs has no song with that link', 404);
  const body = await res.json().catch(() => null);
  if (!res.ok || !isSong(body)) throw new AllSongsError(`AllSongs answered HTTP ${res.status}`, 502);
  return {
    id: body.id, song_id: body.song_id ?? null, title: body.title ?? null, language: body.language ?? null,
    sections: body.sections.map(s => ({ id: s.id, type: String(s.type ?? 'other'), label: String(s.label ?? ''), text: s.text })),
    alternates: body.alternates.filter(a => a && typeof a.id === 'string')
      .map(a => ({ id: a.id, language: a.language ?? null, title: a.title ?? null })),
  };
}

/** The song, and — when it isn't English — AllSongs' English version of it, if there is one. */
export async function fetchSongLyrics(
  link: string,
  opts: { base?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ song: SongLyrics; english?: SongLyrics }> {
  const base = opts.base ?? allSongsBase();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const id = parseAllSongsLink(link, base);
  if (!id) throw new AllSongsError(`Not an AllSongs song link (expected ${base}/#… )`, 400);
  const song = await getSong(id, base, fetchImpl);
  if (song.language === 'en') return { song };
  const twin = song.alternates.find(a => a.language === 'en');
  if (!twin) return { song };
  // The English version is a bonus: if it can't be fetched, the song is translated instead.
  const english = await getSong(twin.id, base, fetchImpl).catch(() => undefined);
  return english ? { song, english } : { song };
}
