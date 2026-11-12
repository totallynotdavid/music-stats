import * as v from "valibot";
import { storeListens } from "./matching";
import { pullPages, type FetchedPage } from "./pull";
import type { Env, SourceRow } from "./types";

const ListenSchema = v.object({
  listened_at: v.number(),
  track_metadata: v.object({
    artist_name: v.string(),
    track_name: v.string(),
    additional_info: v.optional(
      v.object({
        recording_mbid: v.optional(v.string()),
        isrc: v.optional(v.string()),
      }),
    ),
  }),
});

export const ResponseSchema = v.object({
  payload: v.object({ listens: v.array(ListenSchema) }),
});

export type Listen = v.InferOutput<typeof ListenSchema>;

export interface FetchResult {
  status: number;
  body?: unknown;
  remaining?: number;
  resetIn?: number;
}

export type ListenFetcher = (url: string) => Promise<FetchResult>;

class RateLimited extends Error {
  constructor(readonly resetIn: number) {
    super("ListenBrainz returned 429");
  }
}

function listenKey(listen: Listen) {
  const info = listen.track_metadata.additional_info;
  return (
    info?.recording_mbid ??
    `${listen.track_metadata.artist_name}\t${listen.track_metadata.track_name}`
  );
}

async function fetchPage(
  baseUrl: string,
  username: string,
  params: URLSearchParams,
  fetcher: ListenFetcher,
) {
  const url = `${baseUrl.replace(/\/$/u, "")}/1/user/${encodeURIComponent(username)}/listens?${params}`;
  const result = await fetcher(url);
  if (result.status === 429) throw new RateLimited(result.resetIn ?? 60);
  if (result.status !== 200)
    throw new Error(`ListenBrainz returned ${result.status}`);
  const parsed = v.safeParse(ResponseSchema, result.body);
  if (!parsed.success)
    throw new Error("ListenBrainz returned an invalid response");
  return {
    listens: parsed.output.payload.listens,
    remaining: result.remaining,
    resetIn: result.resetIn,
  };
}

export const maxListensPerPull = 200;

export function listenInputs(
  listens: Listen[],
  userId: number,
  sourceId: number,
) {
  return listens.map((listen) => {
    const info = listen.track_metadata.additional_info;
    return {
      kind: "listenbrainz",
      sourceKey: listenKey(listen),
      artist: listen.track_metadata.artist_name,
      title: listen.track_metadata.track_name,
      mbid: info?.recording_mbid,
      isrc: info?.isrc,
      listenedAt: listen.listened_at,
      userId,
      sourceId,
    };
  });
}

export async function storeListensPage(
  db: D1Database,
  source: SourceRow,
  listens: Listen[],
) {
  return storeListens(
    db,
    listenInputs(listens, source.user_id, source.id),
    "listenbrainz",
  );
}

export const listenBrainzFetcher: ListenFetcher = async (url) => {
  const response = await fetch(url);
  const header = (name: string) => {
    const raw = response.headers.get(name);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    status: response.status,
    body: response.ok ? await response.json() : undefined,
    remaining: header("x-ratelimit-remaining"),
    resetIn: header("x-ratelimit-reset-in"),
  };
};

export async function pullListenBrainz(
  env: Env,
  source: SourceRow,
  fetcher: ListenFetcher = listenBrainzFetcher,
  now = Math.floor(Date.now() / 1000),
) {
  if (!source.account) throw new Error("ListenBrainz source has no account");
  const baseUrl = env.LISTENBRAINZ_BASE_URL ?? "https://api.listenbrainz.org";
  const username = source.account;
  const call = async (
    params: URLSearchParams,
    limit: number,
  ): Promise<FetchedPage<Listen>> => {
    try {
      const page = await fetchPage(baseUrl, username, params, fetcher);
      const raw = page.listens.slice(0, limit);
      return {
        rawCount: raw.length,
        plays: raw,
        wait:
          page.remaining === 0 && page.resetIn !== undefined ? page.resetIn : 0,
      };
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
      pageSize: maxListensPerPull,
      current: (cursor, limit) => {
        const params = new URLSearchParams({ count: String(limit) });
        if (cursor !== null) params.set("min_ts", String(cursor));
        return call(params, limit);
      },
      walk: (bound, limit) =>
        call(
          new URLSearchParams({
            count: String(limit),
            max_ts: String(bound),
          }),
          limit,
        ),
      at: (listen) => listen.listened_at,
      store: (listens) =>
        storeListens(
          env.DB,
          listenInputs(listens, source.user_id, source.id),
          "listenbrainz",
        ),
    },
    now,
  );
}
