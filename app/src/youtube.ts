/** YouTube playlist IDs. Video IDs are parsed by the worker (see docs/JOBS.md). */

const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);

/**
 * Accepts a playlist URL (any link with a `list=` parameter on youtube.com) or a bare
 * playlist ID. Returns null when neither is valid.
 */
export function parsePlaylistId(input: string): string | null {
  const value = input.trim();
  if (PLAYLIST_ID_RE.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const list = url.searchParams.get('list');
  return list !== null && PLAYLIST_ID_RE.test(list) ? list : null;
}
