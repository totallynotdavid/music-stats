import { normalizeText } from "../normalize";
import { fetchJson } from "./http";

export type Service = "deezer" | "apple";

// A candidate carries the ids a round needs to resolve a fresh preview: the
// preview URL itself is signed and expires, so it is never stored.
export interface Candidate {
  title: string;
  artist: string;
  cover: string | null;
  link: string | null;
  isrc?: string;
  deezerId?: number;
  appleId?: string;
  appleCountry?: string;
}

export interface Preview {
  url: string;
  service: Service;
  link: string | null;
  cover: string | null;
}

interface DeezerTrack {
  id?: number;
  title?: string;
  preview?: string;
  link?: string;
  artist?: { name?: string };
  album?: { cover_medium?: string };
}

function deezerCandidate(track: DeezerTrack): Candidate | null {
  if (
    typeof track.id !== "number" ||
    typeof track.title !== "string" ||
    typeof track.artist?.name !== "string"
  )
    return null;
  return {
    title: track.title,
    artist: track.artist.name,
    cover: track.album?.cover_medium ?? null,
    link: track.link ?? null,
    deezerId: track.id,
  };
}

async function deezerList(url: string): Promise<Candidate[]> {
  const body = (await fetchJson(url)) as { data?: DeezerTrack[] };
  return (body.data ?? [])
    .map(deezerCandidate)
    .filter((track): track is Candidate => track !== null);
}

export function deezerChart(genreId: string) {
  return deezerList(`https://api.deezer.com/chart/${genreId}/tracks?limit=50`);
}

export function deezerPlaylist(playlistId: string) {
  return deezerList(
    `https://api.deezer.com/playlist/${playlistId}/tracks?limit=100`,
  );
}

interface AppleFeedEntry {
  id?: string;
  name?: string;
  artistName?: string;
  url?: string;
  artworkUrl100?: string;
}

export async function appleChart(country: string): Promise<Candidate[]> {
  const body = (await fetchJson(
    `https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/50/songs.json`,
  )) as { feed?: { results?: AppleFeedEntry[] } };
  return (body.feed?.results ?? [])
    .filter(
      (
        entry,
      ): entry is Required<Pick<AppleFeedEntry, "id" | "name" | "artistName">> &
        AppleFeedEntry =>
        typeof entry.id === "string" &&
        typeof entry.name === "string" &&
        typeof entry.artistName === "string",
    )
    .map((entry) => ({
      title: entry.name!,
      artist: entry.artistName!,
      cover: entry.artworkUrl100 ?? null,
      link: entry.url ?? null,
      appleId: entry.id,
      appleCountry: country,
    }));
}

interface AppleTrack {
  trackName?: string;
  artistName?: string;
  previewUrl?: string;
  trackViewUrl?: string;
  artworkUrl100?: string;
}

export async function deezerPreview(deezerId: number): Promise<Preview | null> {
  const track = (await fetchJson(
    `https://api.deezer.com/track/${deezerId}`,
  )) as DeezerTrack & { error?: { code?: number } };
  return typeof track.preview === "string" && track.preview
    ? {
        url: track.preview,
        service: "deezer",
        link: track.link ?? null,
        cover: track.album?.cover_medium ?? null,
      }
    : null;
}

export async function applePreview(
  appleId: string,
  country: string,
): Promise<Preview | null> {
  const body = (await fetchJson(
    `https://itunes.apple.com/lookup?id=${appleId}&entity=song&country=${country}`,
  )) as { results?: AppleTrack[] };
  const track = body.results?.[0];
  return typeof track?.previewUrl === "string"
    ? {
        url: track.previewUrl,
        service: "apple",
        link: track.trackViewUrl ?? null,
        cover: track.artworkUrl100 ?? null,
      }
    : null;
}

function artistMatches(found: string | undefined, wanted: string) {
  return (
    typeof found === "string" && normalizeText(found) === normalizeText(wanted)
  );
}

// Free-text search returns the wrong track often enough that a hit counts only
// when its artist matches the wanted one.
export async function deezerSearchPreview(
  artist: string,
  title: string,
): Promise<Preview | null> {
  const body = (await fetchJson(
    `https://api.deezer.com/search?q=${encodeURIComponent(`${artist} ${title}`)}&limit=5`,
  )) as { data?: DeezerTrack[] };
  const hit = (body.data ?? []).find(
    (track) =>
      typeof track.preview === "string" &&
      track.preview &&
      artistMatches(track.artist?.name, artist),
  );
  return hit
    ? {
        url: hit.preview!,
        service: "deezer",
        link: hit.link ?? null,
        cover: hit.album?.cover_medium ?? null,
      }
    : null;
}

// Deezer's ISRC lookup answers {"error":{"code":800}} for an unknown code.
export async function deezerIsrcPreview(
  isrc: string,
  artist: string,
): Promise<Preview | null> {
  const track = (await fetchJson(
    `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`,
  )) as DeezerTrack & { error?: { code?: number } };
  return typeof track.preview === "string" &&
    track.preview &&
    artistMatches(track.artist?.name, artist)
    ? {
        url: track.preview,
        service: "deezer",
        link: track.link ?? null,
        cover: track.album?.cover_medium ?? null,
      }
    : null;
}

export async function appleSearchPreview(
  artist: string,
  title: string,
): Promise<Preview | null> {
  const body = (await fetchJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${title}`)}&entity=song&country=us&limit=5`,
  )) as { results?: AppleTrack[] };
  const hit = (body.results ?? []).find(
    (track) =>
      typeof track.previewUrl === "string" &&
      artistMatches(track.artistName, artist),
  );
  return hit
    ? {
        url: hit.previewUrl!,
        service: "apple",
        link: hit.trackViewUrl ?? null,
        cover: hit.artworkUrl100 ?? null,
      }
    : null;
}
