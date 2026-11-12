import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import worker from "../src/index";
import { pullDueSources, pullListenBrainz } from "../src/listenbrainz";
import { storeListens } from "../src/matching";
import type { SourceRow } from "../src/types";
import fixture from "./fixtures/listens-rob.json";

const now = Math.floor(Date.now() / 1000);
const listens = fixture.payload.listens.slice(0, 4);

const ok = (body: unknown, extra: Record<string, number> = {}) => ({
  status: 200,
  body,
  remaining: 29,
  resetIn: 30,
  ...extra,
});

const listensBody = (items: unknown[]) => ok({ payload: { listens: items } });

async function seedUser(
  source: Partial<{
    cursor: number | null;
    backfill_before: number | null;
  }> = {},
) {
  await env.DB.prepare(
    "INSERT INTO users (github_id, name, created_at) VALUES (1, 'alice', ?1)",
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    `INSERT INTO sources (id, user_id, kind, account, cursor, backfill_before, next_pull_at)
       VALUES (10, 1, 'listenbrainz', 'alice-lb', ?1, ?2, ?3)`,
  )
    .bind(source.cursor ?? null, source.backfill_before ?? null, now)
    .run();
}

async function sourceRow() {
  const row = await env.DB.prepare(
    "SELECT * FROM sources WHERE id = 10",
  ).first<SourceRow>();
  return row!;
}

async function count(table: string) {
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<{ count: number }>();
  return result?.count ?? 0;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pull scheduling", () => {
  it("schedules the next tick after a full backfill page", async () => {
    await seedUser({ cursor: now, backfill_before: now - 1 });
    const fetcher = async (url: string) => {
      const params = new URL(url).searchParams;
      if (!params.has("max_ts")) return listensBody([]);
      const wanted = Number(params.get("count"));
      const full = Array.from({ length: wanted }, (_, index) => ({
        ...listens[index % listens.length],
        listened_at: now - 100 - index,
      }));
      return listensBody(full);
    };
    const first = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(first.inserted).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT next_pull_at FROM sources WHERE id = 10",
      ).first<{ next_pull_at: number }>(),
    ).toEqual({ next_pull_at: now + 60 });
  });

  it("ends the backfill on a short backfill page", async () => {
    await seedUser({ cursor: now, backfill_before: now - 1 });
    const fetcher = async (url: string) =>
      new URL(url).searchParams.has("max_ts")
        ? listensBody([{ ...listens[0], listened_at: now - 50 }])
        : listensBody([]);
    const result = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(result.backfillBefore).toBeNull();
    const stored = await env.DB.prepare(
      "SELECT backfill_before, next_pull_at FROM sources WHERE id = 10",
    ).first<{ backfill_before: number | null; next_pull_at: number }>();
    expect(stored).toEqual({
      backfill_before: null,
      next_pull_at: now + 15 * 60,
    });
  });

  it("marks the backfill done on an empty backfill page", async () => {
    await seedUser({ cursor: now, backfill_before: now - 1 });
    const fetcher = async () => listensBody([]);
    const result = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(result.backfillBefore).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT backfill_before FROM sources WHERE id = 10",
      ).first<{ backfill_before: number | null }>(),
    ).toEqual({ backfill_before: null });
  });

  it("waits out the rate-limit reset instead of the back-off", async () => {
    await seedUser({ cursor: now, backfill_before: now - 1 });
    const fetcher = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.has("max_ts"))
        return ok({ payload: { listens: [] } });
      return ok(
        { payload: { listens: [listens[0]] } },
        { remaining: 0, resetIn: 120 },
      );
    });
    await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT next_pull_at, idle_pulls FROM sources WHERE id = 10",
      ).first<{ next_pull_at: number; idle_pulls: number }>(),
    ).toEqual({ next_pull_at: now + 120, idle_pulls: 0 });
  });

  it("waits out the reset after a 429", async () => {
    await seedUser();
    const fetcher = async () => ({ status: 429, resetIn: 45 });
    const result = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(result.inserted).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT next_pull_at, idle_pulls FROM sources WHERE id = 10",
      ).first<{ next_pull_at: number; idle_pulls: number }>(),
    ).toEqual({ next_pull_at: now + 45, idle_pulls: 0 });
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
    await pullDueSources(env, now);
    const keys = await env.CACHE.list();
    const midnight = Math.floor(now / 86400) * 86400 + 86400;
    expect(
      keys.keys.map((key) => ({
        name: key.name,
        expiration: key.expiration,
      })),
    ).toEqual([{ name: "d1-capped", expiration: midnight }]);
    prepare.mockClear();
    await pullDueSources(env, now + 60);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("inserts nothing when a page of stored listens is pulled again", async () => {
    await seedUser();
    const page = listens.map((listen, index) => ({
      ...listen,
      listened_at: now - 100 - index,
    }));
    const fetcher = async (url: string) =>
      new URL(url).searchParams.has("max_ts")
        ? listensBody([])
        : listensBody(page);
    const first = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(first.inserted).toBe(4);
    const plays = await count("plays");
    const second = await pullListenBrainz(
      env,
      await sourceRow(),
      fetcher,
      now + 900,
    );
    expect(second.inserted).toBe(0);
    expect(await count("plays")).toBe(plays);
  });

  it("advances the cursor when every current listen is already stored", async () => {
    await seedUser();
    const page = [0, 1, 2].map((index) => ({
      listened_at: now - 100 * (index + 1),
      track_metadata: {
        artist_name: `Cursor Artist ${index}`,
        track_name: `Cursor Song ${index}`,
        additional_info: { recording_mbid: `cursor-${index}` },
      },
    }));
    await storeListens(
      env.DB,
      page.map((listen) => ({
        kind: "listenbrainz",
        sourceKey: listen.track_metadata.additional_info.recording_mbid,
        artist: listen.track_metadata.artist_name,
        title: listen.track_metadata.track_name,
        mbid: listen.track_metadata.additional_info.recording_mbid,
        listenedAt: listen.listened_at,
        userId: 1,
        sourceId: 10,
      })),
      "listenbrainz",
    );
    const fetcher = async (url: string) => {
      const maxTs = new URL(url).searchParams.get("max_ts");
      return listensBody(
        maxTs === null
          ? page
          : page.filter((listen) => listen.listened_at < Number(maxTs)),
      );
    };
    const result = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(result.cursor).toBe(now - 100);
    expect(result.backfillBefore).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT cursor, backfill_before FROM sources WHERE id = 10",
      ).first<{ cursor: number | null; backfill_before: number | null }>(),
    ).toEqual({ cursor: now - 100, backfill_before: null });
  });

  it("continues backfill past a duplicate at one timestamp", async () => {
    await seedUser({ cursor: now, backfill_before: now - 1 });
    await storeListens(
      env.DB,
      [
        {
          kind: "listenbrainz",
          sourceKey: "stored",
          artist: "Stored Artist",
          title: "Stored Song",
          listenedAt: now - 100,
          userId: 1,
          sourceId: 10,
        },
      ],
      "listenbrainz",
    );
    const make = (index: number) => ({
      listened_at: now - 100 - index,
      track_metadata: {
        artist_name: `Artist ${index}`,
        track_name: `Song ${index}`,
        additional_info: {},
      },
    });
    let historicalPage = 0;
    const fetcher = async (url: string) => {
      const params = new URL(url).searchParams;
      if (!params.has("max_ts")) return listensBody([]);
      historicalPage += 1;
      const wanted = Number(params.get("count"));
      if (historicalPage === 1)
        return listensBody(
          Array.from({ length: wanted }, (_, index) => make(index)),
        );
      return listensBody([{ ...make(200), listened_at: now - 400 }]);
    };
    const first = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(first.inserted).toBe(199);
    expect(first.backfillBefore).toBe(now - 299);
    const second = await pullListenBrainz(
      env,
      await sourceRow(),
      fetcher,
      now + 60,
    );
    expect(second.inserted).toBe(1);
    expect(second.backfillBefore).toBeNull();
    expect(await count("plays")).toBe(201);
  });

  it("stops the gap walk at the old cursor", async () => {
    const cursor = now - 500;
    await seedUser({ cursor });
    const history = Array.from({ length: 450 }, (_, index) => ({
      listened_at: cursor - 50 + index,
      track_metadata: {
        artist_name: `Gap Artist ${index % 7}`,
        track_name: `Gap Song ${index % 11}`,
        additional_info: { recording_mbid: `gap-${index % 13}` },
      },
    }));
    await storeListens(
      env.DB,
      history
        .filter((listen) => listen.listened_at <= cursor)
        .map((listen) => ({
          kind: "listenbrainz",
          sourceKey:
            listen.track_metadata.additional_info.recording_mbid +
            "-" +
            listen.listened_at,
          artist: listen.track_metadata.artist_name,
          title: listen.track_metadata.track_name,
          mbid: listen.track_metadata.additional_info.recording_mbid,
          listenedAt: listen.listened_at,
          userId: 1,
          sourceId: 10,
        })),
      "listenbrainz",
    );
    const calls: number[] = [];
    let historicalCalls = 0;
    const fetcher = async (url: string) => {
      const params = new URL(url).searchParams;
      const count = Number(params.get("count"));
      const maxTs = params.has("max_ts")
        ? Number(params.get("max_ts"))
        : Number.MAX_SAFE_INTEGER;
      const minTs = params.has("min_ts") ? Number(params.get("min_ts")) : 0;
      if (params.has("max_ts")) {
        calls.push(maxTs);
        historicalCalls += 1;
      }
      const page = history
        .filter(
          (listen) =>
            listen.listened_at <= maxTs && listen.listened_at >= minTs,
        )
        .slice(-count);
      return listensBody(page);
    };
    let pullAt = now;
    for (let pull = 0; pull < 6; pull += 1) {
      await pullListenBrainz(env, await sourceRow(), fetcher, pullAt);
      const stored = await env.DB.prepare(
        "SELECT next_pull_at, gap_before FROM sources WHERE id = 10",
      ).first<{ next_pull_at: number; gap_before: number | null }>();
      pullAt = pullAt + 60;
      if (stored?.next_pull_at !== pullAt) break;
    }
    expect(calls.every((maxTs) => maxTs > cursor)).toBe(true);
    expect(await count("plays")).toBe(450);
    expect(historicalCalls).toBeLessThan(5);
    expect(
      await env.DB.prepare(
        "SELECT gap_before, backfill_before FROM sources WHERE id = 10",
      ).first<{ gap_before: number | null; backfill_before: number | null }>(),
    ).toEqual({ gap_before: null, backfill_before: null });
  });

  it("stores a full current page in one pull", async () => {
    await seedUser();
    const fetcher = async (url: string) => {
      const params = new URL(url).searchParams;
      if (params.has("max_ts")) return listensBody([]);
      const wanted = Number(params.get("count"));
      return listensBody(
        Array.from({ length: wanted }, (_, index) => ({
          listened_at: now - 300 + index,
          track_metadata: {
            artist_name: `Full Artist ${index % 5}`,
            track_name: `Full Song ${index % 9}`,
            additional_info: {},
          },
        })),
      );
    };
    const result = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(result.inserted).toBe(200);
    expect(await count("plays")).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT next_pull_at FROM sources WHERE id = 10",
      ).first<{ next_pull_at: number }>(),
    ).toEqual({ next_pull_at: now + 60 });
  });

  it("continues historical backfill past a stored play", async () => {
    await seedUser({ cursor: now, backfill_before: now - 1 });
    await storeListens(
      env.DB,
      [
        {
          kind: "listenbrainz",
          sourceKey: "stored",
          artist: "Stored Artist",
          title: "Stored Song",
          listenedAt: now - 100,
          userId: 1,
          sourceId: 10,
        },
      ],
      "listenbrainz",
    );
    const fetcher = async (url: string) =>
      new URL(url).searchParams.has("max_ts")
        ? listensBody([
            {
              listened_at: now - 100,
              track_metadata: {
                artist_name: "Stored Artist",
                track_name: "Stored Song",
                additional_info: {},
              },
            },
            {
              listened_at: now - 200,
              track_metadata: {
                artist_name: "Older Artist",
                track_name: "Older Song",
                additional_info: {},
              },
            },
          ])
        : listensBody([]);
    const result = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(result.inserted).toBe(1);
    expect(await count("plays")).toBe(2);
  });

  it("stores current listens after a duplicate in the page", async () => {
    await seedUser();
    await storeListens(
      env.DB,
      [
        {
          kind: "listenbrainz",
          sourceKey: "dup",
          artist: "Dup Artist",
          title: "Dup Song",
          listenedAt: now - 100,
          userId: 1,
          sourceId: 10,
        },
      ],
      "listenbrainz",
    );
    const page = [
      { at: now - 100, artist: "Dup Artist", title: "Dup Song" },
      { at: now - 50, artist: "New Artist", title: "New Song" },
      { at: now - 40, artist: "Newer Artist", title: "Newer Song" },
    ].map((listen) => ({
      listened_at: listen.at,
      track_metadata: {
        artist_name: listen.artist,
        track_name: listen.title,
        additional_info: {},
      },
    }));
    const fetcher = async (url: string) =>
      new URL(url).searchParams.has("max_ts")
        ? listensBody([])
        : listensBody(page);
    const result = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(result.inserted).toBe(2);
    expect(await count("plays")).toBe(3);
  });

  it("skips the history walk once the daily row tally reaches the cap", async () => {
    await seedUser({ cursor: now, backfill_before: now - 1 });
    await env.CACHE.put("backfill-rows", "50000");
    const current = listens.map((listen, index) => ({
      ...listen,
      listened_at: now - index,
    }));
    const fetcher = vi.fn(async (url: string) =>
      new URL(url).searchParams.has("max_ts")
        ? listensBody([listens[0]])
        : listensBody(current),
    );
    const result = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(result.inserted).toBe(current.length);
    const walkCalls = fetcher.mock.calls.filter(([url]) =>
      new URL(url).searchParams.has("max_ts"),
    );
    expect(walkCalls).toHaveLength(0);
    const stored = await env.DB.prepare(
      "SELECT next_pull_at, backfill_before FROM sources WHERE id = 10",
    ).first<{ next_pull_at: number; backfill_before: number | null }>();
    expect(stored).toEqual({
      next_pull_at: now + 15 * 60,
      backfill_before: now - 1,
    });
  });

  it("shares the daily backfill cap across sources", async () => {
    await seedUser({ cursor: now, backfill_before: now - 1 });
    await env.DB.prepare(
      "INSERT INTO users (github_id, name, created_at) VALUES (2, 'bob', ?1)",
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO sources (id, user_id, kind, account, cursor, backfill_before, next_pull_at)
         VALUES (20, 2, 'listenbrainz', 'bob-lb', ?1, ?2, ?3)`,
    )
      .bind(now, now - 500, now)
      .run();
    await env.CACHE.put("backfill-rows", "50000");
    const fetcher = vi.fn(async (_url: string) => listensBody(listens));
    const other = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 20",
    ).first<SourceRow>();
    const pulled = await pullListenBrainz(env, other!, fetcher, now);
    expect(pulled.inserted).toBe(listens.length);
    expect(await count("plays")).toBe(listens.length);
    const walkCalls = fetcher.mock.calls.filter(([url]) =>
      new URL(url).searchParams.has("max_ts"),
    );
    expect(walkCalls).toHaveLength(0);
    const stored = await env.DB.prepare(
      "SELECT backfill_before FROM sources WHERE id = 20",
    ).first<{ backfill_before: number | null }>();
    expect(stored?.backfill_before).toBe(now - 500);
  });

  it("does not touch the backfill tally for a source that is not backfilling", async () => {
    await seedUser({ cursor: now - 1000, backfill_before: null });
    const page = listens.slice(0, 3).map((listen, index) => ({
      ...listen,
      listened_at: now - index,
    }));
    const fetcher = async () => listensBody(page);
    const result = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(result.inserted).toBe(3);
    expect(await env.CACHE.get("backfill-rows")).toBeNull();
  });

  it("counts the walk's written rows toward the daily backfill tally", async () => {
    await seedUser({ cursor: now, backfill_before: now - 1 });
    const page = Array.from({ length: 200 }, (_, index) => ({
      listened_at: now - 100 - index,
      track_metadata: {
        artist_name: `Tally Artist ${index}`,
        track_name: `Tally Song ${index}`,
        additional_info: {},
      },
    }));
    const fetcher = async (url: string) =>
      new URL(url).searchParams.has("max_ts")
        ? listensBody(page)
        : listensBody([]);
    await pullListenBrainz(env, await sourceRow(), fetcher, now);
    const used = Number(await env.CACHE.get("backfill-rows"));
    expect(used).toBeGreaterThan(200 * 4);
    const keys = await env.CACHE.list();
    const midnight = Math.floor(now / 86400) * 86400 + 86400;
    expect(
      keys.keys.find((key) => key.name === "backfill-rows")?.expiration,
    ).toBe(midnight);
  });

  it("keeps pulling the current page while the backfill is capped", async () => {
    await seedUser({ cursor: now, backfill_before: now - 1 });
    await env.CACHE.put("backfill-rows", "60000");
    const page = listens.map((listen, index) => ({
      ...listen,
      listened_at: now - index,
    }));
    const fetcher = async () => listensBody(page);
    const result = await pullListenBrainz(env, await sourceRow(), fetcher, now);
    expect(result.inserted).toBe(page.length);
    expect(await count("plays")).toBe(page.length);
    const used = Number(await env.CACHE.get("backfill-rows"));
    expect(used).toBe(60000);
  });

  it("pulls only one due source in one tick", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 4)
       INSERT INTO users (id, github_id, name, created_at)
       SELECT n, n + 100, 'due-' || n, ?1 FROM numbers`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 4)
       INSERT INTO sources (id, user_id, kind, account, next_pull_at)
       SELECT n + 10, n, 'listenbrainz', 'due-' || n, ?1 FROM numbers`,
    )
      .bind(now)
      .run();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ payload: { listens: [] } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    await pullDueSources(env, now);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("persists exponential backoff after failed pulls", async () => {
    await seedUser();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ListenBrainz unavailable"),
    );
    let pullAt = now;
    const gaps = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await pullDueSources(env, pullAt);
      const source = await env.DB.prepare(
        "SELECT idle_pulls, next_pull_at FROM sources WHERE id = 10",
      ).first<{ idle_pulls: number; next_pull_at: number }>();
      expect(source?.idle_pulls).toBe(attempt);
      gaps.push((source?.next_pull_at ?? 0) - pullAt);
      pullAt = source?.next_pull_at ?? pullAt;
    }
    expect(gaps).toEqual([30 * 60, 60 * 60, 2 * 60 * 60]);
  });

  it("runs a due source through the Worker scheduled handler", async () => {
    await seedUser();
    const responseBody = JSON.stringify({
      payload: { listens: [listens[0]] },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(responseBody, {
          headers: { "content-type": "application/json" },
        }),
    );
    await worker.scheduled(
      {
        cron: "* * * * *",
        scheduledTime: now * 1000,
        noRetry: () => undefined,
      },
      env,
      { waitUntil: () => undefined } as unknown as ExecutionContext,
    );
    expect(await count("plays")).toBe(1);
    const source = await env.DB.prepare(
      "SELECT next_pull_at FROM sources WHERE id = 10",
    ).first<{ next_pull_at: number }>();
    expect((source?.next_pull_at ?? 0) - now).toBeGreaterThanOrEqual(15 * 60);
  });
});
