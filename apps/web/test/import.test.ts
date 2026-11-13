import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import { markDuplicates } from "../src/duplicates";
// @ts-expect-error the page parser is an untyped static asset
import { spotifyPlays, takeoutPlays } from "../public/import-parse.js";

const now = Math.floor(Date.now() / 1000);
const day = Math.floor(now / 86400) * 86400;
const noon = day + 43200;
const origin = "https://music.rising.sh";
const session = `sess_${"s".repeat(40)}`;

const testEnv = () => ({
  DB: env.DB,
  CACHE: env.CACHE,
  LASTFM_APPROVAL: "",
});

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function seedUser() {
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, name, created_at) VALUES (1, 1000, 'alice', ?1)",
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, 1, ?2)",
  )
    .bind(await sha256(session), now + 30 * 86400)
    .run();
}

async function seedCatalog() {
  await env.DB.prepare(
    "INSERT INTO artists (id, key, name) VALUES (1, 'artist', 'Artist')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO tracks (id, key, artist_id, title) VALUES (1, 'artisttitle', 1, 'Title')",
  ).run();
}

async function addSource(id: number, kind: string) {
  await env.DB.prepare(
    "INSERT INTO sources (id, user_id, kind) VALUES (?1, 1, ?2)",
  )
    .bind(id, kind)
    .run();
}

function post(path: string, body: unknown, overrides = testEnv()) {
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        cookie: `__Host-session=${session}`,
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify(body),
    }),
    overrides as never,
  );
}

async function count(table: string, where = "1 = 1") {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
  ).first<{ n: number }>();
  return row?.n ?? -1;
}

async function dupOf(sourceId: number, ref: string) {
  const row = await env.DB.prepare(
    "SELECT dup FROM plays WHERE user_id = 1 AND source_id = ?1 AND ref = ?2",
  )
    .bind(sourceId, ref)
    .first<{ dup: number }>();
  return row?.dup;
}

const trackUri = `spotify:track:${"a".repeat(22)}`;
const trackUri2 = `spotify:track:${"b".repeat(22)}`;

const spotifyRecords = [
  {
    ts: "2024-04-20T10:00:00Z",
    ms_played: 29999,
    spotify_track_uri: trackUri,
    master_metadata_track_name: "Song",
    master_metadata_album_artist_name: "Artist",
    incognito_mode: false,
  },
  {
    ts: "2024-04-20T10:05:00Z",
    ms_played: 30000,
    spotify_track_uri: trackUri,
    master_metadata_track_name: "Song",
    master_metadata_album_artist_name: "Artist",
    incognito_mode: false,
  },
  {
    ts: "2024-04-20T10:10:00Z",
    ms_played: 200000,
    spotify_track_uri: trackUri,
    master_metadata_track_name: "Song",
    master_metadata_album_artist_name: "Artist",
    incognito_mode: true,
  },
  {
    ts: "2024-04-20T10:15:00Z",
    ms_played: 60000,
    spotify_track_uri: null,
    spotify_episode_uri: "spotify:episode:abc",
    master_metadata_track_name: "Pod",
    master_metadata_album_artist_name: "Pod",
  },
  {
    ts: "2024-04-20T10:20:00Z",
    ms_played: 60000,
    spotify_track_uri: trackUri,
    master_metadata_track_name: null,
    master_metadata_album_artist_name: "Artist",
  },
  {
    ts: "2024-04-20T10:25:00Z",
    ms_played: 60000,
    spotify_track_uri: "spotify:local:xyz",
    master_metadata_track_name: "Local",
    master_metadata_album_artist_name: "Artist",
  },
  {
    ts: "2024-04-20T10:30:00Z",
    ms_played: 240000,
    spotify_track_uri: trackUri2,
    master_metadata_track_name: "Other",
    master_metadata_album_artist_name: "Other Artist",
  },
  {
    ts: "2024-04-20T11:00:00Z",
    ms_played: 180000,
    spotify_track_uri: trackUri,
    master_metadata_track_name: "Song",
    master_metadata_album_artist_name: "Artist",
  },
];

const takeoutRecords = [
  {
    header: "YouTube Music",
    title: "Watched Song A",
    titleUrl: "https://music.youtube.com/watch?v=videoid1",
    subtitles: [{ name: "Channel One" }],
    time: "2024-04-20T10:00:00.000Z",
  },
  {
    header: "YouTube Music",
    title: "Watched Song A",
    titleUrl: "https://music.youtube.com/watch?v=videoid1",
    subtitles: [{ name: "Channel One" }],
    time: "2024-04-20T10:10:00.000Z",
  },
  {
    header: "YouTube",
    title: "Watched Vlog",
    titleUrl: "https://www.youtube.com/watch?v=xyz",
    time: "2024-04-20T10:20:00.000Z",
  },
  {
    header: "YouTube Music",
    title: "Watched Gone",
    subtitles: [{ name: "Channel" }],
    time: "2024-04-20T10:30:00.000Z",
  },
  {
    header: "YouTube Music",
    title: "Watched Song B",
    titleUrl: "https://music.youtube.com/watch?v=videoid2",
    time: "2024-04-20T10:40:00.000Z",
  },
  {
    header: "YouTube Music",
    title: "Song C",
    titleUrl: "https://music.youtube.com/watch?v=videoid3",
    subtitles: [{ name: "Channel" }],
    time: "2024-04-20T10:50:00.000Z",
  },
];

async function expectTotalsRecount() {
  for (const table of ["track_totals", "daily_totals", "artist_totals"]) {
    const recount = await env.DB.prepare(
      table === "track_totals"
        ? `SELECT track_id AS k, COUNT(*) AS plays FROM plays
           WHERE user_id = 1 AND dup = 0 GROUP BY track_id`
        : table === "daily_totals"
          ? `SELECT played_at / 86400 AS k, COUNT(*) AS plays FROM plays
             WHERE user_id = 1 AND dup = 0 GROUP BY k`
          : `SELECT tracks.artist_id AS k, COUNT(*) AS plays
             FROM plays JOIN tracks ON tracks.id = plays.track_id
             WHERE plays.user_id = 1 AND plays.dup = 0
             GROUP BY tracks.artist_id`,
    ).all<{ k: number; plays: number }>();
    const stored = await env.DB.prepare(
      `SELECT ${table === "track_totals" ? "track_id" : table === "daily_totals" ? "day" : "artist_id"} AS k, plays
       FROM ${table} WHERE user_id = 1`,
    ).all<{ k: number; plays: number }>();
    expect(
      stored.results.sort((a, b) => a.k - b.k),
      table,
    ).toEqual(recount.results.sort((a, b) => a.k - b.k));
  }
}

async function postPlays(
  source: "spotify" | "ytmusic",
  plays: Array<{ at: number; id: string; artist: string; title: string }>,
) {
  const responses = [];
  for (let i = 0; i < plays.length; i += 100)
    responses.push(
      await post("/settings/import", {
        source,
        plays: plays.slice(i, i + 100),
      }),
    );
  return responses;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

describe("migration 0005", () => {
  it("rebuilds sources keeping every row and passes the foreign key check", async () => {
    await reset();
    const first = migrations.slice(0, -1);
    const last = migrations.slice(-1);
    await applyD1Migrations(env.DB, first);
    await env.DB.prepare(
      "INSERT INTO users (id, github_id, name, created_at) VALUES (1, 1, 'alice', ?1)",
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind, account) VALUES (5, 1, 'listenbrainz', 'rob'), (6, 1, 'ytmusic', NULL)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (6, ?1, 'abcd', ?2)",
    )
      .bind(await sha256("msu_token"), now)
      .run();
    await seedCatalog();
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, 5, 'r1', 1)",
    )
      .bind(now - 60)
      .run();
    await applyD1Migrations(env.DB, last);
    const check = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(check.results).toHaveLength(0);
    expect(await count("sources", "user_id = 1")).toBe(2);
    expect(await count("tokens")).toBe(1);
    expect(await count("plays")).toBe(1);
    const rebuilt = await env.DB.prepare(
      "INSERT INTO sources (user_id, kind) VALUES (1, 'spotify_import')",
    ).run();
    expect(rebuilt.meta.changes).toBe(1);
  });
});

describe("import of a Spotify extended history", () => {
  it("keeps three of eight records, stores them at ts minus ms_played, and a repost inserts nothing", async () => {
    await seedUser();
    const { plays, skips } = spotifyPlays(spotifyRecords);
    expect(plays).toHaveLength(3);
    expect([...skips.values()].reduce((a, b) => a + b, 0)).toBe(5);
    const responses = await postPlays("spotify", plays);
    const bodies = [];
    for (const response of responses) {
      expect(response.status).toBe(200);
      bodies.push(await response.json());
    }
    expect(bodies).toEqual([
      {
        received: 3,
        inserted: 3,
        duplicate: 0,
        used: expect.any(Number),
        limit: 50000,
      },
    ]);
    const stored = await env.DB.prepare(
      `SELECT played_at, ref FROM plays
       JOIN sources ON sources.id = plays.source_id
       WHERE sources.kind = 'spotify_import' ORDER BY played_at`,
    ).all<{ played_at: number; ref: string }>();
    expect(stored.results).toEqual([
      {
        played_at: Date.parse("2024-04-20T10:05:00Z") / 1000 - 30,
        ref: "a".repeat(22),
      },
      {
        played_at: Date.parse("2024-04-20T10:30:00Z") / 1000 - 240,
        ref: "b".repeat(22),
      },
      {
        played_at: Date.parse("2024-04-20T11:00:00Z") / 1000 - 180,
        ref: "a".repeat(22),
      },
    ]);
    expect(await count("track_totals", "user_id = 1")).toBe(2);
    expect(
      (
        await env.DB.prepare(
          "SELECT SUM(plays) AS s FROM daily_totals WHERE user_id = 1",
        ).first<{ s: number }>()
      )?.s,
    ).toBe(3);

    const again = await postPlays("spotify", plays);
    for (const response of again)
      expect(await response.json()).toMatchObject({ inserted: 0 });
    expect(await count("plays")).toBe(3);
  });
});

describe("import of a Takeout watch history", () => {
  it("keeps two of six records with the video id as ref, and a repost stores none", async () => {
    await seedUser();
    const { plays, skips } = takeoutPlays(takeoutRecords);
    expect(plays).toHaveLength(2);
    expect([...skips.values()].reduce((a, b) => a + b, 0)).toBe(4);
    const responses = await postPlays("ytmusic", plays);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        received: 2,
        inserted: 2,
        duplicate: 0,
      });
    }
    const stored = await env.DB.prepare(
      `SELECT played_at, ref FROM plays
       JOIN sources ON sources.id = plays.source_id
       WHERE sources.kind = 'ytmusic_import' ORDER BY played_at`,
    ).all<{ played_at: number; ref: string }>();
    expect(stored.results).toEqual([
      {
        played_at: Date.parse("2024-04-20T10:00:00.000Z") / 1000,
        ref: "videoid1",
      },
      {
        played_at: Date.parse("2024-04-20T10:10:00.000Z") / 1000,
        ref: "videoid1",
      },
    ]);

    const again = await postPlays("ytmusic", plays);
    for (const response of again)
      expect(await response.json()).toMatchObject({ inserted: 0 });
    expect(await count("plays")).toBe(2);
  });
});

describe("imports in cross-source duplicates", () => {
  it("marks the ListenBrainz play that a spotify_import play shadows", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(10, "listenbrainz");
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, 10, 'lb1', 1)",
    )
      .bind(noon)
      .run();
    const response = await post("/settings/import", {
      source: "spotify",
      plays: [
        {
          at: noon + 20,
          id: "a".repeat(22),
          artist: "Artist",
          title: "Title",
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(await dupOf(10, "lb1")).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
        ).first<{ plays: number }>()
      )?.plays,
    ).toBe(1);
  });

  it("marks the ytmusic push play of the same day that a ytmusic_import play shadows", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(11, "ytmusic");
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, 11, 'vid#1', 1)",
    )
      .bind(noon)
      .run();
    const response = await post("/settings/import", {
      source: "ytmusic",
      plays: [
        {
          at: day + 18 * 3600,
          id: "vid0",
          artist: "Artist",
          title: "Title",
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(await dupOf(11, "vid#1")).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
        ).first<{ plays: number }>()
      )?.plays,
    ).toBe(1);
  });

  it("keeps a ListenBrainz play and a ytmusic_import play three hours apart both counted", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(10, "listenbrainz");
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, 10, 'lb1', 1)",
    )
      .bind(noon)
      .run();
    const response = await post("/settings/import", {
      source: "ytmusic",
      plays: [
        { at: noon + 3 * 3600, id: "vid0", artist: "Artist", title: "Title" },
      ],
    });
    expect(response.status).toBe(200);
    const result = await markDuplicates(env.DB, 1, noon, noon + 3 * 3600);
    expect(result.marked).toBe(0);
    const imported = await env.DB.prepare(
      "SELECT id FROM sources WHERE kind = 'ytmusic_import'",
    ).first<{ id: number }>();
    expect(await dupOf(10, "lb1")).toBe(0);
    expect(await dupOf(imported!.id, "vid0")).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
        ).first<{ plays: number }>()
      )?.plays,
    ).toBe(2);
  });
});

describe("the backfill tally", () => {
  it("answers 429 with the seconds to midnight at the cap and stores a batch one row under it", async () => {
    await seedUser();
    await env.CACHE.put("backfill-rows", "50000");
    const play = {
      at: noon,
      id: "a".repeat(22),
      artist: "Artist",
      title: "Title",
    };
    const blocked = await post("/settings/import", {
      source: "spotify",
      plays: [play],
    });
    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    const received = Math.floor(Date.now() / 1000);
    const midnight = (Math.floor(received / 86400) + 1) * 86400;
    expect(retryAfter).toBeGreaterThanOrEqual(midnight - received - 2);
    expect(retryAfter).toBeLessThanOrEqual(midnight - received + 2);
    expect(await count("plays")).toBe(0);

    await env.CACHE.put("backfill-rows", "49999");
    const allowed = await post("/settings/import", {
      source: "spotify",
      plays: [play],
    });
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as {
      inserted: number;
      used: number;
    };
    expect(body.inserted).toBe(1);
    expect(body.used).toBeGreaterThan(49999);
    expect(Number(await env.CACHE.get("backfill-rows"))).toBe(body.used);
    expect(await count("plays")).toBe(1);
  });
});

describe("removing an import", () => {
  it("removes a 2,001-play source in two requests and leaves totals equal to a recount", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(20, "spotify_import");
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2001)
       INSERT INTO plays (user_id, played_at, source_id, ref, track_id)
       SELECT 1, ?1 - x, 20, 'ref' || x, 1 FROM n`,
    )
      .bind(noon)
      .run();
    await env.DB.prepare(
      "UPDATE sources SET play_count = 2001 WHERE id = 20",
    ).run();
    expect(await count("plays")).toBe(2001);

    const first = await post("/settings/import/remove", { source: "spotify" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      source: "spotify",
      removed: 2000,
      remaining: 1,
    });
    const second = await post("/settings/import/remove", { source: "spotify" });
    expect(await second.json()).toEqual({
      source: "spotify",
      removed: 1,
      remaining: 0,
    });
    expect(await count("plays")).toBe(0);
    expect(await count("sources", "kind = 'spotify_import'")).toBe(0);
    await expectTotalsRecount();
  });

  it("reopens a ListenBrainz play the removed import shadowed", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(10, "listenbrainz");
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, 10, 'lb1', 1)",
    )
      .bind(noon)
      .run();
    await post("/settings/import", {
      source: "spotify",
      plays: [
        {
          at: noon + 20,
          id: "a".repeat(22),
          artist: "Artist",
          title: "Title",
        },
      ],
    });
    expect(await dupOf(10, "lb1")).toBe(1);
    const response = await post("/settings/import/remove", {
      source: "spotify",
    });
    expect(await response.json()).toMatchObject({ remaining: 0 });
    expect(await dupOf(10, "lb1")).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
        ).first<{ plays: number }>()
      )?.plays,
    ).toBe(1);
    expect(await count("sources", "kind = 'spotify_import'")).toBe(0);
  });

  it.each(["ytmusic", "spotify"])(
    "reopens a ytmusic push play the removed %s import shadowed on its day",
    async (service) => {
      await seedUser();
      await seedCatalog();
      await addSource(11, "ytmusic");
      await env.DB.prepare(
        "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, 11, 'vid#1', 1)",
      )
        .bind(noon)
        .run();
      const imported = await post("/settings/import", {
        source: service,
        plays: [
          {
            at: day + 18 * 3600,
            id: service === "spotify" ? "a".repeat(22) : "vid0",
            artist: "Artist",
            title: "Title",
          },
        ],
      });
      expect(imported.status).toBe(200);
      expect(await dupOf(11, "vid#1")).toBe(1);
      const response = await post("/settings/import/remove", {
        source: service,
      });
      expect(await response.json()).toMatchObject({ remaining: 0 });
      expect(await dupOf(11, "vid#1")).toBe(0);
      await expectTotalsRecount();
      expect(
        (
          await env.DB.prepare(
            "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
          ).first<{ plays: number }>()
        )?.plays,
      ).toBe(1);
    },
  );

  it("keeps totals equal to a recount when a play is marked between the removal read and its batch", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(10, "listenbrainz");
    await addSource(20, "spotify_import");
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, 20, 'c1', 1)",
    )
      .bind(noon)
      .run();
    await env.DB.prepare(
      "UPDATE sources SET play_count = 1 WHERE id = 20",
    ).run();
    let marked = false;
    const db = env.DB;
    const original = db.batch.bind(db);
    (db as { batch: unknown }).batch = async <T = unknown>(
      stmts: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> => {
      if (!marked) {
        marked = true;
        await db
          .prepare(
            "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, 10, 'lb1', 1)",
          )
          .bind(noon + 20)
          .run();
        await db
          .prepare(
            "UPDATE plays SET dup = 1 WHERE user_id = 1 AND source_id = 10 AND ref = 'lb1'",
          )
          .run();
      }
      return original(stmts) as Promise<D1Result<T>[]>;
    };
    let response: Response;
    try {
      response = await post(
        "/settings/import/remove",
        { source: "spotify" },
        { DB: db as never, CACHE: env.CACHE, LASTFM_APPROVAL: "" },
      );
    } finally {
      (db as { batch: unknown }).batch = original;
    }
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ remaining: 0 });
    expect(await dupOf(10, "lb1")).toBe(0);
    await expectTotalsRecount();
  });

  it("leaves an unrelated dup = 1 play of another source marked", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(10, "lastfm");
    await addSource(20, "spotify_import");
    await env.DB.prepare(
      `INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES
       (1, ?1, 20, 'c1', 1), (1, ?1 + 2592000, 20, 'c2', 1), (1, ?1 + 1296000, 10, 'fm1', 1)`,
    )
      .bind(noon)
      .run();
    await env.DB.prepare(
      "UPDATE sources SET play_count = 2 WHERE id = 20",
    ).run();
    await env.DB.prepare(
      "UPDATE plays SET dup = 1 WHERE user_id = 1 AND source_id = 10 AND ref = 'fm1'",
    ).run();
    const response = await post("/settings/import/remove", {
      source: "spotify",
    });
    expect(await response.json()).toMatchObject({ remaining: 0 });
    expect(await dupOf(10, "fm1")).toBe(1);
    await expectTotalsRecount();
  });

  it("reads only the plays near the chunk when reopening", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(10, "lastfm");
    await addSource(20, "spotify_import");
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 20000)
       INSERT INTO plays (user_id, played_at, source_id, ref, track_id, dup)
       SELECT 1, ?1 + 2592000 + x, 10, 'far' || x, 1, 1 FROM n`,
    )
      .bind(noon)
      .run();
    await env.DB.prepare(
      `INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES
       (1, ?1, 20, 'c1', 1), (1, ?1 + 60, 20, 'c2', 1), (1, ?1 + 120, 20, 'c3', 1),
       (1, ?1 + 20, 10, 'fm1', 1), (1, ?1 + 80, 10, 'fm2', 1), (1, ?1 + 140, 10, 'fm3', 1)`,
    )
      .bind(noon)
      .run();
    await env.DB.prepare(
      "UPDATE sources SET play_count = 3 WHERE id = 20",
    ).run();
    await env.DB.prepare(
      "UPDATE plays SET dup = 1 WHERE user_id = 1 AND source_id = 10 AND ref LIKE 'fm%'",
    ).run();
    const db = env.DB;
    const original = db.batch.bind(db);
    let rowsRead = 0;
    (db as { batch: unknown }).batch = async <T = unknown>(
      stmts: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> => {
      const results = await original(stmts);
      rowsRead += results.reduce(
        (sum, result) => sum + (result.meta?.rows_read ?? 0),
        0,
      );
      return results as D1Result<T>[];
    };
    let response: Response;
    try {
      response = await post(
        "/settings/import/remove",
        { source: "spotify" },
        { DB: db as never, CACHE: env.CACHE, LASTFM_APPROVAL: "" },
      );
    } finally {
      (db as { batch: unknown }).batch = original;
    }
    expect(response.status).toBe(200);
    expect(rowsRead).toBeLessThan(10000);
    expect(await dupOf(10, "fm1")).toBe(0);
    expect(await dupOf(10, "fm3")).toBe(0);
    await expectTotalsRecount();
  });

  it("reads the totals decrease of a chunk in one pass", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(20, "spotify_import");
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1000)
       INSERT INTO tracks (id, key, artist_id, title)
       SELECT x + 1, 't' || x, 1, 't' || x FROM n`,
    ).run();
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 10000)
       INSERT INTO artists (id, key, name)
       SELECT x + 1, 'a' || x, 'a' || x FROM n`,
    ).run();
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < 40000)
       INSERT INTO tracks (id, key, artist_id, title)
       SELECT x + 2000, 'e' || x, x % 10000 + 2, 'e' || x FROM n`,
    ).run();
    await addSource(30, "lastfm");
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < 40000)
       INSERT INTO plays (user_id, played_at, source_id, ref, track_id)
       SELECT 1, ?1 + x, 30, 'e' || x, 2000 + x FROM n`,
    )
      .bind(day)
      .run();
    await env.DB.prepare(
      "UPDATE sources SET play_count = 2000 WHERE id = 20",
    ).run();
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000)
       INSERT INTO plays (user_id, played_at, source_id, ref, track_id)
       SELECT 1, ?1 + x * 600, 20, 'r' || x, 1 + x % 1000 FROM n`,
    )
      .bind(noon)
      .run();
    const db = env.DB;
    const original = db.batch.bind(db);
    let rowsRead = 0;
    let rowsWritten = 0;
    (db as { batch: unknown }).batch = async <T = unknown>(
      stmts: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> => {
      const results = await original(stmts);
      rowsRead += results.reduce(
        (sum, result) => sum + (result.meta?.rows_read ?? 0),
        0,
      );
      rowsWritten += results.reduce(
        (sum, result) => sum + (result.meta?.rows_written ?? 0),
        0,
      );
      return results as D1Result<T>[];
    };
    let response: Response;
    try {
      response = await post(
        "/settings/import/remove",
        { source: "spotify" },
        { DB: db as never, CACHE: env.CACHE, LASTFM_APPROVAL: "" },
      );
    } finally {
      (db as { batch: unknown }).batch = original;
    }
    expect(response.status).toBe(200);
    expect(rowsRead).toBeLessThan(50000);
    expect(rowsWritten).toBeLessThanOrEqual(11000);
    await expectTotalsRecount();
  });

  it("reads each day of push plays once when reopening", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(10, "ytmusic");
    await addSource(20, "spotify_import");
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1000)
       INSERT INTO tracks (id, key, artist_id, title)
       SELECT x + 1, 't' || x, 1, 't' || x FROM n`,
    ).run();
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < 1000)
       INSERT INTO plays (user_id, played_at, source_id, ref, track_id, dup)
       SELECT 1, ?1 + (x / 100) * 86400, 10, 'p' || x, 1 + x % 1000, 1 FROM n`,
    )
      .bind(noon)
      .run();
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < 2000)
       INSERT INTO plays (user_id, played_at, source_id, ref, track_id)
       SELECT 1, ?1 + x * 432, 20, 'r' || x, 1 + x % 1000 FROM n`,
    )
      .bind(day)
      .run();
    const db = env.DB;
    const original = db.batch.bind(db);
    let rowsRead = 0;
    let first = true;
    (db as { batch: unknown }).batch = async <T = unknown>(
      stmts: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> => {
      const results = await original(stmts);
      if (first) {
        first = false;
        rowsRead = results.reduce(
          (sum, result) => sum + (result.meta?.rows_read ?? 0),
          0,
        );
      }
      return results as D1Result<T>[];
    };
    let response: Response;
    try {
      response = await post(
        "/settings/import/remove",
        { source: "spotify" },
        { DB: db as never, CACHE: env.CACHE, LASTFM_APPROVAL: "" },
      );
    } finally {
      (db as { batch: unknown }).batch = original;
    }
    expect(response.status).toBe(200);
    expect(rowsRead).toBeLessThan(60000);
    expect(await dupOf(10, "p0")).toBe(0);
    expect(await dupOf(10, "p999")).toBe(0);
    await expectTotalsRecount();
  });

  it("reads only the chunk to answer remaining", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(20, "spotify_import");
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < 20000)
       INSERT INTO plays (user_id, played_at, source_id, ref, track_id)
       SELECT 1, ?1 + x * 60, 20, 'r' || x, 1 FROM n`,
    )
      .bind(day)
      .run();
    await env.DB.prepare(
      "UPDATE sources SET play_count = 20000 WHERE id = 20",
    ).run();
    const db = env.DB;
    const original = db.prepare.bind(db);
    let rowsRead = 0;
    const count = (result: D1Result) => {
      rowsRead += result.meta?.rows_read ?? 0;
      return result;
    };
    (db as { prepare: unknown }).prepare = (sql: string) => {
      const stmt = original(sql);
      const all = stmt.all.bind(stmt) as (
        ...args: unknown[]
      ) => Promise<D1Result>;
      const run = stmt.run.bind(stmt) as (
        ...args: unknown[]
      ) => Promise<D1Result>;
      (stmt as { all: unknown }).all = async (...args: unknown[]) =>
        count(await all(...args));
      (stmt as { first: unknown }).first = async (...args: unknown[]) =>
        count(await all(...args)).results[0] ?? null;
      (stmt as { run: unknown }).run = async (...args: unknown[]) =>
        count(await run(...args));
      return stmt;
    };
    let response: Response;
    try {
      response = await post(
        "/settings/import/remove",
        { source: "spotify" },
        { DB: db as never, CACHE: env.CACHE, LASTFM_APPROVAL: "" },
      );
    } finally {
      (db as { prepare: unknown }).prepare = original;
    }
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      removed: number;
      remaining: number;
    };
    expect(body.removed).toBe(2000);
    expect(body.remaining).toBe(18000);
    expect(rowsRead).toBeLessThan(5000);
  });

  it("answers 429 on a remove at the tally cap", async () => {
    await seedUser();
    await seedCatalog();
    await addSource(20, "spotify_import");
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, 20, 'r1', 1)",
    )
      .bind(noon)
      .run();
    await env.CACHE.put("backfill-rows", "50000");
    const response = await post("/settings/import/remove", {
      source: "spotify",
    });
    expect(response.status).toBe(429);
    expect(await count("plays")).toBe(1);
    expect(await count("sources", "kind = 'spotify_import'")).toBe(1);
  });
});

describe("the import body", () => {
  it("rejects a batch of 101 plays with 422 and stores nothing", async () => {
    await seedUser();
    const response = await post("/settings/import", {
      source: "spotify",
      plays: Array.from({ length: 101 }, (_, i) => ({
        at: noon - i,
        id: "a".repeat(22),
        artist: "Artist",
        title: "Title",
      })),
    });
    expect(response.status).toBe(422);
    expect(await count("plays")).toBe(0);
    expect(await count("sources")).toBe(0);
  });
});
