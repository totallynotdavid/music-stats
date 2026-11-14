import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import * as v from "valibot";
import { beforeEach, describe, it } from "vitest";
import migrations from "virtual:web-migrations";
import { getStats } from "../src/aggregate";
import { pullListenBrainz } from "../src/listenbrainz";
import { resolvePageTracks } from "../src/matching";
import { normalizeText } from "../src/normalize";
// @ts-expect-error vite ?raw import
import fixtureRaw from "./fixtures/listens-rob.json?raw";

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
const listens = parsed.payload.listens;
const now = Math.floor(Date.now() / 1000);

function toInputs(userId = 1, sourceId = 10) {
  return listens.map((listen: any) => {
    const info = listen.track_metadata.additional_info;
    return {
      kind: "listenbrainz",
      sourceKey:
        info?.recording_mbid ??
        `${listen.track_metadata.artist_name}\t${listen.track_metadata.track_name}`,
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

describe("bench", () => {
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, migrations);
    await env.DB.prepare(
      "INSERT INTO users (github_id, name, created_at) VALUES (1, 'alice', ?1)",
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sources (id, user_id, kind, account, cursor, backfill_before, next_pull_at)
         VALUES (10, 1, 'listenbrainz', 'rob', NULL, NULL, ?1)`,
    )
      .bind(now)
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

    const fakeEnv = { DB: fakeDb() } as any;
    const source = {
      id: 10,
      user_id: 1,
      kind: "listenbrainz",
      account: "rob",
      cursor: null,
      backfill_before: null,
      gap_before: null,
      gap_floor: null,
      next_pull_at: now,
      idle_pulls: 0,
    };
    const ok = (body: unknown): any => ({
      status: 200,
      body,
      remaining: 29,
      resetIn: 30,
    });
    const fetcher = async (url: string) => {
      const params = new URL(url).searchParams;
      if (params.has("max_ts")) return ok({ payload: { listens: [] } });
      const wanted = Number(params.get("count"));
      return ok({ payload: { listens: listens.slice(0, wanted) } });
    };
    const pullFake = await timeAsync(async () =>
      pullListenBrainz(fakeEnv, { ...source }, fetcher, now),
    );

    const aliasRows = resolution.listens.map((listen: any, index: number) => ({
      source_key: listen.sourceKey,
      id: index + 1,
      key: listen.trackKey,
      mbid: null,
      isrc: null,
      artistKey: "a",
      titleKey: "t",
    }));
    const fakeStoredEnv = { DB: fakeDb(aliasRows) } as any;
    const storedSource = { ...source, cursor: now - 100 };
    const pullFakeStored = await timeAsync(async () =>
      pullListenBrainz(fakeStoredEnv, storedSource, fetcher, now),
    );

    const realSource = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    const pullRealNew = await timeAsync(
      async () => pullListenBrainz(env as any, { ...realSource }, fetcher, now),
      3,
    );
    const storedReal = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    const pullRealStored = await timeAsync(
      async () => pullListenBrainz(env as any, storedReal, fetcher, now + 900),
      3,
    );

    console.log("=== bench: page of", listens.length, "listens ===");
    console.log("json parse        :", jsonParse.toFixed(2), "ms");
    console.log("valibot validate  :", validate.toFixed(2), "ms");
    console.log("normalize x2      :", normalize.toFixed(2), "ms");
    console.log("resolvePageTracks :", resolve.toFixed(2), "ms");
    console.log("stringify prepared:", stringifyPrepared.toFixed(2), "ms");
    console.log("stringify newTracks:", stringifyNew.toFixed(2), "ms");
    console.log("stringify listens :", stringifyListens.toFixed(2), "ms");
    console.log("pull new (fake D1):", pullFake.toFixed(2), "ms");
    console.log("pull stored(fakeD1):", pullFakeStored.toFixed(2), "ms");
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
       VALUES (10, 1, 'listenbrainz', 'alice-lb', ?1)`,
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
