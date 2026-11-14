import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import worker from "../src/index";
import { pullDueSources } from "../src/cron";
import { maxSourcesPerPull } from "../src/pull";
import { sealTokens } from "../src/spotify";
import type { SourceRow } from "../src/types";
import fixture from "./fixtures/spotify-recently-played.json";

const now = Math.floor(Date.now() / 1000);
const key = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);

const testEnv = () => ({
  DB: env.DB,
  CACHE: env.CACHE,
  SPOTIFY_CLIENT_ID: "spotify-id",
  SPOTIFY_CLIENT_SECRET: "spotify-secret",
  SPOTIFY_ENCRYPTION_KEY: key,
});

async function seedUser() {
  await env.DB.prepare(
    "INSERT INTO users (github_id, name, created_at) VALUES (1, 'alice', ?1)",
  )
    .bind(now)
    .run();
  const secret = await sealTokens(testEnv() as never, {
    r: "refresh-1",
    a: "access-1",
    e: now + 3600,
  });
  await env.DB.prepare(
    `INSERT INTO sources (id, user_id, kind, account, secret, next_pull_at)
     VALUES (10, 1, 'spotify', 'alice-sp', ?1, ?2)`,
  )
    .bind(secret, now)
    .run();
}

async function sourceRow() {
  return (await env.DB.prepare(
    "SELECT * FROM sources WHERE id = 10",
  ).first()) as SourceRow;
}

const playsBody = () =>
  new Response(JSON.stringify({ items: fixture.items.slice(0, 1) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pull scheduling", () => {
  it("is due again in 20 minutes after a pull with plays", async () => {
    await seedUser();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => playsBody());
    await pullDueSources(testEnv() as never, now);
    const source = await sourceRow();
    expect(source.next_pull_at).toBe(now + 20 * 60);
  });

  it("pulls at most maxSourcesPerPull due sources in one tick", async () => {
    const due = maxSourcesPerPull + 3;
    const secret = await sealTokens(testEnv() as never, {
      r: "r",
      a: "a",
      e: now + 3600,
    });
    await env.DB.prepare(
      `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?2)
       INSERT INTO users (id, github_id, name, created_at)
       SELECT n, n + 100, 'due-' || n, ?1 FROM numbers`,
    )
      .bind(now, due)
      .run();
    await env.DB.prepare(
      `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?2)
       INSERT INTO sources (id, user_id, kind, account, secret, next_pull_at)
       SELECT n + 10, n, 'spotify', 'due-' || n, ?3, ?1 FROM numbers`,
    )
      .bind(now, due, secret)
      .run();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => playsBody());
    await pullDueSources(testEnv() as never, now);
    expect(fetcher).toHaveBeenCalledTimes(maxSourcesPerPull);
  });

  it("persists exponential backoff after failed pulls", async () => {
    await seedUser();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Spotify unavailable"),
    );
    let pullAt = now;
    const gaps = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await pullDueSources(testEnv() as never, pullAt);
      const source = await sourceRow();
      expect(source.idle_pulls).toBe(attempt);
      gaps.push((source.next_pull_at ?? 0) - pullAt);
      pullAt = source.next_pull_at ?? pullAt;
    }
    expect(gaps).toEqual([30 * 60, 60 * 60, 2 * 60 * 60]);
  });

  it("records the D1 daily cap in KV and skips every later query until midnight", async () => {
    await seedUser();
    const capError = () =>
      new Error(
        "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
      );
    const prepare = vi.spyOn(env.DB, "prepare").mockImplementation(
      () =>
        ({
          bind: () => ({
            all: async () => {
              throw capError();
            },
            run: async () => {
              throw capError();
            },
            first: async () => {
              throw capError();
            },
          }),
        }) as unknown as D1PreparedStatement,
    );
    const fetcher = vi.spyOn(globalThis, "fetch");
    await pullDueSources(testEnv() as never, now);
    const keys = await env.CACHE.list();
    const midnight = Math.floor(now / 86400) * 86400 + 86400;
    expect(
      keys.keys.map((entry) => ({
        name: entry.name,
        expiration: entry.expiration,
      })),
    ).toEqual([{ name: "d1-capped", expiration: midnight }]);
    prepare.mockClear();
    await pullDueSources(testEnv() as never, now + 60);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("runs a due source through the Worker scheduled handler", async () => {
    await seedUser();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => playsBody());
    await worker.scheduled(
      {
        cron: "* * * * *",
        scheduledTime: now * 1000,
        noRetry: () => undefined,
      },
      testEnv() as never,
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    const plays = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plays",
    ).first<{ n: number }>();
    expect(plays?.n).toBe(1);
    const source = await sourceRow();
    expect((source.next_pull_at ?? 0) - now).toBeGreaterThanOrEqual(20 * 60);
  });
});

describe("migration 0006", () => {
  it("leaves no listenbrainz row and correct totals", async () => {
    await env.DB.prepare(
      "INSERT INTO users (github_id, name, created_at) VALUES (1, 'alice', ?1)",
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind, account) VALUES (10, 1, 'listenbrainz', 'rob')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind) VALUES (11, 1, 'ytmusic')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO artists (id, key, name) VALUES (1, 'artist', 'Artist')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO tracks (id, key, artist_id, title) VALUES (1, 'artisttrack', 1, 'Track')",
    ).run();
    for (const [sourceId, plays] of [
      [10, 3],
      [11, 2],
    ] as const)
      for (let i = 0; i < plays; i += 1)
        await env.DB.prepare(
          "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, ?2, ?3, 1)",
        )
          .bind(now - 3600 * (i + 1) - sourceId, sourceId, `${sourceId}r${i}`)
          .run();
    // Migration 0006 already ran in beforeEach; re-run its deletes on the
    // seeded rows by applying its queries directly.
    const migration = migrations.find((item) => item.name.includes("0006"));
    for (const query of migration!.queries) await env.DB.prepare(query).run();
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM sources WHERE kind = 'listenbrainz'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM plays").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(2);
    expect(
      (
        await env.DB.prepare(
          "SELECT plays FROM track_totals WHERE user_id = 1",
        ).first<{ plays: number }>()
      )?.plays,
    ).toBe(2);
    expect(
      (
        await env.DB.prepare(
          "SELECT SUM(plays) AS s FROM daily_totals WHERE user_id = 1",
        ).first<{ s: number }>()
      )?.s,
    ).toBe(2);
    expect(
      (
        await env.DB.prepare(
          "SELECT plays FROM artist_totals WHERE user_id = 1",
        ).first<{ plays: number }>()
      )?.plays,
    ).toBe(2);
  });
});
