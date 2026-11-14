import * as v from "valibot";
import {
  playInputs,
  pullSpotify,
  RecentlyPlayedSchema,
  sealTokens,
  type RecentlyPlayed,
} from "../src/spotify";
import { markDuplicates } from "../src/duplicates";
import { resolvePageTracks, storeListens } from "../src/matching";
import type { Env, SourceRow } from "../src/types";
import fixture from "../test/fixtures/spotify-recently-played.json";

const page = { items: fixture.items };
const pageText = JSON.stringify(page);
const pagePlays = page.items as RecentlyPlayed[];

const benchUserId = -1;
const benchSourceId = -1;

function playAt(item: RecentlyPlayed) {
  return Math.floor(Date.parse(item.played_at) / 1000);
}

const toInputs = (items: RecentlyPlayed[]) =>
  playInputs(
    items.map((item) => ({ at: playAt(item), track: item.track })),
    benchUserId,
    benchSourceId,
  );

// A page of `n` plays: the fixture repeated, each copy older than the last,
// so a page larger than the recording still holds `n` distinct plays.
function playsOf(n: number): RecentlyPlayed[] {
  const span =
    playAt(pagePlays[0]!) - playAt(pagePlays[pagePlays.length - 1]!) + 1;
  if (n === pagePlays.length) return pagePlays;
  return Array.from({ length: n }, (_, i) => {
    const item = pagePlays[i % pagePlays.length]!;
    const copy = Math.floor(i / pagePlays.length);
    return {
      ...item,
      played_at: new Date((playAt(item) - copy * span) * 1000).toISOString(),
    };
  });
}

function sizeOf(url: URL) {
  const n = Number(url.searchParams.get("n") ?? pagePlays.length);
  return Math.min(Math.max(Math.floor(n) || 1, 1), 1000);
}

const shiftPlays = (items: RecentlyPlayed[], run: number): RecentlyPlayed[] =>
  items.map((item) => ({
    ...item,
    played_at: new Date((playAt(item) - run * 86_400) * 1000).toISOString(),
  }));

const fixtureFetcher =
  (run: number, items: RecentlyPlayed[]): typeof fetch =>
  async (input) => {
    const url = input.toString();
    if (url.startsWith("https://accounts.spotify.com/api/token"))
      return Response.json({ access_token: "bench", expires_in: 3600 });
    return Response.json({ items: shiftPlays(items, run) });
  };

async function ensureBench(db: D1Database, env: Env) {
  const secret = await sealTokens(env, {
    r: "bench-refresh",
    a: "bench-access",
    e: Math.floor(Date.now() / 1000) - 10,
  });
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO users (id, github_id, name, created_at)
         VALUES (?1, ?2, '_bench', ?3)`,
      )
      .bind(benchUserId, benchUserId, Math.floor(Date.now() / 1000)),
    db
      .prepare(
        `INSERT OR IGNORE INTO sources (id, user_id, kind, account, secret)
         VALUES (?1, ?2, 'spotify', 'bench', ?3)`,
      )
      .bind(benchSourceId, benchUserId, secret),
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
    db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(benchUserId),
    db.prepare("DELETE FROM sources WHERE user_id = ?1").bind(benchUserId),
    db.prepare("DELETE FROM users WHERE id = ?1").bind(benchUserId),
  ]);
}

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
         VALUES (?1, ?2, 'spotify', 'dups')`,
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
          await run(() => v.safeParse(RecentlyPlayedSchema, page), repeat),
        );
      case "/resolve":
        return report(
          "/resolve",
          await run(
            () =>
              resolvePageTracks(toInputs(playsOf(sizeOf(url))), new Map(), []),
            repeat,
          ),
        );
      case "/store": {
        await ensureBench(env.DB, env);
        return report(
          "/store",
          await run(
            (run) =>
              storeListens(
                env.DB,
                playInputs(
                  shiftPlays(playsOf(sizeOf(url)), run).map((item) => ({
                    at: playAt(item),
                    track: item.track,
                  })),
                  benchUserId,
                  benchSourceId,
                ),
                "spotify",
              ),
            repeat,
          ),
        );
      }
      case "/pull":
        await ensureBench(env.DB, env);
        try {
          const row = await env.DB.prepare(
            "SELECT * FROM sources WHERE id = ?1",
          )
            .bind(benchSourceId)
            .first<SourceRow>();
          return report(
            "/pull",
            await run(
              (run) =>
                pullSpotify(
                  env,
                  { ...row! },
                  fixtureFetcher(run, playsOf(sizeOf(url))),
                ),
              repeat,
            ),
          );
        } finally {
          await parkBenchSources(env.DB);
        }
      case "/dups-seed":
        await seedDups(env.DB, url.searchParams.get("kind") ?? "ytmusic");
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
