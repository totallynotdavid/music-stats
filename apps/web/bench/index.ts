import * as v from "valibot";
import type { LastFmTrack } from "../src/lastfm";
import {
  pullLastFm,
  ResponseSchema as LastFmResponseSchema,
  storeTracksPage,
  trackInputs,
} from "../src/lastfm";
import type { Listen, ListenFetcher } from "../src/listenbrainz";
import {
  listenBrainzFetcher,
  listenInputs,
  pullListenBrainz,
  ResponseSchema,
  storeListensPage,
} from "../src/listenbrainz";
import { markDuplicates } from "../src/duplicates";
import { resolvePageTracks } from "../src/matching";
import type { Env, SourceRow } from "../src/types";
import fixture from "../test/fixtures/listens-rob.json";
import lastFmFixture from "../test/fixtures/recenttracks";

const page = { payload: { listens: fixture.payload.listens.slice(0, 200) } };
const pageText = JSON.stringify(page);
const pageListens = page.payload.listens as Listen[];
const fixtureListens = fixture.payload.listens as Listen[];
const fixtureSpan =
  fixtureListens[0].listened_at -
  fixtureListens[fixtureListens.length - 1].listened_at +
  1;

// A page of `n` listens: the fixture repeated, each copy older than the last,
// so a page larger than the recording still holds `n` distinct plays.
function listensOf(n: number): Listen[] {
  if (n === pageListens.length) return pageListens;
  return Array.from({ length: n }, (_, i) => {
    const listen = fixtureListens[i % fixtureListens.length];
    const copy = Math.floor(i / fixtureListens.length);
    return { ...listen, listened_at: listen.listened_at - copy * fixtureSpan };
  });
}

function sizeOf(url: URL) {
  const n = Number(url.searchParams.get("n") ?? pageListens.length);
  return Math.min(Math.max(Math.floor(n) || 1, 1), 1000);
}
const pageTracks = lastFmFixture.recenttracks.track
  .filter((track) => "date" in track)
  .slice(0, 200) as LastFmTrack[];

const benchUserId = -1;
const benchSourceId = -1;
const lastFmSourceId = -2;

const benchSource: SourceRow = {
  id: benchSourceId,
  user_id: benchUserId,
  kind: "listenbrainz",
  account: "rob",
  cursor: null,
  backfill_before: null,
  gap_before: null,
  gap_floor: null,
  next_pull_at: null,
  idle_pulls: 0,
};

const lastFmSource: SourceRow = {
  ...benchSource,
  id: lastFmSourceId,
  kind: "lastfm",
  account: "fixture",
};

async function ensureBench(db: D1Database) {
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO users (id, github_id, name, created_at)
         VALUES (?1, ?2, '_bench', ?3)`,
      )
      .bind(benchUserId, benchUserId, Math.floor(Date.now() / 1000)),
    db
      .prepare(
        `INSERT OR IGNORE INTO sources (id, user_id, kind, account)
         VALUES (?1, ?2, 'listenbrainz', 'rob')`,
      )
      .bind(benchSourceId, benchUserId),
    db
      .prepare(
        `INSERT OR IGNORE INTO sources (id, user_id, kind, account)
         VALUES (?1, ?2, 'lastfm', 'fixture')`,
      )
      .bind(lastFmSourceId, benchUserId),
  ]);
}

async function parkBenchSources(db: D1Database) {
  await db
    .prepare("UPDATE sources SET next_pull_at = NULL WHERE user_id = ?1")
    .bind(benchUserId)
    .run();
}

async function reset(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM plays WHERE user_id = ?1").bind(benchUserId),
    db.prepare("DELETE FROM track_totals WHERE user_id = ?1").bind(benchUserId),
    db.prepare("DELETE FROM daily_totals WHERE user_id = ?1").bind(benchUserId),
    db
      .prepare("DELETE FROM artist_totals WHERE user_id = ?1")
      .bind(benchUserId),
    db.prepare("DELETE FROM tokens WHERE source_id = ?1").bind(benchSourceId),
    db.prepare("DELETE FROM tokens WHERE source_id = ?1").bind(lastFmSourceId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(benchUserId),
    db.prepare("DELETE FROM sources WHERE user_id = ?1").bind(benchUserId),
    db.prepare("DELETE FROM users WHERE id = ?1").bind(benchUserId),
  ]);
}

const shiftListens = (listens: Listen[], run: number): Listen[] =>
  listens.map((listen) => ({
    ...listen,
    listened_at: listen.listened_at - run * 86_400,
  }));

const shiftTracks = (tracks: LastFmTrack[], run: number): LastFmTrack[] =>
  tracks.map((track) =>
    track.date === undefined
      ? track
      : {
          ...track,
          date: {
            ...track.date,
            uts: String(Number(track.date.uts) - run * 86_400),
          },
        },
  );

const shiftedFetcher =
  (base: ListenFetcher, run: number): ListenFetcher =>
  async (url) => {
    const result = await base(url);
    if (run === 0) return result;
    const body = result.body as
      | { payload?: { listens?: Listen[] } }
      | undefined;
    if (body?.payload?.listens) {
      body.payload.listens = shiftListens(body.payload.listens, run);
    }
    return result;
  };

const fixtureFetcher =
  (run: number, listens: Listen[]): ListenFetcher =>
  async (url) => {
    const params = new URL(url).searchParams;
    if (params.has("max_ts")) {
      return { status: 200, body: { payload: { listens: [] } } };
    }
    const count = Number(params.get("count")) || listens.length;
    return {
      status: 200,
      body: {
        payload: { listens: shiftListens(listens.slice(0, count), run) },
      },
      remaining: 29,
      resetIn: 30,
    };
  };

const lastFmFixtureFetcher = (run: number) => async (url: string) => {
  const params = new URL(url).searchParams;
  if (params.has("to")) {
    return { status: 200, body: { recenttracks: { track: [] } } };
  }
  const limit = Number(params.get("limit")) || pageTracks.length;
  return {
    status: 200,
    body: {
      recenttracks: { track: shiftTracks(pageTracks.slice(0, limit), run) },
    },
  };
};

async function run(
  stage: (run: number) => unknown | Promise<unknown>,
  repeat: number,
) {
  const runs: number[] = [];
  for (let i = 0; i < repeat; i += 1) {
    const start = performance.now();
    await stage(i);
    runs.push(Math.round((performance.now() - start) * 100) / 100);
  }
  return runs;
}

const dupUserId = -3;
const dupAnchorSourceId = -3;
const dupLoserSourceId = -4;

async function seedDups(db: D1Database, kind: string) {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO users (id, github_id, name, created_at)
         VALUES (?1, ?1, '_dups', ?2)`,
      )
      .bind(dupUserId, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO sources (id, user_id, kind, account)
         VALUES (?1, ?2, 'listenbrainz', 'dups')`,
      )
      .bind(dupAnchorSourceId, dupUserId),
    db
      .prepare(
        `INSERT OR IGNORE INTO sources (id, user_id, kind, account)
         VALUES (?1, ?2, ?3, 'dups')`,
      )
      .bind(dupLoserSourceId, dupUserId, kind),
    db
      .prepare("UPDATE sources SET kind = ?1 WHERE id = ?2")
      .bind(kind, dupLoserSourceId),
  ]);
  await db
    .prepare("DELETE FROM plays WHERE user_id = ?1")
    .bind(dupUserId)
    .run();
  await db
    .prepare(
      `WITH RECURSIVE n(x) AS (
       SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 50
     )
     INSERT OR IGNORE INTO artists (id, key, name)
       SELECT x, 'dartist-' || x, 'Artist ' || x FROM n`,
    )
    .run();
  await db
    .prepare(
      `WITH RECURSIVE n(x) AS (
       SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 500
     )
     INSERT OR IGNORE INTO tracks (id, key, artist_id, title)
       SELECT x, 'dtrack-' || x, 1 + (x % 50), 'Track ' || x FROM n`,
    )
    .run();
  const dayStart = Math.floor(now / 86400) * 86400;
  const anchorTime =
    kind === "ytmusic" ? "?2 - x * 86400 + 72000" : "?2 - x * 600 - 5";
  const loserTime =
    kind === "ytmusic" ? "?2 - x * 86400 + 43200" : "?2 - x * 600";
  const base = kind === "ytmusic" ? dayStart : now;
  for (const [time, sourceId] of [
    [anchorTime, dupAnchorSourceId],
    [loserTime, dupLoserSourceId],
  ] as const)
    await db
      .prepare(
        `WITH RECURSIVE n(x) AS (
         SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 200
       )
       INSERT INTO plays (user_id, played_at, source_id, ref, track_id, dup)
         SELECT ?1, ${time}, ?3, 'p' || x, 1 + (x % 500), 0 FROM n`,
      )
      .bind(dupUserId, base, sourceId)
      .run();
}

async function deleteDups(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM plays WHERE user_id = ?1").bind(dupUserId),
    db.prepare("DELETE FROM track_totals WHERE user_id = ?1").bind(dupUserId),
    db.prepare("DELETE FROM daily_totals WHERE user_id = ?1").bind(dupUserId),
    db.prepare("DELETE FROM artist_totals WHERE user_id = ?1").bind(dupUserId),
    db.prepare("DELETE FROM sources WHERE user_id = ?1").bind(dupUserId),
    db.prepare("DELETE FROM users WHERE id = ?1").bind(dupUserId),
  ]);
}

async function dupLoserRange(db: D1Database) {
  return db
    .prepare(
      `SELECT MIN(played_at) AS f, MAX(played_at) AS t FROM plays
       WHERE user_id = ?1 AND source_id = ?2 AND played_at >= (
         SELECT played_at FROM plays
         WHERE user_id = ?1 AND source_id = ?2
         ORDER BY played_at DESC LIMIT 1 OFFSET 199
       )`,
    )
    .bind(dupUserId, dupLoserSourceId)
    .first<{ f: number; t: number }>();
}

function repeatOf(url: URL) {
  const n = Number(url.searchParams.get("repeat") ?? "1");
  return Math.min(Math.max(Math.floor(n) || 1, 1), 20);
}

function report(route: string, runs: number[]) {
  return Response.json({ route, repeat: runs.length, ms: runs });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const repeat = repeatOf(url);
    switch (url.pathname) {
      case "/":
        return new Response("ok\n");
      case "/json":
        return report("/json", await run(() => JSON.parse(pageText), repeat));
      case "/parse":
        return report(
          "/parse",
          await run(() => v.safeParse(ResponseSchema, page), repeat),
        );
      case "/parse-lastfm":
        return report(
          "/parse-lastfm",
          await run(
            () => v.safeParse(LastFmResponseSchema, lastFmFixture),
            repeat,
          ),
        );
      case "/resolve": {
        const inputs = listenInputs(
          listensOf(sizeOf(url)),
          benchUserId,
          benchSourceId,
        );
        return report(
          "/resolve",
          await run(() => resolvePageTracks(inputs, new Map(), []), repeat),
        );
      }
      case "/resolve-lastfm": {
        const inputs = trackInputs(
          pageTracks.filter(
            (track): track is LastFmTrack & { date: { uts: string } } =>
              track.date !== undefined,
          ),
          benchUserId,
          lastFmSourceId,
        );
        return report(
          "/resolve-lastfm",
          await run(() => resolvePageTracks(inputs, new Map(), []), repeat),
        );
      }
      case "/store":
        await ensureBench(env.DB);
        return report(
          "/store",
          await run(
            (run) =>
              storeListensPage(
                env.DB,
                benchSource,
                shiftListens(listensOf(sizeOf(url)), run),
              ),
            repeat,
          ),
        );
      case "/lastfm-store":
        await ensureBench(env.DB);
        return report(
          "/lastfm-store",
          await run(
            (run) =>
              storeTracksPage(
                env.DB,
                lastFmSource,
                shiftTracks(pageTracks, run),
              ),
            repeat,
          ),
        );
      case "/pull":
        await ensureBench(env.DB);
        try {
          return report(
            "/pull",
            await run(
              (run) =>
                pullListenBrainz(
                  env,
                  { ...benchSource },
                  fixtureFetcher(run, listensOf(sizeOf(url))),
                ),
              repeat,
            ),
          );
        } finally {
          await parkBenchSources(env.DB);
        }
      case "/pull-live":
        await ensureBench(env.DB);
        try {
          return report(
            "/pull-live",
            await run(
              (run) =>
                pullListenBrainz(
                  env,
                  { ...benchSource },
                  shiftedFetcher(listenBrainzFetcher, run),
                ),
              repeat,
            ),
          );
        } finally {
          await parkBenchSources(env.DB);
        }
      case "/lastfm":
        await ensureBench(env.DB);
        try {
          return report(
            "/lastfm",
            await run(
              (run) =>
                pullLastFm(
                  { ...env, LASTFM_API_KEY: "bench" },
                  { ...lastFmSource },
                  lastFmFixtureFetcher(run),
                  Math.floor(Date.now() / 1000),
                  0,
                ),
              repeat,
            ),
          );
        } finally {
          await parkBenchSources(env.DB);
        }
      case "/dups-seed":
        await seedDups(env.DB, url.searchParams.get("kind") ?? "lastfm");
        return new Response("seeded\n");
      case "/dups-reset": {
        const result = await env.DB.prepare(
          `UPDATE plays SET dup = 0
           WHERE user_id = ?1 AND source_id = ?2 AND played_at >= (
             SELECT played_at FROM plays
             WHERE user_id = ?1 AND source_id = ?2
             ORDER BY played_at DESC LIMIT 1 OFFSET 199
           )`,
        )
          .bind(dupUserId, dupLoserSourceId)
          .run();
        return Response.json({ reset: result.meta?.changes ?? 0 });
      }
      case "/dups": {
        const range = await dupLoserRange(env.DB);
        if (range === null)
          return new Response("run /dups-seed first\n", { status: 400 });
        const result = await markDuplicates(
          env.DB,
          dupUserId,
          range.f,
          range.t,
        );
        return Response.json(result);
      }
      case "/dups-delete":
        await deleteDups(env.DB);
        return new Response("deleted\n");
      case "/reset":
        await reset(env.DB);
        return new Response("reset\n");
      default:
        return new Response("not found\n", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
