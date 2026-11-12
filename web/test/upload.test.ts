import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";

const now = Math.floor(Date.now() / 1000);
const day = (offset: number) =>
  new Date((now - offset * 86400) * 1000).toISOString().slice(0, 10);
const token = `msu_${"a".repeat(43)}`;

async function hash(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function seedUploadSource(sourceId = 10, userId = 1) {
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, name, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(userId, userId, `user-${userId}`, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sources (id, user_id, kind) VALUES (?1, ?2, 'ytmusic')",
  )
    .bind(sourceId, userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(sourceId, await hash(token), token.slice(-4), now)
    .run();
}

async function allowUpload(sourceId = 10) {
  await env.DB.prepare("UPDATE sources SET last_ok_at = NULL WHERE id = ?1")
    .bind(sourceId)
    .run();
}

function uploadBody(plays: Array<string | Record<string, unknown>>) {
  return JSON.stringify({
    client: "music-stats/0.4.0",
    plays: plays.map((item) =>
      typeof item === "string"
        ? {
            day: day(1),
            artist: `Artist ${item}`,
            title: `Title ${item}`,
            video_id: item,
          }
        : item,
    ),
  });
}

function post(
  body: string,
  init: { token?: string | null; headers?: Record<string, string> } = {},
) {
  return SELF.fetch(
    new Request("https://music.rising.sh/api/v1/upload", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(init.token === null
          ? {}
          : { authorization: `Bearer ${init.token ?? token}` }),
        ...init.headers,
      },
      body,
    }),
  );
}

async function playsCount(userId = 1) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM plays WHERE user_id = ?1",
  )
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function totals(userId = 1) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(plays), 0) AS total FROM track_totals WHERE user_id = ?1",
  )
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function sourceRow(sourceId = 10) {
  return env.DB.prepare("SELECT * FROM sources WHERE id = ?1")
    .bind(sourceId)
    .first<Record<string, unknown>>();
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

describe("upload API", () => {
  it("stores the overlap once and marks a page that shares nothing", async () => {
    await seedUploadSource();
    let response = await post(uploadBody(["c", "b", "a"]));
    expect(await response.json()).toEqual({
      received: 3,
      inserted: 3,
      duplicate: 0,
      gap: false,
      ambiguous: 0,
    });
    expect(await playsCount()).toBe(3);

    await allowUpload();
    response = await post(uploadBody(["x", "c", "b"]));
    expect(await response.json()).toEqual({
      received: 3,
      inserted: 1,
      duplicate: 2,
      gap: false,
      ambiguous: 0,
    });
    expect(await playsCount()).toBe(4);
    expect(await totals()).toBe(4);

    await allowUpload();
    response = await post(uploadBody(["x", "c", "b"]));
    expect(await response.json()).toMatchObject({ inserted: 0, ambiguous: 0 });
    expect(await playsCount()).toBe(4);

    await allowUpload();
    response = await post(uploadBody(["q", "r", "s"]));
    expect(await response.json()).toMatchObject({
      inserted: 3,
      gap: true,
      ambiguous: 0,
    });
    expect(await playsCount()).toBe(7);
    expect((await sourceRow())?.status).toBe("gap");
  });

  it("marks only the proven play when a page repeats one pair", async () => {
    await seedUploadSource();
    await post(uploadBody(["A", "A", "B"]));
    await allowUpload();
    let response = await post(uploadBody(["A", "A", "A"]));
    expect(await response.json()).toMatchObject({
      inserted: 1,
      ambiguous: 0,
    });
    expect(await playsCount()).toBe(4);

    await allowUpload();
    response = await post(uploadBody(["A", "A", "A"]));
    expect(await response.json()).toMatchObject({
      inserted: 0,
      ambiguous: 0,
    });
    expect(await playsCount()).toBe(4);
    expect((await sourceRow())?.maybe_missing).toBe(0);

    await allowUpload();
    response = await post(uploadBody(["A", "A", "A", "A"]));
    expect(await response.json()).toMatchObject({
      inserted: 1,
      ambiguous: 1,
    });
    expect(await playsCount()).toBe(5);
    expect((await sourceRow())?.maybe_missing).toBe(1);
  });

  it("counts exactly when a repeated pair grows by one", async () => {
    await seedUploadSource();
    await post(uploadBody(["A", "A"]));
    await allowUpload();
    const response = await post(uploadBody(["A", "A", "A"]));
    expect(await response.json()).toMatchObject({
      inserted: 1,
      ambiguous: 0,
    });
    expect(await playsCount()).toBe(3);
  });

  it("recovers from a gap when an upload overlaps again", async () => {
    await seedUploadSource();
    await post(uploadBody(["c", "b", "a"]));
    await allowUpload();
    await post(uploadBody(["q", "r", "s"]));
    expect((await sourceRow())?.status).toBe("gap");

    await allowUpload();
    const response = await post(uploadBody(["t", "q", "r"]));
    expect(await response.json()).toMatchObject({
      inserted: 1,
      gap: false,
    });
    expect(await playsCount()).toBe(7);
    expect((await sourceRow())?.status).toBe("active");
    expect((await sourceRow())?.gap_at).not.toBeNull();
  });

  it("stores each play at noon UTC with a sequence ref", async () => {
    await seedUploadSource();
    await post(uploadBody(["c", "b", "a"]));
    const rows = await env.DB.prepare(
      "SELECT played_at, ref FROM plays WHERE user_id = 1 ORDER BY played_at, ref",
    ).all<{ played_at: number; ref: string }>();
    expect(rows.results).toEqual([
      { played_at: Date.parse(`${day(1)}T12:00:00Z`) / 1000, ref: "a#1" },
      { played_at: Date.parse(`${day(1)}T12:00:00Z`) / 1000, ref: "b#2" },
      { played_at: Date.parse(`${day(1)}T12:00:00Z`) / 1000, ref: "c#3" },
    ]);
  });

  it("pins a video id to its first resolved track", async () => {
    await seedUploadSource();
    await post(uploadBody(["x", "c", "b"]));
    await allowUpload();
    await post(uploadBody(["q", "r", "s"]));
    await allowUpload();
    const response = await post(
      uploadBody([
        {
          day: day(2),
          artist: "Different Artist",
          title: "Different Title",
          video_id: "x",
        },
        "q",
        "r",
      ]),
    );
    expect(await response.json()).toMatchObject({ inserted: 1 });
    const plays = await env.DB.prepare(
      `SELECT plays.track_id FROM plays JOIN track_aliases
        ON track_aliases.track_id = plays.track_id
       WHERE track_aliases.kind = 'ytmusic' AND track_aliases.source_key = 'x'`,
    ).all<{ track_id: number }>();
    expect(new Set(plays.results.map((row) => row.track_id)).size).toBe(1);
  });

  it("writes a valid upload in one batch", async () => {
    await seedUploadSource();
    const batch = vi.spyOn(env.DB, "batch");
    const response = await app.fetch(
      new Request("https://music.rising.sh/api/v1/upload", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: uploadBody(["c", "b", "a"]),
      }),
      { DB: env.DB },
    );
    expect(response.status).toBe(200);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("does not write KV snapshots", async () => {
    await seedUploadSource();
    const cache = {
      get: vi.fn(),
      put: vi.fn(),
    } as unknown as KVNamespace;
    const response = await app.fetch(
      new Request("https://music.rising.sh/api/v1/upload", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: uploadBody(["c", "b", "a"]),
      }),
      { DB: env.DB, CACHE: cache },
    );
    expect(response.status).toBe(200);
    expect(cache.put).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it("accepts an empty page and changes nothing", async () => {
    await seedUploadSource();
    const response = await post(uploadBody([]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: 0,
      inserted: 0,
      duplicate: 0,
      gap: false,
      ambiguous: 0,
    });
    const source = await sourceRow();
    expect(source?.last_page).toBeNull();
    expect(source?.last_ok_at).toBeNull();
  });

  it("limits a source to one upload every 30 seconds", async () => {
    await seedUploadSource();
    await post(uploadBody(["c", "b", "a"]));
    const response = await post(uploadBody(["x", "c", "b"]));
    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(30);

    await env.DB.prepare("UPDATE sources SET last_ok_at = ?1 WHERE id = 10")
      .bind(now - 60)
      .run();
    const allowed = await post(uploadBody(["x", "c", "b"]));
    expect(allowed.status).toBe(200);
    const tokenRow = await env.DB.prepare(
      "SELECT last_used_at FROM tokens WHERE source_id = 10",
    ).first<{ last_used_at: number | null }>();
    expect(tokenRow?.last_used_at).not.toBeNull();
  });

  it("answers 409 when another upload landed first", async () => {
    await seedUploadSource();
    let raced = false;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property !== "batch") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await target
              .prepare(
                "UPDATE sources SET play_seq = play_seq + 1 WHERE id = 10",
              )
              .run();
          }
          return target.batch(statements);
        };
      },
    });
    const response = await app.fetch(
      new Request("https://music.rising.sh/api/v1/upload", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: uploadBody(["c", "b", "a"]),
      }),
      { DB: db },
    );
    expect(response.status).toBe(409);
    expect(await playsCount()).toBe(0);
  });

  it.each([
    {
      name: "missing Authorization header",
      init: { token: null },
    },
    {
      name: "a token with the wrong shape",
      init: { token: "msu_tooshort" },
    },
    {
      name: "an unknown token",
      init: { token: `msu_${"z".repeat(43)}` },
    },
    {
      name: "a revoked token",
      init: { token: `msu_${"r".repeat(43)}`, revoke: true },
    },
  ])("returns 401 for $name", async ({ init }) => {
    await seedUploadSource();
    if (init.revoke) {
      await env.DB.prepare(
        "UPDATE tokens SET hash = ?1, revoked_at = ?2 WHERE source_id = 10",
      )
        .bind(await hash(`msu_${"r".repeat(43)}`), now)
        .run();
    }
    const response = await post(uploadBody(["a"]), init);
    expect(response.status).toBe(401);
  });

  it.each<{ name: string; headers: Record<string, string> }>([
    {
      name: "a wrong Content-Type",
      headers: { "content-type": "text/plain" },
    },
    {
      name: "a Content-Encoding",
      headers: { "content-encoding": "gzip" },
    },
  ])("returns 415 for $name", async ({ headers }) => {
    await seedUploadSource();
    const response = await post(uploadBody(["a"]), { headers });
    expect(response.status).toBe(415);
  });

  it("returns 413 for a declared Content-Length over 256 KiB", async () => {
    await seedUploadSource();
    const response = await post(
      JSON.stringify({ plays: [], pad: "x".repeat(256 * 1024) }),
    );
    expect(response.status).toBe(413);
  });

  it("returns 413 for a chunked body over 256 KiB", async () => {
    await seedUploadSource();
    const response = await SELF.fetch(
      new Request("https://music.rising.sh/api/v1/upload", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(64 * 1024));
          },
        }),
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
  });

  it.each([
    {
      name: "a body that is not JSON",
      body: "not json",
      indexes: [],
    },
    {
      name: "an unknown top-level field",
      body: JSON.stringify({ plays: [], extra: true }),
      indexes: [],
    },
    {
      name: "plays that is not an array",
      body: JSON.stringify({ plays: "abc" }),
      indexes: [],
    },
    {
      name: "more than 1000 plays",
      body: uploadBody(Array.from({ length: 1001 }, (_, index) => `v${index}`)),
      indexes: [],
    },
    {
      name: "a play with an unknown field",
      body: JSON.stringify({
        plays: [
          { day: day(1), artist: "A", title: "T", video_id: "v", extra: 1 },
        ],
      }),
      indexes: [0],
    },
    {
      name: "a play that is not an object",
      body: JSON.stringify({
        plays: [{ day: day(1), artist: "A", title: "T", video_id: "v" }, 42],
      }),
      indexes: [1],
    },
    {
      name: "a day before 2005",
      body: JSON.stringify({
        plays: [{ day: "2004-12-31", artist: "A", title: "T", video_id: "v" }],
      }),
      indexes: [0],
    },
    {
      name: "a day that is not a real date",
      body: JSON.stringify({
        plays: [{ day: "2026-02-30", artist: "A", title: "T", video_id: "v" }],
      }),
      indexes: [0],
    },
    {
      name: "a day after tomorrow",
      body: JSON.stringify({
        plays: [
          {
            day: new Date((now + 2 * 86400) * 1000).toISOString().slice(0, 10),
            artist: "A",
            title: "T",
            video_id: "v",
          },
        ],
      }),
      indexes: [0],
    },
    {
      name: "an empty artist",
      body: JSON.stringify({
        plays: [{ day: day(1), artist: "", title: "T", video_id: "v" }],
      }),
      indexes: [0],
    },
    {
      name: "a video id with bad characters",
      body: JSON.stringify({
        plays: [{ day: day(1), artist: "A", title: "T", video_id: "bad id!" }],
      }),
      indexes: [0],
    },
    {
      name: "several bad items",
      body: JSON.stringify({
        plays: [
          { day: "bad", artist: "A", title: "T", video_id: "v" },
          { day: day(1), artist: "A", title: "T", video_id: "v" },
          { day: day(1), artist: "A", title: "T" },
        ],
      }),
      indexes: [0, 2],
    },
  ])("returns 422 for $name", async ({ body, indexes }) => {
    await seedUploadSource();
    const response = await post(body);
    expect(response.status).toBe(422);
    const reply = await response.json<any>();
    expect(reply.errors.map((item: { index: number }) => item.index)).toEqual(
      indexes,
    );
    expect(await playsCount()).toBe(0);
  });

  it("accepts a Content-Type with parameters and tomorrow's day", async () => {
    await seedUploadSource();
    const response = await post(
      JSON.stringify({
        plays: [
          {
            day: new Date((now + 86400) * 1000).toISOString().slice(0, 10),
            artist: "A",
            title: "T",
            video_id: "v",
          },
        ],
      }),
      { headers: { "content-type": "application/json; charset=utf-8" } },
    );
    expect(response.status).toBe(200);
  });
});
