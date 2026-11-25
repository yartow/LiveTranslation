import { describe, it, expect } from 'vitest';
import { parseAllSongsLink, fetchSongLyrics, unescapeLineBreaks, AllSongsError, type SongLyrics } from '../../server/lib/allsongs.js';

const BASE = 'https://allsongs.pages.dev';
const NL_ID = 'OpenSong:OpenSong/Songs/Database/NL/O hoofd vol bloed en wonden';
const EN_ID = 'OpenSong:OpenSong/Songs/Database/EN/O sacred Head, now wounded';

describe('parseAllSongsLink', () => {
  it('takes the song id from a song page link, an API link or a bare display code', () => {
    expect(parseAllSongsLink(`${BASE}/#${encodeURIComponent(NL_ID)}`, BASE)).toBe(NL_ID);
    expect(parseAllSongsLink(` ${BASE}/api/lyrics?id=${encodeURIComponent(NL_ID)} `, BASE)).toBe(NL_ID);
    expect(parseAllSongsLink('15017-1', BASE)).toBe('15017-1');
    expect(parseAllSongsLink(`${BASE}/#db:1234`, BASE)).toBe('db:1234');
  });

  it('refuses other hosts, Browse-tab links and pages without a song', () => {
    expect(parseAllSongsLink(`https://evil.example/#${encodeURIComponent(NL_ID)}`, BASE)).toBeNull();
    expect(parseAllSongsLink(`https://allsongs.pages.dev.evil.example/#x`, BASE)).toBeNull();
    expect(parseAllSongsLink(`${BASE}/#q=title%3Ajezus`, BASE)).toBeNull();
    expect(parseAllSongsLink(`${BASE}/`, BASE)).toBeNull();
    expect(parseAllSongsLink('Psalm 23', BASE)).toBeNull();
    expect(parseAllSongsLink(`${BASE}/#%E0%A4%A`, BASE)).toBeNull(); // malformed escape
  });
});

describe('fetchSongLyrics', () => {
  const song = (id: string, language: string | null, alternates: SongLyrics['alternates'] = []): SongLyrics => ({
    id, song_id: null, title: id.split('/').pop()!, language, alternates,
    sections: [{ id: 'v1', type: 'verse', label: 'Verse 1', text: `${language} verse` }],
  });
  const fakeFetch = (songs: Record<string, SongLyrics | 'down'>) => (async (url: string) => {
    const id = new URL(url).searchParams.get('id')!;
    const s = songs[id];
    if (s === 'down') throw new Error('ECONNREFUSED');
    if (!s) return new Response(JSON.stringify({ ok: false }), { status: 404 });
    return new Response(JSON.stringify({ ok: true, ...s }), { status: 200 });
  }) as unknown as typeof fetch;

  it('returns a Dutch song with its English version from the same work', async () => {
    const r = await fetchSongLyrics(`${BASE}/#${encodeURIComponent(NL_ID)}`, {
      base: BASE,
      fetchImpl: fakeFetch({ [NL_ID]: song(NL_ID, 'nl', [{ id: EN_ID, language: 'en', title: 'x' }]), [EN_ID]: song(EN_ID, 'en') }),
    });
    expect(r.song.id).toBe(NL_ID);
    expect(r.english?.sections[0].text).toBe('en verse');
  });

  it('an English song needs no twin, and a twin that fails to load is simply left out', async () => {
    expect((await fetchSongLyrics(EN_ID.replace(/.*/, `${BASE}/#${encodeURIComponent(EN_ID)}`), { base: BASE, fetchImpl: fakeFetch({ [EN_ID]: song(EN_ID, 'en') }) })).english).toBeUndefined();
    const r = await fetchSongLyrics(`${BASE}/#${encodeURIComponent(NL_ID)}`, {
      base: BASE,
      fetchImpl: fakeFetch({ [NL_ID]: song(NL_ID, 'nl', [{ id: EN_ID, language: 'en', title: 'x' }]), [EN_ID]: 'down' }),
    });
    expect(r.english).toBeUndefined();
  });

  it('reports a bad link, an unknown song and an unreachable AllSongs with their own status', async () => {
    const fail = (link: string, songs: Record<string, SongLyrics | 'down'>) =>
      fetchSongLyrics(link, { base: BASE, fetchImpl: fakeFetch(songs) }).then(() => null, (e: AllSongsError) => e.status);
    expect(await fail('https://evil.example/#x', {})).toBe(400);
    expect(await fail(`${BASE}/#nope`, {})).toBe(404);
    expect(await fail(`${BASE}/#${encodeURIComponent(NL_ID)}`, { [NL_ID]: 'down' })).toBe(502);
  });
});

describe('literal \\n in a lyric', () => {
  it('turns backslash+n and backslash+r+backslash+n into real line breaks, and nothing else', () => {
    expect(unescapeLineBreaks('line one\\nline two')).toBe('line one\nline two');
    expect(unescapeLineBreaks('a\\r\\nb')).toBe('a\nb');
    expect(unescapeLineBreaks('real\nbreak stays')).toBe('real\nbreak stays');
    expect(unescapeLineBreaks('C:\\path \\ and a \\t tab')).toBe('C:\\path \\ and a \\t tab');
  });

  it('is applied to the title and every section of the song and its English version', async () => {
    const body = (id: string, language: string, alternates: unknown[] = []) => ({
      ok: true, id, song_id: null, title: 'T\\nitle', language, alternates,
      sections: [{ id: 'v1', type: 'verse', label: 'Verse 1', text: 'one\\ntwo\\nthree' }],
    });
    const fetchImpl = (async (url: string) => {
      const id = new URL(url).searchParams.get('id')!;
      return new Response(JSON.stringify(id === '1-1' ? body('1-1', 'nl', [{ id: '1-2', language: 'en', title: 'x' }]) : body('1-2', 'en')), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchSongLyrics('1-1', { base: BASE, fetchImpl });
    expect(r.song.sections[0].text).toBe('one\ntwo\nthree');
    expect(r.song.title).toBe('T\nitle');
    expect(r.english?.sections[0].text).toBe('one\ntwo\nthree');
  });
});
