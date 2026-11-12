import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import worker from "../src/index";
import { pullDueSources, pullListenBrainz } from "../src/listenbrainz";
import {
  readTrackSql,
  resolvePageTracks,
  storeListens,
  type ExistingTrack,
} from "../src/matching";
import { normalizeText, trackKey } from "../src/normalize";

const now = Math.floor(Date.now() / 1000);
const listens = [
  {
    listened_at: now - 120,
    track_metadata: {
      artist_name: "Radiohead",
      track_name: "Weird Fishes/ Arpeggi",
      additional_info: { recording_mbid: "recording-1", isrc: "ISRC-1" },
    },
  },
  {
    listened_at: now - 240,
    track_metadata: {
      artist_name: "Beyoncé",
      track_name: "Halo",
      additional_info: {},
    },
  },
];

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

describe("normalisation", () => {
  it.each([
    ["Beyoncé", "beyonce"],
    ["Weird Fishes/ Arpeggi - Remastered", "weirdfishesarpeggi"],
    ["Radiohead - Topic", "radiohead"],
    ["Song (Official Video)", "song"],
    ["Song - Explicit", "song"],
    ["Song - Stereo", "song"],
    ["Mono", "mono"],
    ["Stereo", "stereo"],
    ["Live Version", "liveversion"],
  ])("normalises %s", (input, expected) => {
    expect(normalizeText(input, input.includes("Topic"))).toBe(expected);
  });

  it("builds the artist and title key with the contract separator", () => {
    expect(trackKey("Radiohead", "Weird Fishes/ Arpeggi")).toBe(
      "radiohead\u001fweirdfishesarpeggi",
    );
  });
});

describe("ListenBrainz ingestion", () => {
  it.each([
    {
      name: "reuses an MBID track created earlier on the page",
      inputs: [
        {
          kind: "listenbrainz",
          sourceKey: "created-a",
          artist: "Created Artist",
          title: "Created Song",
          mbid: "created-mbid",
          listenedAt: now - 100,
          userId: 1,
          sourceId: 10,
        },
        {
          kind: "listenbrainz",
          sourceKey: "created-b",
          artist: "Created Artist",
          title: "Changed Song",
          mbid: "created-mbid",
          listenedAt: now - 200,
          userId: 1,
          sourceId: 10,
        },
      ],
    },
  ])("$name", ({ inputs }) => {
    const result = resolvePageTracks(inputs, new Map(), []);

    expect(result.newTracks).toHaveLength(1);
    expect(result.listens.map((listen) => listen.trackKey)).toEqual([
      result.newTracks[0]?.key,
      result.newTracks[0]?.key,
    ]);
  });

  it("uses indexed track lookups for page candidates", async () => {
    await seedUser();
    const artist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('unrelated', 'Unrelated') RETURNING id",
    ).first<{ id: number }>();
    await env.DB.prepare(
      `WITH RECURSIVE numbers(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM numbers WHERE n < 200
      )
      INSERT INTO tracks (key, artist_id, title, mbid, isrc)
      SELECT 'unrelated' || n || char(31) || 'track', ?1,
        'Track ' || n, 'unrelated-mbid-' || n, 'unrelated-isrc-' || n
      FROM numbers`,
    )
      .bind(artist?.id)
      .run();

    const payload = JSON.stringify([
      {
        normalizedKey: "page\u001ftrack",
        mbid: "page-mbid",
        isrc: null,
      },
    ]);
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${readTrackSql}`)
      .bind(payload)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);

    expect(details.some((detail) => /SCAN tracks/i.test(detail))).toBe(false);
    expect(
      details.some((detail) =>
        /USING (?:COVERING )?INDEX (?:sqlite_autoindex_tracks_1|tracks_mbid|tracks_isrc)/i.test(
          detail,
        ),
      ),
    ).toBe(true);
  });

  it("walks alias, MBID, and key matches in order", () => {
    const aliasTrack: ExistingTrack = {
      id: 1,
      key: "aliasartist\u001faliassong",
      mbid: null,
      isrc: null,
      artistKey: "aliasartist",
      titleKey: "aliassong",
    };
    const mbidTrack: ExistingTrack = {
      id: 2,
      key: "mbidartist\u001fmbidsong",
      mbid: "mbid-1",
      isrc: null,
      artistKey: "mbidartist",
      titleKey: "mbidsong",
    };
    const keyTrack: ExistingTrack = {
      id: 3,
      key: "keyartist\u001fkeysong",
      mbid: null,
      isrc: null,
      artistKey: "keyartist",
      titleKey: "keysong",
    };
    const result = resolvePageTracks(
      [
        {
          kind: "listenbrainz",
          sourceKey: "alias-source",
          artist: "Changed Artist",
          title: "Changed Title",
          listenedAt: now - 100,
          userId: 1,
          sourceId: 10,
        },
        {
          kind: "listenbrainz",
          sourceKey: "mbid-source",
          artist: "Mbid Artist",
          title: "Mbid Song",
          mbid: "mbid-1",
          listenedAt: now - 200,
          userId: 1,
          sourceId: 10,
        },
        {
          kind: "listenbrainz",
          sourceKey: "key-source",
          artist: "Key Artist",
          title: "Key Song",
          listenedAt: now - 300,
          userId: 1,
          sourceId: 10,
        },
      ],
      new Map([["alias-source", aliasTrack]]),
      [aliasTrack, mbidTrack, keyTrack],
    );

    expect(result.newTracks).toHaveLength(0);
    expect(result.listens.map((listen) => listen.trackKey)).toEqual([
      aliasTrack.key,
      mbidTrack.key,
      keyTrack.key,
    ]);
  });

  it("stores plays for alias, MBID, and key matches", async () => {
    await seedUser();
    const aliasArtist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('aliasartist', 'Alias Artist') RETURNING id",
    ).first<{ id: number }>();
    const aliasTrack = await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title) VALUES ('aliasartist\u001falias song', ?1, 'Alias Song') RETURNING id",
    )
      .bind(aliasArtist?.id)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO track_aliases (kind, source_key, track_id) VALUES ('listenbrainz', 'alias-source', ?1)",
    )
      .bind(aliasTrack?.id)
      .run();
    const mbidArtist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('mbidartist', 'Mbid Artist') RETURNING id",
    ).first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title, mbid) VALUES ('mbidartist\u001fmbid song', ?1, 'Mbid Song', 'mbid-1')",
    )
      .bind(mbidArtist?.id)
      .run();
    const keyArtist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('keyartist', 'Key Artist') RETURNING id",
    ).first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title) VALUES ('keyartist\u001fkey song', ?1, 'Key Song')",
    )
      .bind(keyArtist?.id)
      .run();

    expect(
      await storeListens(
        env.DB,
        [
          {
            kind: "listenbrainz",
            sourceKey: "alias-source",
            artist: "Changed Artist",
            title: "Changed Title",
            listenedAt: now - 400,
            userId: 1,
            sourceId: 10,
          },
          {
            kind: "listenbrainz",
            sourceKey: "mbid-source",
            artist: "Mbid Artist",
            title: "Mbid Song",
            mbid: "mbid-1",
            listenedAt: now - 500,
            userId: 1,
            sourceId: 10,
          },
          {
            kind: "listenbrainz",
            sourceKey: "key-source",
            artist: "Key Artist",
            title: "Key Song",
            listenedAt: now - 600,
            userId: 1,
            sourceId: 10,
          },
        ],
        "listenbrainz",
      ),
    ).toBe(3);
    expect(await count("plays")).toBe(3);
  });

  it("deduplicates page tracks and reuses a known alias", async () => {
    await seedUser();
    const knownInput = {
      kind: "listenbrainz",
      sourceKey: "known-source",
      artist: "Known Artist",
      title: "Known Song",
      mbid: "rec-1",
      listenedAt: now - 300,
      userId: 1,
      sourceId: 10,
    };
    expect(await storeListens(env.DB, [knownInput], "listenbrainz")).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT mbid FROM artists WHERE key = 'knownartist'",
      ).first<{ mbid: string | null }>(),
    ).toEqual({ mbid: null });
    expect(
      await env.DB.prepare(
        "SELECT mbid FROM tracks WHERE key = 'knownartist\u001fknownsong'",
      ).first<{ mbid: string | null }>(),
    ).toEqual({ mbid: "rec-1" });
    const knownTrack = await env.DB.prepare(
      "SELECT track_id FROM track_aliases WHERE kind = 'listenbrainz' AND source_key = 'known-source'",
    ).first<{ track_id: number }>();

    expect(
      await storeListens(
        env.DB,
        [
          {
            kind: "listenbrainz",
            sourceKey: "recording-shared-a",
            artist: "Artist One",
            title: "Shared Song",
            mbid: "shared-mbid",
            listenedAt: now - 100,
            userId: 1,
            sourceId: 10,
          },
          {
            kind: "listenbrainz",
            sourceKey: "recording-shared-b",
            artist: "Artist Two",
            title: "Shared Song",
            mbid: "shared-mbid",
            listenedAt: now - 200,
            userId: 1,
            sourceId: 10,
          },
          {
            kind: "listenbrainz",
            sourceKey: "recording-shared-a",
            artist: "Artist Three",
            title: "Different Song",
            mbid: "shared-mbid",
            listenedAt: now - 250,
            userId: 1,
            sourceId: 10,
          },
          { ...knownInput, listenedAt: now - 400, artist: "Changed Artist" },
        ],
        "listenbrainz",
      ),
    ).toBe(4);

    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tracks WHERE mbid = 'shared-mbid'",
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 });
    const aliases = await env.DB.prepare(
      `SELECT source_key, track_id FROM track_aliases
       WHERE kind = 'listenbrainz'
         AND source_key IN ('recording-shared-a', 'recording-shared-b')
       ORDER BY source_key`,
    ).all<{ source_key: string; track_id: number }>();
    expect(aliases.results).toHaveLength(2);
    expect(aliases.results[0]?.track_id).toBe(aliases.results[1]?.track_id);
    expect(aliases.results[0]?.track_id).not.toBe(knownTrack?.track_id);
    expect(
      await env.DB.prepare(
        "SELECT track_id FROM track_aliases WHERE kind = 'listenbrainz' AND source_key = 'known-source'",
      ).first<{ track_id: number }>(),
    ).toEqual(knownTrack);
  });

  it("resolves every page listen to an existing representative track", async () => {
    await seedUser();
    const artist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('x', 'X') RETURNING id",
    ).first<{ id: number }>();
    const track = await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title) VALUES ('x\u001ft', ?1, 'T') RETURNING id",
    )
      .bind(artist?.id)
      .first<{ id: number }>();
    const inputs = [
      {
        kind: "listenbrainz",
        sourceKey: "recording-m-a",
        artist: "X",
        title: "T",
        mbid: "m",
        listenedAt: now - 100,
        userId: 1,
        sourceId: 10,
      },
      {
        kind: "listenbrainz",
        sourceKey: "recording-m-b",
        artist: "X feat Y",
        title: "T",
        mbid: "m",
        listenedAt: now - 200,
        userId: 1,
        sourceId: 10,
      },
      {
        kind: "listenbrainz",
        sourceKey: "recording-m-c",
        artist: "X and Y",
        title: "T",
        mbid: "m",
        listenedAt: now - 300,
        userId: 1,
        sourceId: 10,
      },
    ];

    expect(await storeListens(env.DB, inputs, "listenbrainz")).toBe(3);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM tracks").first<{
        count: number;
      }>(),
    ).toEqual({ count: 1 });
    expect(await count("plays")).toBe(3);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM plays
         WHERE track_id = ?1`,
      )
        .bind(track?.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 3 });
  });

  it("advances the cursor when every current listen is already stored", async () => {
    await seedUser();
    const page = [
      {
        listened_at: now - 100,
        track_metadata: {
          artist_name: "Cursor Artist A",
          track_name: "Cursor Song A",
          additional_info: { recording_mbid: "cursor-a" },
        },
      },
      {
        listened_at: now - 200,
        track_metadata: {
          artist_name: "Cursor Artist B",
          track_name: "Cursor Song B",
          additional_info: { recording_mbid: "cursor-b" },
        },
      },
      {
        listened_at: now - 300,
        track_metadata: {
          artist_name: "Cursor Artist C",
          track_name: "Cursor Song C",
          additional_info: { recording_mbid: "cursor-c" },
        },
      },
    ];
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
    const source = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    const result = await pullListenBrainz(
      env,
      source,
      async (url) => {
        const maxTs = new URL(url).searchParams.get("max_ts");
        return {
          payload: {
            listens:
              maxTs === null
                ? page
                : page.filter((listen) => listen.listened_at < Number(maxTs)),
          },
        };
      },
      now,
    );

    expect(result.cursor).toBe(now - 100);
    expect(result.backfillBefore).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT cursor, backfill_before FROM sources WHERE id = 10",
      ).first<{ cursor: number | null; backfill_before: number | null }>(),
    ).toEqual({ cursor: now - 100, backfill_before: null });
  });

  it("stores a page once when the same response is pulled twice", async () => {
    await seedUser();
    const prepare = vi.spyOn(env.DB, "prepare");
    const fetcher = async (url: string) =>
      new URL(url).searchParams.has("max_ts")
        ? { payload: { listens: [] } }
        : { payload: { listens } };
    const first = await pullListenBrainz(
      env,
      {
        id: 10,
        user_id: 1,
        kind: "listenbrainz",
        account: "alice-lb",
        cursor: null,
        backfill_before: null,
        next_pull_at: now,
        idle_pulls: 0,
      },
      fetcher,
      now,
    );
    expect(prepare).toHaveBeenCalledTimes(7);
    const source = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    prepare.mockClear();
    const second = await pullListenBrainz(env, source, fetcher, now + 900);
    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(prepare).toHaveBeenCalledTimes(7);
    expect(await count("plays")).toBe(2);
    expect(await count("track_totals")).toBe(2);
  });

  it("stores a full ListenBrainz page in bounded batches", async () => {
    await seedUser();
    const page = Array.from({ length: 1000 }, (_, index) => ({
      listened_at: now - index,
      track_metadata: {
        artist_name: `Artist ${index}`,
        track_name: `Track ${index}`,
        additional_info: { recording_mbid: `recording-${index}` },
      },
    }));
    const fetcher = async (url: string) =>
      new URL(url).searchParams.has("max_ts")
        ? { payload: { listens: [] } }
        : { payload: { listens: page } };
    const batch = vi.spyOn(env.DB, "batch");
    const first = await pullListenBrainz(
      env,
      {
        id: 10,
        user_id: 1,
        kind: "listenbrainz",
        account: "alice-lb",
        cursor: null,
        backfill_before: null,
        next_pull_at: now,
        idle_pulls: 0,
      },
      fetcher,
      now,
    );
    expect(first.inserted).toBe(1000);
    expect(first.cursor).toBe(now);
    expect(first.backfillBefore).toBe(now - 999);
    expect(await count("plays")).toBe(1000);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls[0][0]).toHaveLength(2);
    expect(batch.mock.calls[1][0]).toHaveLength(4);

    const source = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    const second = await pullListenBrainz(env, source, fetcher, now + 900);
    expect(second.inserted).toBe(0);
    expect(await count("plays")).toBe(1000);
    expect(batch).toHaveBeenCalledTimes(4);
    expect(batch.mock.calls[2][0]).toHaveLength(2);
    expect(batch.mock.calls[3][0]).toHaveLength(4);
  });

  it("runs a due source through the Worker scheduled handler", async () => {
    await seedUser();
    const responseBody = JSON.stringify({ payload: { listens: [listens[0]] } });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
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

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await count("plays")).toBe(1);
    const source = await env.DB.prepare(
      "SELECT next_pull_at FROM sources WHERE id = 10",
    ).first<{ next_pull_at: number }>();
    expect(source?.next_pull_at).toBeGreaterThan(now);
    expect((source?.next_pull_at ?? 0) - now).toBeGreaterThanOrEqual(15 * 60);
    expect((source?.next_pull_at ?? 0) - now).toBeLessThan(20 * 60);
  });

  it("pulls only five due sources in one tick", async () => {
    await env.DB.prepare(
      "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 7) INSERT INTO users (id, github_id, name, created_at) SELECT n + 1, n + 100, 'due-' || n, ?1 FROM numbers",
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 7) INSERT INTO sources (id, user_id, kind, account, next_pull_at) SELECT n + 10, n + 1, 'listenbrainz', 'due-' || n, ?1 FROM numbers",
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

    expect(fetcher).toHaveBeenCalledTimes(5);
    const sources = await env.DB.prepare(
      "SELECT id, next_pull_at FROM sources ORDER BY id",
    ).all<{ id: number; next_pull_at: number }>();
    expect(sources.results).toEqual([
      { id: 11, next_pull_at: now + 30 * 60 },
      { id: 12, next_pull_at: now + 30 * 60 },
      { id: 13, next_pull_at: now + 30 * 60 },
      { id: 14, next_pull_at: now + 30 * 60 },
      { id: 15, next_pull_at: now + 30 * 60 },
      { id: 16, next_pull_at: now },
      { id: 17, next_pull_at: now },
    ]);
  });

  it("persists exponential backoff after failed pulls", async () => {
    await seedUser();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ListenBrainz unavailable"));
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
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("continues historical backfill past a stored play", async () => {
    await seedUser({ cursor: now, backfill_before: null });
    const initialSource = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    await pullListenBrainz(
      env,
      initialSource,
      async () => ({ payload: { listens: [listens[0]] } }),
      now,
    );
    await env.DB.prepare(
      "UPDATE sources SET backfill_before = ?1 WHERE id = 10",
    )
      .bind(now - 1)
      .run();
    const fetcher = async (url: string) =>
      new URL(url).searchParams.has("max_ts")
        ? {
            payload: {
              listens: [listens[0], { ...listens[1], listened_at: now - 400 }],
            },
          }
        : { payload: { listens: [] } };
    const source = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    source.backfill_before = now - 1;
    await pullListenBrainz(env, source, fetcher, now);
    expect(await count("plays")).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT backfill_before FROM sources WHERE id = 10",
      ).first<{ backfill_before: number | null }>(),
    ).toEqual({ backfill_before: now - 400 });
  });

  it("continues backfill past duplicate listens at one timestamp", async () => {
    await seedUser({ cursor: now, backfill_before: now - 1 });
    const sameTimestamp = {
      listened_at: now - 100,
      track_metadata: {
        artist_name: "New Artist",
        track_name: "New Song",
        additional_info: {},
      },
    };
    const older = {
      listened_at: now - 101,
      track_metadata: {
        artist_name: "Older Artist",
        track_name: "Older Song",
        additional_info: {},
      },
    };
    const duplicateListen = {
      listened_at: now - 100,
      track_metadata: {
        artist_name: "Duplicate Artist",
        track_name: "Duplicate Song",
        additional_info: {},
      },
    };
    let historicalPage = 0;
    const fetcher = async (url: string) => {
      if (!new URL(url).searchParams.has("max_ts")) {
        return { payload: { listens: [] } };
      }
      historicalPage += 1;
      const maxTs = Number(new URL(url).searchParams.get("max_ts"));
      const page =
        historicalPage === 1 ? [sameTimestamp, duplicateListen] : [older];
      return {
        payload: {
          listens: page.filter((listen) => listen.listened_at < maxTs),
        },
      };
    };
    const source = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    const first = await pullListenBrainz(env, source, fetcher, now);
    expect(first.inserted).toBe(1);
    expect(first.backfillBefore).toBe(now - 100);
    const saved = await env.DB.prepare(
      "SELECT backfill_before FROM sources WHERE id = 10",
    ).first<{ backfill_before: number | null }>();
    expect(saved).toEqual({ backfill_before: now - 100 });

    const nextSource = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    const second = await pullListenBrainz(env, nextSource, fetcher, now + 900);
    expect(second.inserted).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM plays WHERE user_id = 1",
      ).first<{ count: number }>(),
    ).toEqual({ count: 2 });
  });

  it("stores current listens after a duplicate in the page", async () => {
    await seedUser();
    const middle = {
      kind: "listenbrainz",
      sourceKey: "Middle Artist\tMiddle Song",
      artist: "Middle Artist",
      title: "Middle Song",
      listenedAt: now - 200,
      userId: 1,
      sourceId: 10,
    };
    await storeListens(env.DB, [middle], "listenbrainz");
    const before = {
      ...middle,
      sourceKey: "before-source",
      artist: "Before Artist",
      title: "Before Song",
      listenedAt: now - 100,
    };
    const after = {
      ...middle,
      sourceKey: "after-source",
      artist: "After Artist",
      title: "After Song",
      listenedAt: now - 300,
    };
    const fetcher = async (url: string) =>
      new URL(url).searchParams.has("max_ts")
        ? { payload: { listens: [] } }
        : {
            payload: {
              listens: [
                {
                  listened_at: before.listenedAt,
                  track_metadata: {
                    artist_name: before.artist,
                    track_name: before.title,
                    additional_info: {},
                  },
                },
                {
                  listened_at: middle.listenedAt,
                  track_metadata: {
                    artist_name: middle.artist,
                    track_name: middle.title,
                    additional_info: {},
                  },
                },
                {
                  listened_at: after.listenedAt,
                  track_metadata: {
                    artist_name: after.artist,
                    track_name: after.title,
                    additional_info: {},
                  },
                },
              ],
            },
          };
    const source = await env.DB.prepare(
      "SELECT * FROM sources WHERE id = 10",
    ).first<any>();
    const result = await pullListenBrainz(env, source, fetcher, now);
    expect(result.inserted).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM plays WHERE user_id = 1",
      ).first<{ count: number }>(),
    ).toEqual({ count: 3 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM plays WHERE played_at = ?1",
      )
        .bind(after.listenedAt)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("removes a play from totals when it becomes a duplicate", async () => {
    await seedUser();
    const artist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('artist', 'Artist') RETURNING id",
    ).first<{ id: number }>();
    const track = await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title) VALUES ('artist\\u001ftrack', ?1, 'Track') RETURNING id",
    )
      .bind(artist?.id)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, track_id) VALUES (1, ?1, 10, ?2)",
    )
      .bind(now, track?.id)
      .run();
    expect(await count("track_totals")).toBe(1);

    await env.DB.prepare(
      "UPDATE plays SET dup = 1 WHERE user_id = 1 AND played_at = ?1 AND source_id = 10",
    )
      .bind(now)
      .run();
    expect(await count("track_totals")).toBe(0);
  });
});

describe("profile API", () => {
  it("returns each period and keeps hidden users private", async () => {
    await seedUser();
    await env.DB.prepare(
      "INSERT INTO users (github_id, name, is_public, created_at) VALUES (2, 'hidden', 0, ?1)",
    )
      .bind(now)
      .run();
    const artist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES ('artist', 'Artist') RETURNING id",
    ).first<{ id: number }>();
    const track = await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title) VALUES (?1, ?2, 'Track') RETURNING id",
    )
      .bind(`artist\u001ftrack`, artist?.id)
      .first<{ id: number }>();
    for (const playedAt of [now - 60, now - 8 * 86400, now - 31 * 86400]) {
      await env.DB.prepare(
        "INSERT INTO plays (user_id, played_at, source_id, track_id) VALUES (1, ?1, 10, ?2)",
      )
        .bind(playedAt, track?.id)
        .run();
    }
    for (const period of ["week", "month", "all"]) {
      const response = await SELF.fetch(
        `https://music.rising.sh/u/alice.json?period=${period}`,
      );
      expect(response.status).toBe(200);
      const body = await response.json<any>();
      expect(body.schema).toBe(1);
      expect(body.period).toBe(period);
      expect(body.plays).toBe(
        period === "week" ? 1 : period === "month" ? 2 : 3,
      );
      if (period === "week")
        expect(response.headers.get("Content-Security-Policy")).toBe(
          "default-src 'none'; style-src 'unsafe-inline'",
        );
    }
    expect(
      (await SELF.fetch("https://music.rising.sh/u/hidden.json")).status,
    ).toBe(404);
    expect(
      (await SELF.fetch("https://music.rising.sh/u/unknown.json")).status,
    ).toBe(404);
  });

  it("serves a snapshot when KV reads fail", async () => {
    await seedUser();
    const cache = {
      get: vi.fn().mockRejectedValue(new Error("KV unavailable")),
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace;
    const response = await app.fetch(
      new Request("https://music.rising.sh/u/alice.json"),
      { DB: env.DB, CACHE: cache },
    );

    expect(response.status).toBe(200);
    expect(cache.get).toHaveBeenCalledOnce();
  });
});
