import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import * as v from "valibot";
import { beforeEach, describe, it } from "vitest";
import migrations from "virtual:web-migrations";
import { getStats } from "../src/aggregate";
import { resolvePageTracks } from "../src/matching";
import { normalizeText } from "../src/normalize";
import {
  playInputs,
  pullSpotify,
  RecentlyPlayedSchema,
  sealTokens,
} from "../src/spotify";
// @ts-expect-error vite ?raw import
import fixtureRaw from "./fixtures/spotify-recently-played.json?raw";

const ResponseSchema = RecentlyPlayedSchema;
const key = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);
const testEnv = (db: D1Database) =>
  ({
    DB: db,
    CACHE: env.CACHE,
    SPOTIFY_CLIENT_ID: "spotify-id",
    SPOTIFY_CLIENT_SECRET: "spotify-secret",
    SOURCE_ENCRYPTION_KEY: key,
  }) as never;

function resultsFor(sql: string, aliasRows: any[]) {
  if (sql.includes("track_aliases") && sql.includes("SELECT"))
    return { results: aliasRows };
  return { results: [] as any[] };
}

function fakeDb(aliasRows: any[] = []) {
  const db = {
    prepare(sql: string) {
      return {
        sql,
        bind(..._args: any[]) {
          return {
            sql,
            all: async () => resultsFor(sql, aliasRows),
            run: async () => ({ success: true }),
            first: async () => null,
          };
        },
      };
    },
    batch: async (stmts: any[]) =>
      stmts.map((stmt) => resultsFor(stmt.sql, aliasRows)),
  } as unknown as D1Database;
  return db;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function time(fn: () => unknown, runs = 9) {
  const times: number[] = [];
  fn();
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return median(times);
}

async function timeAsync(fn: () => Promise<unknown>, runs = 5) {
  const times: number[] = [];
  await fn();
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return median(times);
}

const parsed = JSON.parse(fixtureRaw);
const plays = parsed.items;
const now = Math.floor(Date.now() / 1000);

const playAt = (item: any) => Math.floor(Date.parse(item.played_at) / 1000);

function toInputs(userId = 1, sourceId = 10) {
  return playInputs(
    plays.map((item: any) => ({ at: playAt(item), track: item.track })),
    userId,
    sourceId,
  );
}

describe("bench", () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, migrations);
    await env.DB.prepare(
      "INSERT INTO users (github_id, name, created_at) VALUES (1, 'alice', ?1)",
    )
      .bind(now)
      .run();
    const secret = await sealTokens(testEnv(env.DB), {
      r: "refresh-1",
      a: "access-1",
      e: now + 3600,
    });
    await env.DB.prepare(
      `INSERT INTO sources (id, user_id, kind, account, secret, next_pull_at)
         VALUES (10, 1, 'spotify', 'rob', ?1, ?2)`,
    )
      .bind(secret, now)
      .run();
  });

  it("reports phase timings", async () => {
    const jsonParse = time(() => JSON.parse(fixtureRaw));
    const validate = time(() => v.safeParse(ResponseSchema, parsed));
    const inputs = toInputs();
    const normalize = time(() =>
      inputs.map((input: any) => ({
        artistKey: normalizeText(input.artist),
        titleKey: normalizeText(input.title),
      })),
    );
    const resolve = time(() => resolvePageTracks(toInputs(), new Map(), []));
    const resolution = resolvePageTracks(toInputs(), new Map(), []);
    const stringifyPrepared = time(() =>
      JSON.stringify(
        toInputs().map((input: any) => ({
          artistKey: normalizeText(input.artist),
          titleKey: normalizeText(input.title),
        })),
      ),
    );
    const stringifyNew = time(() => JSON.stringify(resolution.newTracks));
    const stringifyListens = time(() => JSON.stringify(resolution.listens));

    const fakeEnv = testEnv(fakeDb());
    const source = {
      id: 10,
      user_id: 1,
      kind: "spotify",
      account: "rob",
      cursor: null,
      backfill_before: null,
      gap_before: null,
      gap_floor: null,
      next_pull_at: now,
      idle_pulls: 0,
      secret: await sealTokens(testEnv(fakeDb()), {
        r: "r",
        a: "a",
        e: now + 3600,
      }),
    };
    const fetcher = (async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ items: plays }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const pullFake = await timeAsync(async () =>
      pullSpotify(fakeEnv, { ...source }, fetcher, now),
    );

    const realSource = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    const pullRealNew = await timeAsync(
      async () => pullSpotify(testEnv(env.DB), { ...realSource }, fetcher, now),
      3,
    );
    const storedReal = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    const pullRealStored = await timeAsync(
      async () => pullSpotify(testEnv(env.DB), storedReal, fetcher, now + 900),
      3,
    );

    console.log("=== bench: page of", plays.length, "plays ===");
    console.log("json parse        :", jsonParse.toFixed(2), "ms");
    console.log("valibot validate  :", validate.toFixed(2), "ms");
    console.log("normalize x2      :", normalize.toFixed(2), "ms");
    console.log("resolvePageTracks :", resolve.toFixed(2), "ms");
    console.log("stringify prepared:", stringifyPrepared.toFixed(2), "ms");
    console.log("stringify newTracks:", stringifyNew.toFixed(2), "ms");
    console.log("stringify listens :", stringifyListens.toFixed(2), "ms");
    console.log("pull new (fake D1):", pullFake.toFixed(2), "ms");
    console.log("pull new (real D1):", pullRealNew.toFixed(2), "ms");
    console.log("pull stored(realD1):", pullRealStored.toFixed(2), "ms");
  });
});

interface TimedCall {
  sql: string;
  ms: number;
  rows: number;
}

function timedDb(db: D1Database, batched: boolean) {
  const calls: TimedCall[] = [];
  const wrap = {
    prepare(sql: string) {
      const short = sql.trim().split("\n")[0] ?? sql;
      const stmt = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          const bound = stmt.bind(...args);
          const time =
            <T>(work: () => Promise<T>, rows: (r: T) => number) =>
            async () => {
              const start = performance.now();
              const result = await work();
              calls.push({
                sql: short,
                ms: performance.now() - start,
                rows: rows(result),
              });
              return result;
            };
          bound.all = time(
            () => stmt.bind(...args).all(),
            (r) => r.results.length,
          ) as typeof bound.all;
          bound.first = time(
            () => stmt.bind(...args).first(),
            () => 1,
          ) as typeof bound.first;
          bound.run = time(
            () => stmt.bind(...args).run(),
            () => 0,
          ) as typeof bound.run;
          return bound;
        },
      };
    },
    async batch(stmts: D1PreparedStatement[]) {
      if (batched) {
        const start = performance.now();
        const result = await db.batch(stmts);
        calls.push({
          sql: `BATCH of ${stmts.length}`,
          ms: performance.now() - start,
          rows: -1,
        });
        return result;
      }
      const results = [];
      for (const stmt of stmts) results.push(await stmt.all());
      return results;
    },
    withSession: () => wrap,
  } as unknown as D1Database;
  return { db: wrap, calls };
}

async function seedListening(plays: number, tracks: number) {
  await env.DB.prepare(
    "INSERT INTO users (github_id, name, created_at) VALUES (1, 'alice', ?1)",
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    `INSERT INTO sources (id, user_id, kind, account, next_pull_at)
       VALUES (10, 1, 'spotify', 'alice-sp', ?1)`,
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    `WITH RECURSIVE n(x) AS (
       SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x <= 50
     )
     INSERT INTO artists (key, name)
       SELECT 'artist-' || x, 'Artist ' || x FROM n`,
  ).run();
  await env.DB.prepare(
    `WITH RECURSIVE n(x) AS (
       SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x <= ?1
     )
     INSERT INTO tracks (key, artist_id, title)
       SELECT 't-' || x, 1 + (x % 50), 'Track ' || x FROM n`,
  )
    .bind(tracks)
    .run();
  await env.DB.prepare(
    `WITH RECURSIVE n(x) AS (
       SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x <= ?1
     )
     INSERT INTO plays (user_id, played_at, source_id, track_id)
       SELECT 1, ?2 - x * ?3, 10, 1 + (x % ?4) FROM n`,
  )
    .bind(plays, now, Math.floor((1000 * 86400) / plays), tracks)
    .run();
}

async function benchStats(plays: number, tracks: number) {
  await seedListening(plays, tracks);
  console.log(`=== stats bench: ${plays} plays, ${tracks} tracks ===`);
  for (const period of ["week", "month", "all"] as const) {
    for (const batched of [false, true]) {
      const { db, calls } = timedDb(env.DB, batched);
      const total = await timeAsync(async () => {
        calls.length = 0;
        await getStats(db, 1, "alice", period, now);
      }, 5);
      const d1 = calls.reduce((sum, call) => sum + call.ms, 0);
      console.log(
        `period=${period} batched=${batched} total=${total.toFixed(2)}ms ` +
          `d1=${d1.toFixed(2)}ms js=${(total - d1).toFixed(2)}ms`,
      );
      for (const call of calls) {
        console.log(
          `  ${call.ms.toFixed(2)}ms rows=${call.rows} ${call.sql.slice(0, 70)}`,
        );
      }
    }
  }
  const response = await SELF.fetch(
    "https://music.rising.sh/u/alice.json?period=all",
  );
  console.log("GET /u/alice.json?period=all:", response.status);
}

describe("stats bench", () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, migrations);
  });

  it("reports getStats timings", async () => {
    for (const [plays, tracks] of [
      [5_000, 2_000],
      [50_000, 5_000],
    ] as const) {
      await reset();
      await applyD1Migrations(env.DB, migrations);
      await benchStats(plays, tracks);
    }
  });
});
