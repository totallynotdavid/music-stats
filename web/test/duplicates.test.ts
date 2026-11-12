import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import { markDuplicates } from "../src/duplicates";
import { pullLastFm } from "../src/lastfm";
import { pullListenBrainz } from "../src/listenbrainz";
import type { SourceRow } from "../src/types";

const now = Math.floor(Date.now() / 1000);
const dayText = new Date((now - 86400) * 1000).toISOString().slice(0, 10);
const noon = Date.parse(`${dayText}T12:00:00.000Z`) / 1000;
const daySeconds = 86400;
const token = `msu_${"a".repeat(43)}`;

const sourceIds: Record<string, number> = {
  spotify: 1,
  listenbrainz: 2,
  lastfm: 3,
  ytmusic: 4,
};

interface SeedPlay {
  kind: keyof typeof sourceIds;
  at: number;
  track?: number;
  ref?: string;
}

async function seedUser(kinds: string[]) {
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, name, created_at) VALUES (1, 1, 'alice', ?1)",
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    "INSERT INTO artists (id, key, name) VALUES (1, 'artistone', 'Artist One'), (2, 'artisttwo', 'Artist Two')",
  ).run();
  await env.DB.prepare(
    `INSERT INTO tracks (id, key, artist_id, title)
     VALUES (1, 'artistone\u001fsonga', 1, 'Song A'),
            (2, 'artisttwo\u001fsongb', 2, 'Song B')`,
  ).run();
  for (const kind of kinds)
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind, account) VALUES (?1, 1, ?2, ?3)",
    )
      .bind(sourceIds[kind], kind, kind === "ytmusic" ? null : `alice-${kind}`)
      .run();
}

async function seedPlays(plays: SeedPlay[]) {
  for (const [index, play] of plays.entries())
    await env.DB.prepare(
      `INSERT INTO plays (user_id, played_at, source_id, ref, track_id)
       VALUES (1, ?1, ?2, ?3, ?4)`,
    )
      .bind(
        play.at,
        sourceIds[play.kind],
        play.ref ?? `p${index}`,
        play.track ?? 1,
      )
      .run();
}

async function dupByRef() {
  const rows = await env.DB.prepare(
    "SELECT ref, dup FROM plays WHERE user_id = 1",
  ).all<{ ref: string; dup: number }>();
  return new Map(rows.results.map((row) => [row.ref, row.dup]));
}

async function hash(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function sourceRow(kind: string) {
  const row = await env.DB.prepare("SELECT * FROM sources WHERE id = ?1")
    .bind(sourceIds[kind])
    .first<SourceRow>();
  return row!;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

describe("markDuplicates", () => {
  it.each<{
    name: string;
    kinds: string[];
    plays: Array<SeedPlay & { dup: number }>;
    from: number;
    to: number;
    totals?: number;
  }>([
    {
      name: "pairs within the ten-minute window and not past it",
      kinds: ["listenbrainz", "lastfm"],
      plays: [
        { kind: "listenbrainz", at: noon, dup: 0 },
        { kind: "listenbrainz", at: noon + 1200, dup: 0 },
        { kind: "lastfm", at: noon - 600, dup: 1 },
        { kind: "lastfm", at: noon - 601, dup: 0 },
        { kind: "lastfm", at: noon + 1800, dup: 1 },
        { kind: "lastfm", at: noon + 1801, dup: 0 },
      ],
      from: noon - 601,
      to: noon + 1801,
    },
    {
      name: "pairs each YouTube play once across two better sources",
      kinds: ["listenbrainz", "lastfm", "ytmusic"],
      plays: [
        { kind: "lastfm", at: noon - 14400, dup: 0 },
        { kind: "listenbrainz", at: noon + 28800, dup: 0 },
        { kind: "ytmusic", at: noon, ref: "y1", dup: 1 },
        { kind: "ytmusic", at: noon, ref: "y2", dup: 1 },
      ],
      from: noon - 14400,
      to: noon + 28800,
      totals: 2,
    },
    {
      name: "pairs a repeat when the nearest partner would strand a play",
      kinds: ["listenbrainz", "lastfm"],
      plays: [
        { kind: "listenbrainz", at: noon, ref: "l1", dup: 0 },
        { kind: "listenbrainz", at: noon + 590, ref: "l2", dup: 0 },
        { kind: "lastfm", at: noon + 300, ref: "f1", dup: 1 },
        { kind: "lastfm", at: noon + 1150, ref: "f2", dup: 1 },
      ],
      from: noon,
      to: noon + 1150,
      totals: 2,
    },
    {
      name: "keeps plays of other tracks counted at the same time",
      kinds: ["listenbrainz", "lastfm"],
      plays: [
        { kind: "listenbrainz", at: noon, track: 1, dup: 0 },
        { kind: "lastfm", at: noon, track: 2, dup: 0 },
      ],
      from: noon,
      to: noon,
    },
    {
      name: "never pairs two plays of one source",
      kinds: ["listenbrainz"],
      plays: [
        { kind: "listenbrainz", at: noon, dup: 0 },
        { kind: "listenbrainz", at: noon + 5, dup: 0 },
      ],
      from: noon,
      to: noon + 5,
    },
    {
      name: "pairs a track on repeat play by play",
      kinds: ["listenbrainz", "lastfm"],
      plays: [
        { kind: "listenbrainz", at: noon - 400, dup: 0 },
        { kind: "listenbrainz", at: noon, dup: 0 },
        { kind: "listenbrainz", at: noon + 400, dup: 0 },
        { kind: "lastfm", at: noon - 395, dup: 1 },
        { kind: "lastfm", at: noon + 5, dup: 1 },
        { kind: "lastfm", at: noon + 405, dup: 1 },
        { kind: "lastfm", at: noon + 800, dup: 0 },
      ],
      from: noon - 400,
      to: noon + 800,
    },
    {
      name: "pairs each play with the nearest unpaired play",
      kinds: ["listenbrainz", "lastfm"],
      plays: [
        { kind: "listenbrainz", at: noon, dup: 0 },
        { kind: "lastfm", at: noon + 9, dup: 1 },
        { kind: "lastfm", at: noon + 10, dup: 0 },
      ],
      from: noon,
      to: noon + 10,
    },
    {
      name: "pairs a YouTube play with a play on the same UTC day only",
      kinds: ["listenbrainz", "ytmusic"],
      plays: [
        { kind: "listenbrainz", at: noon - 43200, dup: 0 },
        { kind: "listenbrainz", at: noon + 43199, dup: 0 },
        { kind: "listenbrainz", at: noon + 43200, dup: 0 },
        { kind: "ytmusic", at: noon, ref: "y1", dup: 1 },
        { kind: "ytmusic", at: noon, ref: "y2", dup: 1 },
      ],
      from: noon,
      to: noon,
    },
    {
      name: "marks the YouTube play when Last.fm is the other source",
      kinds: ["lastfm", "ytmusic"],
      plays: [
        { kind: "lastfm", at: noon - 3600, dup: 0 },
        { kind: "ytmusic", at: noon, dup: 1 },
      ],
      from: noon,
      to: noon,
    },
    {
      name: "marks two of three sources for one play",
      kinds: ["listenbrainz", "lastfm", "ytmusic"],
      plays: [
        { kind: "listenbrainz", at: noon - 60, dup: 0 },
        { kind: "lastfm", at: noon - 55, dup: 1 },
        { kind: "ytmusic", at: noon, dup: 1 },
      ],
      from: noon - 60,
      to: noon,
    },
  ])("$name", async ({ kinds, plays, from, to, totals }) => {
    await seedUser(kinds);
    await seedPlays(plays);
    const result = await markDuplicates(env.DB, 1, from, to);
    const flags = await dupByRef();
    for (const [index, play] of plays.entries())
      expect(flags.get(play.ref ?? `p${index}`), `play ${index}`).toBe(
        play.dup,
      );
    expect(result.marked).toBe(plays.filter((play) => play.dup === 1).length);
    if (totals !== undefined) {
      const row = await env.DB.prepare(
        "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
      ).first<{ plays: number }>();
      expect(row?.plays).toBe(totals);
    }
  });

  it.each([
    ["spotify", "listenbrainz"],
    ["spotify", "lastfm"],
    ["spotify", "ytmusic"],
    ["listenbrainz", "lastfm"],
    ["listenbrainz", "ytmusic"],
    ["lastfm", "ytmusic"],
  ])(
    "keeps the %s play counted and marks the %s play",
    async (better, worse) => {
      await seedUser([better, worse]);
      await seedPlays([
        { kind: better as SeedPlay["kind"], at: noon, ref: "winner" },
        { kind: worse as SeedPlay["kind"], at: noon, ref: "loser" },
      ]);
      await markDuplicates(env.DB, 1, noon, noon);
      const flags = await dupByRef();
      expect(flags.get("winner")).toBe(0);
      expect(flags.get("loser")).toBe(1);
    },
  );

  it("marks an older row when the better source arrives later", async () => {
    await seedUser(["listenbrainz", "lastfm"]);
    await seedPlays([{ kind: "lastfm", at: noon, ref: "old" }]);
    const first = await markDuplicates(env.DB, 1, noon, noon);
    expect(first.marked).toBe(0);
    await seedPlays([{ kind: "listenbrainz", at: noon + 60, ref: "new" }]);
    const second = await markDuplicates(env.DB, 1, noon + 60, noon + 60);
    expect(second.marked).toBe(1);
    const flags = await dupByRef();
    expect(flags.get("old")).toBe(1);
    expect(flags.get("new")).toBe(0);
    const totals = await env.DB.prepare(
      "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
    ).first<{ plays: number }>();
    expect(totals?.plays).toBe(1);
  });

  it("marks a YouTube play when a better play arrives later on its day", async () => {
    await seedUser(["lastfm", "ytmusic"]);
    await seedPlays([{ kind: "ytmusic", at: noon, ref: "y1" }]);
    await markDuplicates(env.DB, 1, noon, noon);
    await seedPlays([{ kind: "lastfm", at: noon + 3600, ref: "f1" }]);
    await markDuplicates(env.DB, 1, noon + 3600, noon + 3600);
    const flags = await dupByRef();
    expect(flags.get("y1")).toBe(1);
    expect(flags.get("f1")).toBe(0);
    const totals = await env.DB.prepare(
      "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
    ).first<{ plays: number }>();
    expect(totals?.plays).toBe(1);
  });

  it("changes nothing on a second run", async () => {
    await seedUser(["listenbrainz", "lastfm"]);
    await seedPlays([
      { kind: "listenbrainz", at: noon },
      { kind: "lastfm", at: noon + 5 },
    ]);
    const first = await markDuplicates(env.DB, 1, noon, noon + 5);
    expect(first.marked).toBe(1);
    const second = await markDuplicates(env.DB, 1, noon, noon + 5);
    expect(second.marked).toBe(0);
    expect(second.rowsWritten).toBe(0);
    const totals = await env.DB.prepare(
      "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
    ).first<{ plays: number }>();
    expect(totals?.plays).toBe(1);
  });

  it("keeps one play of a repeat stored by two calls", async () => {
    await seedUser(["listenbrainz", "lastfm"]);
    await seedPlays([
      { kind: "listenbrainz", at: noon + 200, ref: "lb" },
      { kind: "lastfm", at: noon + 400, ref: "fm2" },
    ]);
    const first = await markDuplicates(env.DB, 1, noon + 400, noon + 400);
    expect(first.marked).toBe(1);
    await seedPlays([{ kind: "lastfm", at: noon, ref: "fm1" }]);
    const second = await markDuplicates(env.DB, 1, noon, noon);
    expect(second.marked).toBe(0);
    const flags = await dupByRef();
    expect(flags.get("fm2")).toBe(1);
    expect(flags.get("fm1")).toBe(0);
    const totals = await env.DB.prepare(
      "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
    ).first<{ plays: number }>();
    expect(totals?.plays).toBe(2);
  });

  it("pairs a repeat stored by three calls", async () => {
    await seedUser(["listenbrainz", "lastfm"]);
    await seedPlays([
      { kind: "listenbrainz", at: noon, ref: "l1" },
      { kind: "lastfm", at: noon + 300, ref: "f1" },
    ]);
    const first = await markDuplicates(env.DB, 1, noon, noon + 300);
    expect(first.marked).toBe(1);
    await seedPlays([{ kind: "lastfm", at: noon + 1150, ref: "f2" }]);
    const second = await markDuplicates(env.DB, 1, noon + 1150, noon + 1150);
    expect(second.marked).toBe(0);
    await seedPlays([{ kind: "listenbrainz", at: noon + 590, ref: "l2" }]);
    const third = await markDuplicates(env.DB, 1, noon + 590, noon + 590);
    expect(third.marked).toBe(1);
    const flags = await dupByRef();
    expect(flags.get("f1")).toBe(1);
    expect(flags.get("f2")).toBe(1);
    const totals = await env.DB.prepare(
      "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
    ).first<{ plays: number }>();
    expect(totals?.plays).toBe(2);
  });

  it("marks a play a later store frees a partner for", async () => {
    await seedUser(["listenbrainz", "lastfm"]);
    await seedPlays([
      { kind: "listenbrainz", at: noon, ref: "l1" },
      { kind: "lastfm", at: noon + 510, ref: "f1" },
    ]);
    await markDuplicates(env.DB, 1, noon, noon + 510);
    await seedPlays([{ kind: "lastfm", at: noon - 400, ref: "f2" }]);
    await markDuplicates(env.DB, 1, noon - 400, noon - 400);
    await seedPlays([{ kind: "listenbrainz", at: noon + 1000, ref: "l0" }]);
    await markDuplicates(env.DB, 1, noon + 1000, noon + 1000);
    const flags = await dupByRef();
    expect(flags.get("f1")).toBe(1);
    expect(flags.get("f2")).toBe(1);
    expect(flags.get("l0")).toBe(0);
    expect(flags.get("l1")).toBe(0);
    const totals = await env.DB.prepare(
      "SELECT plays FROM track_totals WHERE user_id = 1 AND track_id = 1",
    ).first<{ plays: number }>();
    expect(totals?.plays).toBe(2);
  });

  it("leaves rows outside the stored range as they were", async () => {
    const day = Math.floor(noon / daySeconds) * daySeconds;
    await seedUser(["listenbrainz", "lastfm"]);
    await seedPlays([
      { kind: "listenbrainz", at: day - 500, ref: "lbA" },
      { kind: "lastfm", at: day - 1050, ref: "fm0" },
      { kind: "lastfm", at: day - 590, ref: "fm1" },
    ]);
    const first = await markDuplicates(env.DB, 1, day - 1050, day - 590);
    expect(first.marked).toBe(1);
    expect((await dupByRef()).get("fm0")).toBe(1);
    await seedPlays([
      { kind: "lastfm", at: day + 43200, track: 2, ref: "other" },
    ]);
    const second = await markDuplicates(env.DB, 1, day + 43200, day + 43200);
    expect(second.marked).toBe(0);
    const flags = await dupByRef();
    expect(flags.get("fm1")).toBe(0);
    expect(flags.get("other")).toBe(0);
  });
});

describe("cross-source duplicates", () => {
  function post(plays: Array<Record<string, unknown>>) {
    return SELF.fetch(
      new Request("https://music.rising.sh/api/v1/upload", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ client: "music-stats/0.4.0", plays }),
      }),
    );
  }

  it("a user with ListenBrainz and YouTube Music, or with ListenBrainz and Last.fm, on one listening app shows each play once", async () => {
    const kinds = ["lastfm", "listenbrainz", "ytmusic"];
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, github_id, name, created_at) VALUES (1, 1, 'alice', ?1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO artists (id, key, name) VALUES (1, 'artistone', 'Artist One'), (2, 'artisttwo', 'Artist Two')",
      ),
      env.DB.prepare(
        `INSERT INTO tracks (id, key, artist_id, title)
         VALUES (1, 'artistone\u001fsonga', 1, 'Song A'),
                (2, 'artisttwo\u001fsongb', 2, 'Song B')`,
      ),
      ...kinds.map((kind) =>
        env.DB.prepare(
          "INSERT INTO sources (id, user_id, kind, account) VALUES (?1, 1, ?2, ?3)",
        ).bind(
          sourceIds[kind],
          kind,
          kind === "ytmusic" ? null : `alice-${kind}`,
        ),
      ),
      env.DB.prepare(
        "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (?1, ?2, ?3, ?4)",
      ).bind(sourceIds.ytmusic, await hash(token), token.slice(-4), now),
    ]);
    env.LASTFM_API_KEY = "test-key";
    env.LASTFM_APPROVAL = "local";

    const times = [
      Date.parse(`${dayText}T08:00:00.000Z`) / 1000,
      Date.parse(`${dayText}T14:30:00.000Z`) / 1000,
      Date.parse(`${dayText}T21:00:00.000Z`) / 1000,
    ];
    const songA = {
      artist_name: "Artist One",
      track_name: "Song A",
      additional_info: {},
    };
    const songB = {
      artist_name: "Artist Two",
      track_name: "Song B",
      additional_info: {},
    };

    const fmTracks = [
      {
        name: "Song A",
        artist: { "#text": "Artist One" },
        date: { uts: String(times[0] + 5) },
      },
      {
        name: "Song B",
        artist: { "#text": "Artist Two" },
        date: { uts: String(times[1] + 5) },
      },
      {
        name: "Song A",
        artist: { "#text": "Artist One" },
        date: { uts: String(times[2] + 5) },
      },
    ];
    const fmFetcher = async (url: string) => ({
      status: 200,
      body: {
        recenttracks: {
          track: new URL(url).searchParams.has("to") ? [] : fmTracks,
        },
      },
    });
    const fmPull = await pullLastFm(
      env,
      await sourceRow("lastfm"),
      fmFetcher,
      now,
      0,
    );
    expect(fmPull.inserted).toBe(3);

    const listens = [
      { listened_at: times[2], track_metadata: songA },
      { listened_at: times[1], track_metadata: songB },
      { listened_at: times[0], track_metadata: songA },
    ];
    const lbFetcher = async (url: string) => ({
      status: 200,
      body: {
        payload: {
          listens: new URL(url).searchParams.has("max_ts") ? [] : listens,
        },
      },
    });
    const lbPull = await pullListenBrainz(
      env,
      await sourceRow("listenbrainz"),
      lbFetcher,
      now,
    );
    expect(lbPull.inserted).toBe(3);

    const upload = await post([
      { day: dayText, artist: "Artist One", title: "Song A", video_id: "va2" },
      { day: dayText, artist: "Artist Two", title: "Song B", video_id: "vb1" },
      { day: dayText, artist: "Artist One", title: "Song A", video_id: "va1" },
    ]);
    expect(await upload.json()).toMatchObject({ inserted: 3 });

    const perSource = await env.DB.prepare(
      `SELECT sources.kind, COUNT(*) AS plays, SUM(plays.dup) AS dups
       FROM plays JOIN sources ON sources.id = plays.source_id
       WHERE plays.user_id = 1 GROUP BY sources.kind`,
    ).all<{ kind: string; plays: number; dups: number }>();
    expect(
      Object.fromEntries(
        perSource.results.map((row) => [row.kind, [row.plays, row.dups]]),
      ),
    ).toEqual({
      listenbrainz: [3, 0],
      lastfm: [3, 3],
      ytmusic: [3, 3],
    });

    const trackTotals = await env.DB.prepare(
      `SELECT tracks.title, track_totals.plays
       FROM track_totals JOIN tracks ON tracks.id = track_totals.track_id
       WHERE track_totals.user_id = 1 ORDER BY tracks.title`,
    ).all<{ title: string; plays: number }>();
    expect(trackTotals.results).toEqual([
      { title: "Song A", plays: 2 },
      { title: "Song B", plays: 1 },
    ]);
    const day = Math.floor(noon / daySeconds);
    const daily = await env.DB.prepare(
      "SELECT day, plays FROM daily_totals WHERE user_id = 1",
    ).all<{ day: number; plays: number }>();
    expect(daily.results).toEqual([{ day, plays: 3 }]);
    const artists = await env.DB.prepare(
      `SELECT artists.name, artist_totals.plays
       FROM artist_totals JOIN artists ON artists.id = artist_totals.artist_id
       WHERE artist_totals.user_id = 1 ORDER BY artists.name`,
    ).all<{ name: string; plays: number }>();
    expect(artists.results).toEqual([
      { name: "Artist One", plays: 2 },
      { name: "Artist Two", plays: 1 },
    ]);

    const profile = await app.fetch(
      new Request("https://music.rising.sh/u/alice.json?period=all"),
      { DB: env.DB, LASTFM_APPROVAL: "local" },
    );
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({
      plays: 3,
      unique_tracks: 2,
      unique_artists: 2,
    });
  });

  it("marks duplicates a backfill page stores", async () => {
    await seedUser(["listenbrainz", "lastfm"]);
    const fmAt = noon - 3 * daySeconds;
    await seedPlays([
      { kind: "lastfm", at: fmAt, ref: "old1" },
      { kind: "lastfm", at: fmAt + 100, ref: "old2" },
    ]);
    await env.DB.prepare(
      "UPDATE sources SET cursor = ?1, backfill_before = ?2 WHERE id = ?3",
    )
      .bind(noon, noon - 1, sourceIds.listenbrainz)
      .run();
    const song = {
      artist_name: "Artist One",
      track_name: "Song A",
      additional_info: {},
    };
    const lbFetcher = async (url: string) => {
      const params = new URL(url).searchParams;
      if (!params.has("max_ts"))
        return { status: 200, body: { payload: { listens: [] } } };
      return {
        status: 200,
        body: {
          payload: {
            listens: [
              { listened_at: fmAt + 3, track_metadata: song },
              { listened_at: fmAt + 103, track_metadata: song },
            ],
          },
        },
      };
    };
    const pull = await pullListenBrainz(
      env,
      await sourceRow("listenbrainz"),
      lbFetcher,
      now,
    );
    expect(pull.inserted).toBe(2);
    const flags = await dupByRef();
    expect(flags.get("old1")).toBe(1);
    expect(flags.get("old2")).toBe(1);
  });
});
