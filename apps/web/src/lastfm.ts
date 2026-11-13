import * as v from "valibot";
import { storeListens } from "./matching";
import { pullPages, type FetchedPage } from "./pull";
import type { Env, SourceRow } from "./types";

const TrackSchema = v.object({
  name: v.string(),
  mbid: v.optional(v.string()),
  artist: v.object({ "#text": v.string() }),
  date: v.optional(v.object({ uts: v.string() })),
});

export const ResponseSchema = v.object({
  recenttracks: v.object({ track: v.array(TrackSchema) }),
});

const ErrorSchema = v.object({
  error: v.number(),
  message: v.string(),
});

export type LastFmTrack = v.InferOutput<typeof TrackSchema>;
type DatedTrack = LastFmTrack & { date: { uts: string } };

export interface FetchResult {
  status: number;
  body?: unknown;
  resetIn?: number;
}

export type LastFmFetcher = (url: string) => Promise<FetchResult>;

class RateLimited extends Error {
  constructor(readonly resetIn: number) {
    super("Last.fm returned 429");
  }
}

export const maxTracksPerPull = 200;
export const maxLastFmPlays = 2_000_000;
const pageDelayMs = 200;

async function fetchPage(
  baseUrl: string,
  params: URLSearchParams,
  fetcher: LastFmFetcher,
) {
  const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${params}`;
  const result = await fetcher(url);
  if (result.status === 429) throw new RateLimited(result.resetIn ?? 60);
  if (result.status !== 200)
    throw new Error(`Last.fm returned ${result.status}`);
  const apiError = v.safeParse(ErrorSchema, result.body);
  if (apiError.success) {
    if (apiError.output.error === 17)
      throw new Error("Last.fm user hides recent listening");
    throw new Error(
      `Last.fm error ${apiError.output.error}: ${apiError.output.message}`,
    );
  }
  const parsed = v.safeParse(ResponseSchema, result.body);
  if (!parsed.success) throw new Error("Last.fm returned an invalid response");
  return parsed.output.recenttracks.track;
}

function playedTracks(tracks: LastFmTrack[]) {
  return tracks.filter(
    (track): track is DatedTrack => track.date !== undefined,
  );
}

export function trackInputs(
  tracks: DatedTrack[],
  userId: number,
  sourceId: number,
) {
  return tracks.map((track) => ({
    kind: "lastfm",
    sourceKey: `${track.artist["#text"]}\t${track.name}`,
    artist: track.artist["#text"],
    title: track.name,
    mbid: track.mbid || undefined,
    listenedAt: Number(track.date.uts),
    userId,
    sourceId,
  }));
}

export async function storeTracksPage(
  db: D1Database,
  source: SourceRow,
  tracks: LastFmTrack[],
) {
  return storeListens(
    db,
    trackInputs(playedTracks(tracks), source.user_id, source.id),
    "lastfm",
  );
}

export const lastFmFetcher: LastFmFetcher = async (url) => {
  const response = await fetch(url);
  const retryAfter = response.headers.get("retry-after");
  const resetIn =
    retryAfter === null
      ? undefined
      : Number.isFinite(Number(retryAfter))
        ? Number(retryAfter)
        : undefined;
  return {
    status: response.status,
    body:
      response.status === 429
        ? undefined
        : await response.json().catch(() => undefined),
    resetIn,
  };
};

async function lastFmPlayTotal(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(play_count), 0) AS total FROM sources WHERE kind = 'lastfm'",
    )
    .bind()
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function pullLastFm(
  env: Env,
  source: SourceRow,
  fetcher: LastFmFetcher = lastFmFetcher,
  now = Math.floor(Date.now() / 1000),
  waitBetweenPages = pageDelayMs,
) {
  if (!source.account) throw new Error("Last.fm source has no account");
  const apiKey = env.LASTFM_API_KEY;
  if (!apiKey) throw new Error("LASTFM_API_KEY is not set");
  const baseUrl = env.LASTFM_BASE_URL ?? "https://ws.audioscrobbler.com/2.0/";
  const account = source.account;
  const call = async (
    params: URLSearchParams,
    limit: number,
  ): Promise<FetchedPage<DatedTrack>> => {
    params.set("method", "user.getrecenttracks");
    params.set("user", account);
    params.set("api_key", apiKey);
    params.set("format", "json");
    params.set("limit", String(limit));
    try {
      const raw = (await fetchPage(baseUrl, params, fetcher)).slice(0, limit);
      return { rawCount: raw.length, plays: playedTracks(raw) };
    } catch (error) {
      if (error instanceof RateLimited)
        return { rawCount: 0, plays: null, wait: error.resetIn };
      throw error;
    }
  };
  return pullPages(
    env,
    source,
    {
      pageSize: maxTracksPerPull,
      current: (cursor, limit) => {
        const params = new URLSearchParams();
        if (cursor !== null) params.set("from", String(cursor + 1));
        return call(params, limit);
      },
      walk: (bound, limit) =>
        call(new URLSearchParams({ to: String(bound) }), limit),
      at: (track) => Number(track.date.uts),
      store: (tracks) =>
        storeListens(
          env.DB,
          trackInputs(tracks, source.user_id, source.id),
          "lastfm",
        ),
      walkCapped: async () => (await lastFmPlayTotal(env.DB)) >= maxLastFmPlays,
      waitBetweenPages,
    },
    now,
  );
}
