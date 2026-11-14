import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migrations from "virtual:web-migrations";

const now = Math.floor(Date.now() / 1000);
const token = `msu_${"b".repeat(43)}`;
const ytToken = `msu_${"y".repeat(43)}`;
const origin = "https://music.rising.sh";

async function hash(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function seed(userId = 1) {
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, name, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(userId, userId, `user-${userId}`, now)
    .run();
}

async function seedScrobbler(userId = 1, sourceId = 20, value = token) {
  await env.DB.prepare(
    "INSERT INTO sources (id, user_id, kind) VALUES (?1, ?2, 'listenbrainz')",
  )
    .bind(sourceId, userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(sourceId, await hash(value), value.slice(-4), now)
    .run();
}

async function seedYtmusic(userId = 1, sourceId = 10) {
  await env.DB.prepare(
    "INSERT INTO sources (id, user_id, kind) VALUES (?1, ?2, 'ytmusic')",
  )
    .bind(sourceId, userId)
    .run();
  await env.DB.prepare(
    "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(sourceId, await hash(ytToken), ytToken.slice(-4), now)
    .run();
}

function listen(at: number, artist = "Artist", title = "Title", extra = {}) {
  return {
    listened_at: at,
    track_metadata: {
      artist_name: artist,
      track_name: title,
      ...extra,
    },
  };
}

function submit(
  body: unknown,
  init: {
    token?: string | null;
    path?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return SELF.fetch(
    new Request(`${origin}${init.path ?? "/1/submit-listens"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(init.token === null
          ? {}
          : { authorization: `Token ${init.token ?? token}` }),
        ...init.headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function validate(init: { token?: string | null } = {}) {
  return SELF.fetch(
    new Request(`${origin}/1/validate-token`, {
      headers:
        init.token === null
          ? {}
          : { authorization: `Token ${init.token ?? token}` },
    }),
  );
}

async function distinctTracks(userId: number) {
  const row = await env.DB.prepare(
    "SELECT COUNT(DISTINCT track_id) AS count FROM plays WHERE user_id = ?1",
  )
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function playsCount(userId = 1) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM plays WHERE user_id = ?1",
  )
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

describe("submit-listens", () => {
  it("stores a single listen once, even when sent twice", async () => {
    await seed();
    await seedScrobbler();
    const body = {
      listen_type: "single",
      payload: [listen(now - 60, "Radiohead", "Weird Fishes")],
    };
    let response = await submit(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(await playsCount()).toBe(1);

    response = await submit(body);
    expect(response.status).toBe(200);
    expect(await playsCount()).toBe(1);

    const row = await env.DB.prepare(
      "SELECT played_at, ref FROM plays WHERE user_id = 1",
    ).first<{ played_at: number; ref: string }>();
    expect(row?.played_at).toBe(now - 60);
    expect(row?.ref).toBe("");
  });

  it("stores every listen of an import", async () => {
    await seed();
    await seedScrobbler();
    const response = await submit({
      listen_type: "import",
      payload: [
        listen(now - 300, "A", "One"),
        listen(now - 200, "B", "Two"),
        listen(now - 100, "C", "Three"),
      ],
    });
    expect(response.status).toBe(200);
    expect(await playsCount()).toBe(3);
  });

  it("accepts playing_now and stores nothing", async () => {
    await seed();
    await seedScrobbler();
    const response = await submit(
      {
        listen_type: "playing_now",
        payload: [{ track_metadata: { artist_name: "A", track_name: "T" } }],
      },
      { path: "/1/submit-listens?return_msid=true" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(await playsCount()).toBe(0);
    const used = await env.DB.prepare(
      "SELECT last_used_at FROM tokens WHERE source_id = 20",
    ).first<{ last_used_at: number | null }>();
    expect(used?.last_used_at).not.toBeNull();
  });

  it("also answers the routes under /1/1", async () => {
    await seed();
    await seedScrobbler();
    const response = await submit(
      { listen_type: "single", payload: [listen(now - 60)] },
      { path: "/1/1/submit-listens" },
    );
    expect(response.status).toBe(200);
    const check = await SELF.fetch(
      new Request(`${origin}/1/1/validate-token`, {
        headers: { authorization: `Token ${token}` },
      }),
    );
    expect((await check.json<{ valid: boolean }>()).valid).toBe(true);
  });

  it("marks a YouTube Music play of the same track on the same day as duplicate", async () => {
    await seed();
    await seedYtmusic();
    await seedScrobbler();
    const upload = {
      plays: [
        {
          day: new Date(now * 1000).toISOString().slice(0, 10),
          artist: "Radiohead",
          title: "Weird Fishes",
          video_id: "rSvTmvpx0JI",
        },
      ],
    };
    const uploadResponse = await SELF.fetch(
      new Request(`${origin}/api/v1/upload`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ytToken}`,
        },
        body: JSON.stringify(upload),
      }),
    );
    expect(uploadResponse.status).toBe(200);

    const response = await submit({
      listen_type: "single",
      payload: [listen(now - 30, "Radiohead", "Weird Fishes")],
    });
    expect(response.status).toBe(200);

    const rows = await env.DB.prepare(
      `SELECT sources.kind, plays.dup FROM plays
       JOIN sources ON sources.id = plays.source_id ORDER BY sources.kind`,
    ).all<{ kind: string; dup: number }>();
    expect(rows.results).toEqual([
      { kind: "listenbrainz", dup: 0 },
      { kind: "ytmusic", dup: 1 },
    ]);
  });

  it.each([
    { name: "a missing", init: { token: null } },
    { name: "an unknown", init: { token: `msu_${"z".repeat(43)}` } },
    { name: "a ytmusic", init: { token: ytToken, yt: true } },
    {
      name: "a revoked",
      init: { token: `msu_${"r".repeat(43)}`, revoke: true },
    },
  ])("returns 401 for $name token", async ({ init }) => {
    await seed();
    await seedScrobbler();
    if (init.yt) await seedYtmusic();
    if (init.revoke) {
      await env.DB.prepare(
        "UPDATE tokens SET hash = ?1, revoked_at = ?2 WHERE source_id = 20",
      )
        .bind(await hash(init.token!), now)
        .run();
    }
    const response = await submit(
      { listen_type: "single", payload: [listen(now - 60)] },
      init,
    );
    expect(response.status).toBe(401);
    expect((await response.json<{ code: number }>()).code).toBe(401);
    expect(await playsCount()).toBe(0);
  });

  it("a scrobbler token is not valid on the upload route", async () => {
    await seed();
    await seedScrobbler();
    const response = await SELF.fetch(
      new Request(`${origin}/api/v1/upload`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plays: [] }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it.each([
    {
      name: "not JSON",
      body: "not json",
    },
    {
      name: "a bad listen_type",
      body: { listen_type: "bogus", payload: [listen(now - 60)] },
    },
    {
      name: "an empty payload",
      body: { listen_type: "import", payload: [] },
    },
    {
      name: "over 1000 listens",
      body: {
        listen_type: "import",
        payload: Array.from({ length: 1001 }, (_, i) => listen(now - i)),
      },
    },
    {
      name: "a listened_at before 2005",
      body: { listen_type: "single", payload: [listen(946684799)] },
    },
    {
      name: "a listened_at over a day ahead",
      body: { listen_type: "single", payload: [listen(now + 2 * 86400)] },
    },
    {
      name: "a field over 512 characters",
      body: {
        listen_type: "single",
        payload: [listen(now - 60, "x".repeat(513))],
      },
    },
    {
      name: "a single with two listens",
      body: {
        listen_type: "single",
        payload: [listen(now - 60), listen(now - 30)],
      },
    },
    {
      name: "a missing listened_at",
      body: {
        listen_type: "import",
        payload: [{ track_metadata: { artist_name: "A", track_name: "T" } }],
      },
    },
  ])("returns 400 for $name", async ({ body }) => {
    await seed();
    await seedScrobbler();
    const response = await submit(body);
    expect(response.status).toBe(400);
    const reply = await response.json<{ code: number; error: string }>();
    expect(reply.code).toBe(400);
    expect(typeof reply.error).toBe("string");
    expect(await playsCount()).toBe(0);
  });

  it.each([
    {
      name: "plain concatenation",
      pairs: [
        ["AB", "C"],
        ["A", "BC"],
      ],
    },
    {
      name: "unit-separator placement",
      pairs: [
        ["A\x1fB", "C"],
        ["A", "B\x1fC"],
      ],
    },
  ])(
    "stores pairs that concatenate alike as distinct tracks: $name",
    async ({ pairs }) => {
      await seed();
      await seedScrobbler();
      for (let i = 0; i < pairs.length; i++) {
        const response = await submit({
          listen_type: "single",
          payload: [listen(now - 100 + i, pairs[i][0], pairs[i][1])],
        });
        expect(response.status).toBe(200);
      }
      expect(await playsCount()).toBe(2);
      expect(await distinctTracks(1)).toBe(2);
    },
  );

  it("does not let a client-supplied mbid pin another user's track", async () => {
    await seed(1);
    await seedScrobbler(1, 20, token);
    await seed(2);
    const token2 = `msu_${"c".repeat(43)}`;
    await seedScrobbler(2, 30, token2);
    const meta = {
      additional_info: {
        recording_mbid: "550e8400-e29b-41d4-a716-446655440000",
      },
    };
    const first = await submit({
      listen_type: "single",
      payload: [listen(now - 60, "Alpha", "First", meta)],
    });
    const second = await submit(
      {
        listen_type: "single",
        payload: [listen(now - 50, "Beta", "Second", meta)],
      },
      { token: token2 },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const rows = await env.DB.prepare(
      "SELECT user_id, track_id FROM plays ORDER BY user_id",
    ).all<{ user_id: number; track_id: number }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].track_id).not.toBe(rows.results[1].track_id);
  });

  it("drops a malformed mbid or isrc and still stores the listen", async () => {
    await seed();
    await seedScrobbler();
    const cases: Array<Record<string, unknown>> = [
      { recording_mbid: "not-a-real-mbid", isrc: "XX" },
      { recording_mbid: "x".repeat(600) },
      { recording_mbid: null },
      { isrc: 12 },
    ];
    for (let i = 0; i < cases.length; i++) {
      const response = await submit({
        listen_type: "single",
        payload: [
          listen(now - 60 + i, "A", "T", { additional_info: cases[i] }),
        ],
      });
      expect(response.status).toBe(200);
    }
    const nullInfo = await submit({
      listen_type: "single",
      payload: [listen(now - 50, "A", "T", { additional_info: null })],
    });
    expect(nullInfo.status).toBe(200);
    const dropped = await env.DB.prepare(
      `SELECT t.mbid, t.isrc FROM plays
       JOIN tracks t ON t.id = plays.track_id WHERE plays.user_id = 1`,
    ).all<{ mbid: string | null; isrc: string | null }>();
    expect(dropped.results).toHaveLength(5);
    for (const row of dropped.results) {
      expect(row.mbid).toBeNull();
      expect(row.isrc).toBeNull();
    }

    const good = await submit({
      listen_type: "single",
      payload: [
        listen(now - 40, "B", "T2", {
          additional_info: {
            recording_mbid: "550e8400-e29b-41d4-a716-446655440000",
            isrc: "USRC17607839",
          },
        }),
      ],
    });
    expect(good.status).toBe(200);
    const kept = await env.DB.prepare(
      `SELECT t.mbid, t.isrc FROM plays
       JOIN tracks t ON t.id = plays.track_id
       WHERE plays.user_id = 1 AND t.mbid IS NOT NULL`,
    ).first<{ mbid: string | null; isrc: string | null }>();
    expect(kept?.mbid).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(kept?.isrc).toBe("USRC17607839");
  });

  it("returns 404 JSON for an unimplemented ListenBrainz route", async () => {
    await seed();
    await seedScrobbler();
    const response = await SELF.fetch(
      new Request(`${origin}/1/user/user-1/listen-count`, {
        headers: { authorization: `Token ${token}` },
      }),
    );
    expect(response.status).toBe(404);
    expect((await response.json<{ code: number }>()).code).toBe(404);
  });
});

describe("validate-token", () => {
  it("answers valid with the profile name for a good token", async () => {
    await seed();
    await seedScrobbler();
    const response = await validate();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      code: 200,
      message: "Token valid.",
      user_name: "user-1",
      valid: true,
    });
  });

  it.each([
    { name: "a missing", init: { token: null } },
    { name: "an unknown", init: { token: `msu_${"z".repeat(43)}` } },
    { name: "a ytmusic", init: { token: ytToken, yt: true } },
  ])("answers invalid for $name token", async ({ init }) => {
    await seed();
    await seedScrobbler();
    if (init.yt) await seedYtmusic();
    const response = await validate(init);
    expect(response.status).toBe(401);
    expect((await response.json<{ valid: boolean }>()).valid).toBe(false);
  });
});
