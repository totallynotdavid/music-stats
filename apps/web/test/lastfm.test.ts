import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import worker from "../src/index";
import { pullLastFm } from "../src/lastfm";
import { pullDueSources } from "../src/cron";
import fixture from "./fixtures/recenttracks";
import type { SourceRow } from "../src/types";

const now = Math.floor(Date.now() / 1000);

const ok = (tracks: unknown[]) => ({
  status: 200,
  body: { recenttracks: { track: tracks } },
});

const track = (index: number, at: number) => ({
  name: `Song ${index}`,
  mbid: "",
  artist: { "#text": `Artist ${index}` },
  album: { "#text": "" },
  url: `https://www.last.fm/music/Artist+${index}/_/Song+${index}`,
  date: { uts: String(at), "#text": "12 Nov 2026, 00:00" },
});

const nowPlaying = {
  name: "Live Song",
  mbid: "",
  artist: { "#text": "Live Artist" },
  album: { "#text": "" },
  url: "https://www.last.fm/music/Live+Artist/_/Live+Song",
  "@attr": { nowplaying: "true" },
};

const paramsOf = (call: unknown[]) => new URL(call[0] as string).searchParams;

async function seedUser(
  source: Partial<{
    kind: string;
    cursor: number | null;
    backfill_before: number | null;
    play_count: number;
    name: string;
  }> = {},
) {
  await env.DB.prepare(
    "INSERT INTO users (github_id, name, created_at) VALUES (1, ?1, ?2)",
  )
    .bind(source.name ?? "alice", now)
    .run();
  await env.DB.prepare(
    `INSERT INTO sources (id, user_id, kind, account, cursor, backfill_before, next_pull_at, play_count)
       VALUES (10, 1, ?1, 'alice-fm', ?2, ?3, ?4, ?5)`,
  )
    .bind(
      source.kind ?? "lastfm",
      source.cursor ?? null,
      source.backfill_before ?? null,
      now,
      source.play_count ?? 0,
    )
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
  env.LASTFM_API_KEY = "test-key";
  env.LASTFM_APPROVAL = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Last.fm launch gate", () => {
  it("with LASTFM_APPROVAL empty answers 404 on the three addresses and stores no play", async () => {
    await seedUser();
    const liveFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}"));
    await pullDueSources(env, now);
    expect(liveFetch).not.toHaveBeenCalled();
    expect(await count("plays")).toBe(0);
    for (const path of ["/u/alice", "/u/alice.json", "/u/alice.svg"]) {
      const response = await SELF.fetch(`https://music.rising.sh${path}`);
      expect(response.status).toBe(404);
    }
  });

  it("with LASTFM_APPROVAL set serves the three addresses, each with the credit and a one-minute bound", async () => {
    await seedUser();
    env.LASTFM_APPROVAL = "local";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify(ok([]).body), {
          headers: { "content-type": "application/json" },
        }),
    );
    await pullDueSources(env, now);
    expect(fetchSpy).toHaveBeenCalled();
    const page = await SELF.fetch("https://music.rising.sh/u/alice");
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("public, max-age=60");
    const html = await page.text();
    expect(html).toContain("powered by AudioScrobbler");
    expect(html).toContain("https://www.last.fm");
    const json = await SELF.fetch("https://music.rising.sh/u/alice.json");
    expect(json.status).toBe(200);
    expect(json.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(await json.json()).toMatchObject({
      credit: { name: "Last.fm", url: "https://www.last.fm" },
    });
    const card = await SELF.fetch("https://music.rising.sh/u/alice.svg");
    expect(card.status).toBe(200);
    expect(card.headers.get("Cache-Control")).toBe("public, max-age=60");
    const svg = await card.text();
    expect(svg).toContain("powered by AudioScrobbler");
    expect(svg).toContain("https://www.last.fm");
    const user = await SELF.fetch("https://music.rising.sh/u/unknown");
    expect(user.status).toBe(404);
  });

  it("serves a user without a Last.fm source with no credit and the fifteen-minute bound", async () => {
    await seedUser({ kind: "listenbrainz" });
    env.LASTFM_APPROVAL = "local";
    const page = await SELF.fetch("https://music.rising.sh/u/alice");
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("AudioScrobbler");
    const json = await SELF.fetch("https://music.rising.sh/u/alice.json");
    expect(json.headers.get("Cache-Control")).toBe("public, max-age=900");
    expect(await json.json()).not.toHaveProperty("credit");
    const card = await SELF.fetch("https://music.rising.sh/u/alice.svg");
    expect(card.headers.get("Cache-Control")).toBe("public, max-age=900");
    expect(await card.text()).not.toContain("AudioScrobbler");
  });
});

describe("pullLastFm", () => {
  it("skips the now-playing item and stores the dated plays", async () => {
    await seedUser();
    const page = [nowPlaying, track(0, now - 10), track(1, now - 300)];
    const fetcher = vi.fn(async (url: string) =>
      new URL(url).searchParams.has("to") ? ok([]) : ok(page),
    );
    const result = await pullLastFm(env, await sourceRow(), fetcher, now, 0);
    expect(result.inserted).toBe(2);
    expect(await count("plays")).toBe(2);
    expect(
      await env.DB.prepare("SELECT MIN(played_at) AS oldest FROM plays").first<{
        oldest: number;
      }>(),
    ).toEqual({ oldest: now - 300 });
  });

  it("asks for the next page with from = cursor + 1", async () => {
    await seedUser({ cursor: now - 1000 });
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url).searchParams;
      return params.has("to") ? ok([]) : ok([track(0, now - 50)]);
    });
    await pullLastFm(env, await sourceRow(), fetcher, now, 0);
    const current = fetcher.mock.calls.find(
      (call) => !paramsOf(call).has("to"),
    )!;
    const params = paramsOf(current);
    expect(params.get("method")).toBe("user.getrecenttracks");
    expect(params.get("user")).toBe("alice-fm");
    expect(params.get("api_key")).toBe("test-key");
    expect(params.get("format")).toBe("json");
    expect(params.get("limit")).toBe("200");
    expect(params.get("from")).toBe(String(now - 999));
  });

  it("stores the newest page on the first pull and walks back with to until a page is empty", async () => {
    await seedUser();
    const history = Array.from({ length: 6 }, (_, index) =>
      track(index, now - 100 * (index + 1)),
    );
    const fetcher = async (url: string) => {
      const params = new URL(url).searchParams;
      const to = params.has("to")
        ? Number(params.get("to"))
        : Number.MAX_SAFE_INTEGER;
      const limit = Number(params.get("limit"));
      return ok(
        history.filter((item) => Number(item.date.uts) <= to).slice(0, limit),
      );
    };
    const first = await pullLastFm(env, await sourceRow(), fetcher, now, 0);
    expect(first.inserted).toBe(6);
    const stored = await env.DB.prepare(
      "SELECT cursor, backfill_before FROM sources WHERE id = 10",
    ).first<{ cursor: number; backfill_before: number | null }>();
    expect(stored).toEqual({ cursor: now - 100, backfill_before: null });
    expect(await count("plays")).toBe(6);
  });

  it("backfills with to over several pulls until the page is empty", async () => {
    await seedUser();
    const current = [track(0, now - 10), track(1, now - 20)];
    const history = Array.from({ length: 5 }, (_, index) =>
      track(index + 2, now - 100 - index),
    );
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url).searchParams;
      if (!params.has("to")) return ok(current);
      const to = Number(params.get("to"));
      const limit = Number(params.get("limit"));
      return ok(
        history.filter((item) => Number(item.date.uts) <= to).slice(0, limit),
      );
    });
    const first = await pullLastFm(env, await sourceRow(), fetcher, now, 0);
    expect(first.inserted).toBe(7);
    const stored = await env.DB.prepare(
      "SELECT backfill_before FROM sources WHERE id = 10",
    ).first<{ backfill_before: number | null }>();
    expect(stored?.backfill_before).toBeNull();
    expect(await count("plays")).toBe(7);
    const walk = fetcher.mock.calls.filter((call) => paramsOf(call).has("to"));
    expect(paramsOf(walk[0]!).get("to")).toBe(String(now - 20));
  });

  it("drains the gap of a full current page before the backfill", async () => {
    const cursor = now - 5000;
    await seedUser({ cursor, backfill_before: null });
    const history = Array.from({ length: 250 }, (_, index) =>
      track(index, cursor + 10 + index),
    );
    const fetcher = async (url: string) => {
      const params = new URL(url).searchParams;
      const from = params.has("from") ? Number(params.get("from")) : 0;
      const to = params.has("to")
        ? Number(params.get("to"))
        : Number.MAX_SAFE_INTEGER;
      const limit = Number(params.get("limit"));
      return ok(
        history
          .filter(
            (item) =>
              Number(item.date.uts) >= from && Number(item.date.uts) <= to,
          )
          .slice(-limit)
          .reverse(),
      );
    };
    let pullAt = now;
    for (let pull = 0; pull < 5; pull += 1) {
      await pullLastFm(env, await sourceRow(), fetcher, pullAt, 0);
      const stored = await env.DB.prepare(
        "SELECT next_pull_at, gap_before FROM sources WHERE id = 10",
      ).first<{ next_pull_at: number; gap_before: number | null }>();
      pullAt = pullAt + 60;
      if (stored?.next_pull_at !== pullAt) break;
    }
    expect(await count("plays")).toBe(250);
    expect(
      await env.DB.prepare(
        "SELECT gap_before, gap_floor FROM sources WHERE id = 10",
      ).first<{ gap_before: number | null; gap_floor: number | null }>(),
    ).toEqual({ gap_before: null, gap_floor: null });
  });

  it("detects the gap behind a now-playing item on a full page", async () => {
    const cursor = now - 5000;
    await seedUser({ cursor });
    const allDated = [
      ...Array.from({ length: 199 }, (_, index) =>
        track(index + 3, now - 199 + index),
      ),
      track(2, cursor + 30),
      track(1, cursor + 20),
      track(0, cursor + 10),
    ];
    const fetcher = async (url: string) => {
      const params = new URL(url).searchParams;
      const limit = Number(params.get("limit"));
      if (params.has("to")) {
        const to = Number(params.get("to"));
        return ok(
          allDated.filter((item) => Number(item.date.uts) < to).slice(0, limit),
        );
      }
      const from = Number(params.get("from") ?? 0);
      const page = allDated
        .filter((item) => Number(item.date.uts) >= from)
        .slice(0, limit - 1);
      return ok(page.length > 0 ? [nowPlaying, ...page] : []);
    };
    await pullLastFm(env, await sourceRow(), fetcher, now, 0);
    expect(
      await env.DB.prepare(
        "SELECT gap_before, gap_floor FROM sources WHERE id = 10",
      ).first<{ gap_before: number | null; gap_floor: number | null }>(),
    ).toEqual({ gap_before: cursor + 30, gap_floor: cursor });
    let pullAt = now + 60;
    for (let pull = 0; pull < 4; pull += 1) {
      await pullLastFm(env, await sourceRow(), fetcher, pullAt, 0);
      pullAt += 60;
    }
    expect(await count("plays")).toBe(202);
    expect(
      await env.DB.prepare(
        "SELECT gap_before FROM sources WHERE id = 10",
      ).first<{ gap_before: number | null }>(),
    ).toEqual({ gap_before: null });
  });

  it("stores the fixture page and skips its now-playing item", async () => {
    await seedUser();
    const fetcher = async (url: string) =>
      new URL(url).searchParams.has("to")
        ? ok([])
        : { status: 200, body: fixture };
    const result = await pullLastFm(env, await sourceRow(), fetcher, now, 0);
    expect(result.inserted).toBe(199);
    expect(await count("plays")).toBe(199);
    expect(fixture.recenttracks["@attr"].user).toBe("fixture");
    expect(fixture.recenttracks["@attr"].totalPages).toBe("3");
  });

  it("keeps the backfill when the walk page holds only the now-playing item", async () => {
    await seedUser();
    const history = Array.from({ length: 500 }, (_, index) =>
      track(index, now - 10 - index),
    );
    const fetcher = async (url: string) => {
      const params = new URL(url).searchParams;
      const limit = Number(params.get("limit"));
      const from = params.has("from") ? Number(params.get("from")) : 0;
      const to = params.has("to")
        ? Number(params.get("to"))
        : Number.MAX_SAFE_INTEGER;
      const page = history
        .filter(
          (item) => Number(item.date.uts) >= from && Number(item.date.uts) < to,
        )
        .slice(0, limit);
      return ok([nowPlaying, ...page]);
    };
    let pullAt = now;
    for (let pull = 0; pull < 10; pull += 1) {
      await pullLastFm(env, await sourceRow(), fetcher, pullAt, 0);
      pullAt += 60;
    }
    expect(await count("plays")).toBe(500);
    expect(
      await env.DB.prepare(
        "SELECT backfill_before FROM sources WHERE id = 10",
      ).first<{ backfill_before: number | null }>(),
    ).toEqual({ backfill_before: null });
  });

  it("stops the backfill at two million Last.fm plays", async () => {
    await seedUser({
      cursor: now,
      backfill_before: now - 100,
      play_count: 2_000_000,
    });
    const fetcher = vi.fn(async (url: string) =>
      new URL(url).searchParams.has("to") ? ok([track(0, now - 200)]) : ok([]),
    );
    const result = await pullLastFm(env, await sourceRow(), fetcher, now, 0);
    expect(result.inserted).toBe(0);
    expect(fetcher.mock.calls.some((call) => paramsOf(call).has("to"))).toBe(
      false,
    );
  });

  it("records an error when the user hides recent listening", async () => {
    await seedUser();
    const fetcher = async () => ({
      status: 200,
      body: { error: 17, message: "Recent tracks hidden" },
    });
    await expect(
      pullLastFm(env, await sourceRow(), fetcher, now, 0),
    ).rejects.toThrow("hides recent listening");
  });

  it("waits out the reset after a 429", async () => {
    await seedUser();
    const fetcher = async () => ({ status: 429, resetIn: 45 });
    const result = await pullLastFm(env, await sourceRow(), fetcher, now, 0);
    expect(result.inserted).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT next_pull_at, idle_pulls FROM sources WHERE id = 10",
      ).first<{ next_pull_at: number; idle_pulls: number }>(),
    ).toEqual({ next_pull_at: now + 45, idle_pulls: 0 });
  });

  it("runs a due Last.fm source through the Worker scheduled handler when approval is set", async () => {
    await seedUser();
    env.LASTFM_APPROVAL = "local";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify(ok([track(0, now - 10)]).body), {
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
  });
});
