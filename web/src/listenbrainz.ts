import * as v from "valibot";
import { storeListens } from "./matching";
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

const ResponseSchema = v.object({
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

const idlePullDelay = (idlePulls: number) =>
  Math.min(6 * 60 * 60, 15 * 60 * 2 ** idlePulls);

function nextPullDelay(inserted: number, idlePulls: number) {
  return inserted > 0 ? 15 * 60 : idlePullDelay(idlePulls);
}

const nextUtcMidnight = (now: number) =>
  Math.floor(now / 86400) * 86400 + 86400;

const dailyLimitPattern = /daily row (?:read|write) limit/i;

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
export const maxSourcesPerPull = 1;
const d1CapKey = "d1-capped";

const nextTickDelay = 60;

async function storeListensPage(
  db: D1Database,
  source: SourceRow,
  listens: Listen[],
) {
  return storeListens(
    db,
    listens.map((listen) => {
      const info = listen.track_metadata.additional_info;
      return {
        kind: "listenbrainz",
        sourceKey: listenKey(listen),
        artist: listen.track_metadata.artist_name,
        title: listen.track_metadata.track_name,
        mbid: info?.recording_mbid,
        isrc: info?.isrc,
        listenedAt: listen.listened_at,
        userId: source.user_id,
        sourceId: source.id,
      };
    }),
    "listenbrainz",
  );
}

export async function pullListenBrainz(
  env: Env,
  source: SourceRow,
  fetcher: ListenFetcher = async (url) => {
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
  },
  now = Math.floor(Date.now() / 1000),
) {
  if (!source.account) throw new Error("ListenBrainz source has no account");
  const baseUrl = env.LISTENBRAINZ_BASE_URL ?? "https://api.listenbrainz.org";
  let waitUntil = 0;
  const noteRateLimit = (remaining?: number, resetIn?: number) => {
    if (remaining === 0 && resetIn !== undefined) waitUntil = resetIn;
  };

  let currentPage: Listen[] = [];
  try {
    const newParams = new URLSearchParams({
      count: String(maxListensPerPull),
    });
    if (source.cursor !== null) newParams.set("min_ts", String(source.cursor));
    const current = await fetchPage(
      baseUrl,
      source.account,
      newParams,
      fetcher,
    );
    noteRateLimit(current.remaining, current.resetIn);
    currentPage = current.listens.slice(0, maxListensPerPull);
  } catch (error) {
    if (!(error instanceof RateLimited)) throw error;
    waitUntil = error.resetIn;
  }

  let inserted = await storeListensPage(env.DB, source, currentPage);

  let cursor = source.cursor;
  let backfillBefore = source.backfill_before;
  let gapBefore = source.gap_before;
  let gapFloor = source.gap_floor;
  if (currentPage.length > 0) {
    cursor = Math.max(
      cursor ?? 0,
      ...currentPage.map((listen) => listen.listened_at),
    );
    const pageMin = Math.min(
      ...currentPage.map((listen) => listen.listened_at),
    );
    if (source.cursor === null) {
      backfillBefore = pageMin;
    } else if (currentPage.length === maxListensPerPull) {
      gapFloor = Math.min(gapFloor ?? source.cursor, source.cursor);
      gapBefore = Math.max(gapBefore ?? pageMin, pageMin);
    }
  }

  const gapActive =
    gapBefore !== null && gapFloor !== null && gapBefore > gapFloor;
  const budget = maxListensPerPull - currentPage.length;
  const walkBound = gapActive
    ? gapBefore
    : backfillBefore !== null && backfillBefore >= 0
      ? backfillBefore
      : null;
  let walkPage: Listen[] | null = null;
  if (waitUntil === 0 && budget > 0 && walkBound !== null) {
    try {
      const walk = await fetchPage(
        baseUrl,
        source.account,
        new URLSearchParams({
          count: String(budget),
          max_ts: String(walkBound),
        }),
        fetcher,
      );
      noteRateLimit(walk.remaining, walk.resetIn);
      walkPage = walk.listens.slice(0, budget);
    } catch (error) {
      if (!(error instanceof RateLimited)) throw error;
      waitUntil = error.resetIn;
    }
  }

  if (walkPage !== null) {
    if (walkPage.length > 0) {
      inserted += await storeListensPage(env.DB, source, walkPage);
    }
    const pageMin =
      walkPage.length === 0
        ? null
        : Math.min(...walkPage.map((listen) => listen.listened_at));
    if (gapActive) {
      if (
        pageMin === null ||
        pageMin <= (gapFloor ?? 0) ||
        walkPage.length < budget
      ) {
        gapBefore = null;
        gapFloor = null;
      } else {
        gapBefore = pageMin;
      }
    } else if (walkPage.length < budget) {
      backfillBefore = null;
    } else {
      backfillBefore = pageMin;
    }
  }

  if (gapBefore !== null && gapFloor !== null && gapBefore <= gapFloor) {
    gapBefore = null;
    gapFloor = null;
  }
  const frontierLeft = gapBefore !== null || backfillBefore !== null;
  const moreToPull =
    currentPage.length === maxListensPerPull ||
    (walkPage !== null && walkPage.length === budget && frontierLeft);
  const idlePulls =
    inserted > 0
      ? 0
      : waitUntil > 0 || moreToPull
        ? source.idle_pulls
        : source.idle_pulls + 1;
  const delay =
    waitUntil > 0
      ? waitUntil
      : moreToPull
        ? nextTickDelay
        : nextPullDelay(inserted, idlePulls);
  await env.DB.prepare(
    `UPDATE sources SET cursor = ?1, backfill_before = ?2, gap_before = ?8,
       gap_floor = ?9, idle_pulls = ?3,
       next_pull_at = ?4, status = 'active', error = NULL, last_ok_at = ?5,
       play_count = play_count + ?6 WHERE id = ?7`,
  )
    .bind(
      cursor,
      backfillBefore,
      idlePulls,
      now + delay,
      now,
      inserted,
      source.id,
      gapBefore,
      gapFloor,
    )
    .run();
  return { inserted, cursor, backfillBefore };
}

export async function pullDueSources(
  env: Env,
  now = Math.floor(Date.now() / 1000),
) {
  if (await env.CACHE?.get(d1CapKey)) return;
  let result;
  try {
    result = await env.DB.prepare(
      `SELECT id, user_id, kind, account, cursor, backfill_before, gap_before,
       gap_floor, next_pull_at, idle_pulls
       FROM sources WHERE next_pull_at IS NOT NULL AND next_pull_at <= ?1
       ORDER BY next_pull_at, id LIMIT ${maxSourcesPerPull}`,
    )
      .bind(now)
      .all<SourceRow>();
  } catch (error) {
    if (error instanceof Error && dailyLimitPattern.test(error.message)) {
      if (env.CACHE)
        await env.CACHE.put(d1CapKey, "1", {
          expiration: nextUtcMidnight(now),
        });
      return;
    }
    throw error;
  }
  for (const source of result.results) {
    if (source.kind !== "listenbrainz") continue;
    try {
      await pullListenBrainz(env, source, undefined, now);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 200)
          : "ListenBrainz pull failed";
      if (dailyLimitPattern.test(message)) {
        if (env.CACHE)
          await env.CACHE.put(d1CapKey, "1", {
            expiration: nextUtcMidnight(now),
          });
        return;
      }
      await env.DB.prepare(
        "UPDATE sources SET status = 'error', error = ?1, idle_pulls = idle_pulls + 1, next_pull_at = ?2 WHERE id = ?3",
      )
        .bind(message, now + nextPullDelay(0, source.idle_pulls + 1), source.id)
        .run();
    }
  }
}
