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
export type ListenFetcher = (url: string) => Promise<unknown>;

const idlePullDelay = (idlePulls: number) =>
  Math.min(6 * 60 * 60, 15 * 60 * 2 ** idlePulls);

function nextPullDelay(inserted: number, idlePulls: number) {
  return inserted > 0 ? 15 * 60 : idlePullDelay(idlePulls);
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
  const parsed = v.safeParse(ResponseSchema, await fetcher(url));
  if (!parsed.success)
    throw new Error("ListenBrainz returned an invalid response");
  return parsed.output.payload.listens;
}

const maxListensPerPull = 1000;
const maxSourcesPerPull = 5;

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
    if (!response.ok)
      throw new Error(`ListenBrainz returned ${response.status}`);
    return response.json();
  },
  now = Math.floor(Date.now() / 1000),
) {
  if (!source.account) throw new Error("ListenBrainz source has no account");
  const baseUrl = env.LISTENBRAINZ_BASE_URL ?? "https://api.listenbrainz.org";
  const newParams = new URLSearchParams({ count: "1000" });
  if (source.cursor !== null) newParams.set("min_ts", String(source.cursor));
  const current = await fetchPage(baseUrl, source.account, newParams, fetcher);
  const currentPage = current.slice(0, maxListensPerPull);
  const currentInserted = await storeListensPage(env.DB, source, currentPage);
  let inserted = currentInserted;

  let cursor = source.cursor;
  let backfillBefore = source.backfill_before;
  if (currentPage.length > 0) {
    cursor = Math.max(
      cursor ?? 0,
      ...currentPage.map((listen) => listen.listened_at),
    );
    if (source.cursor === null) {
      backfillBefore = Math.min(
        ...currentPage.map((listen) => listen.listened_at),
      );
    }
  }

  const remaining = maxListensPerPull - currentPage.length;
  if (remaining > 0 && backfillBefore !== null && backfillBefore >= 0) {
    const backfillParams = new URLSearchParams({
      count: "1000",
      max_ts: String(backfillBefore),
    });
    const historical = await fetchPage(
      baseUrl,
      source.account,
      backfillParams,
      fetcher,
    );
    const historicalPage = historical.slice(0, remaining);
    if (historicalPage.length === 0) {
      backfillBefore = null;
    } else {
      const changes = await storeListensPage(env.DB, source, historicalPage);
      inserted += changes;
      backfillBefore = Math.min(
        ...historicalPage.map((listen) => listen.listened_at),
      );
    }
  }

  const idlePulls = inserted > 0 ? 0 : source.idle_pulls + 1;
  const delay = nextPullDelay(inserted, idlePulls);
  await env.DB.prepare(
    `UPDATE sources SET cursor = ?1, backfill_before = ?2, idle_pulls = ?3,
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
    )
    .run();
  return { inserted, cursor, backfillBefore };
}

export async function pullDueSources(
  env: Env,
  now = Math.floor(Date.now() / 1000),
) {
  const result = await env.DB.prepare(
    `SELECT id, user_id, kind, account, cursor, backfill_before, next_pull_at, idle_pulls
       FROM sources WHERE next_pull_at IS NOT NULL AND next_pull_at <= ?1
       ORDER BY next_pull_at, id LIMIT ${maxSourcesPerPull}`,
  )
    .bind(now)
    .all<SourceRow>();
  for (const source of result.results) {
    if (source.kind !== "listenbrainz") continue;
    try {
      await pullListenBrainz(env, source, undefined, now);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 200)
          : "ListenBrainz pull failed";
      const idlePulls = source.idle_pulls + 1;
      const delay = nextPullDelay(0, idlePulls);
      await env.DB.prepare(
        "UPDATE sources SET status = 'error', error = ?1, idle_pulls = idle_pulls + 1, next_pull_at = ?2 WHERE id = ?3",
      )
        .bind(message, now + delay, source.id)
        .run();
    }
  }
}
