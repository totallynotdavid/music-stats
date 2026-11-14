import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import { pullDueSources } from "../src/cron";
import { openSecret, sealSecret } from "../src/secret";
import { pullIntervalSeconds } from "../src/ytmusic";

const now = Math.floor(Date.now() / 1000);
const origin = "https://music.rising.sh";
const session = `sess_${"s".repeat(40)}`;
const cookie = "__Secure-3PAPISID=fake-sapisid; SID=fake-sid";
const key = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);

const testEnv = () => ({
  DB: env.DB,
  CACHE: env.CACHE,
  SOURCE_ENCRYPTION_KEY: key,
});

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

function jsEscape(text: string) {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    const char = String.fromCharCode(byte);
    out += /[a-zA-Z0-9]/.test(char)
      ? char
      : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

function watchRun(text: string, videoId: string) {
  return {
    text,
    navigationEndpoint: { watchEndpoint: { videoId } },
  };
}

function artistRun(text: string) {
  return {
    text,
    navigationEndpoint: {
      browseEndpoint: {
        browseEndpointContextSupportedConfigs: {
          browseEndpointContextMusicConfig: {
            pageType: "MUSIC_PAGE_TYPE_ARTIST",
          },
        },
      },
    },
  };
}

function item(title: string, videoId: string) {
  return {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [watchRun(title, videoId)] },
          },
        },
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [artistRun("Artist " + title)] },
          },
        },
      ],
    },
  };
}

function shelf(title: string, contents: unknown[]) {
  return {
    musicShelfRenderer: {
      title: { runs: [{ text: title }] },
      contents,
    },
  };
}

function page(items: Array<[string, string]>, label = "Today") {
  const json = JSON.stringify({
    contents: {
      singleColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    shelf(
                      label,
                      items.map(([t, v]) => item(t, v)),
                    ),
                  ],
                },
              },
            },
          },
        ],
      },
    },
  });
  return (
    `<html><script>ytcfg.set({"LOGGED_IN":true});</script>` +
    `<script>initialData.push({path: '/browse', data: '${jsEscape(json)}'});` +
    `ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});</script></html>`
  );
}

const signedOut = () =>
  `<html><script>ytcfg.set({"LOGGED_IN":false});</script></html>`;

function stubFetch(page: string | (() => string)) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () => new Response(typeof page === "string" ? page : page()),
    );
}

async function seedUser(userId = 1) {
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, name, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(userId, userId * 1000, "alice", now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
  )
    .bind(await sha256(session), userId, now + 30 * 86400)
    .run();
}

async function seedConnected(tz = "UTC", sourceId = 10, userId = 1) {
  const secret = await sealSecret(testEnv() as never, cookie);
  await env.DB.prepare(
    `INSERT INTO sources (id, user_id, kind, secret, tz, next_pull_at)
     VALUES (?1, ?2, 'ytmusic', ?3, ?4, ?5)`,
  )
    .bind(sourceId, userId, secret, tz, now)
    .run();
}

function get(path: string) {
  return app.fetch(
    new Request(`${origin}${path}`, {
      headers: { cookie: `__Host-session=${session}` },
    }),
    testEnv() as never,
  );
}

function post(path: string, fields: Record<string, string>) {
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        cookie: `__Host-session=${session}`,
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams(fields).toString(),
    }),
    testEnv() as never,
  );
}

async function sourceRow(id = 10) {
  if (id === 0)
    return env.DB.prepare(
      "SELECT * FROM sources WHERE user_id = 1 AND kind = 'ytmusic'",
    ).first<Record<string, unknown>>();
  return env.DB.prepare("SELECT * FROM sources WHERE id = ?1")
    .bind(id)
    .first<Record<string, unknown>>();
}

async function playsCount(userId = 1) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM plays WHERE user_id = ?1",
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connect", () => {
  it("stores the cookie encrypted and imports the first page", async () => {
    await seedUser();
    stubFetch(
      page([
        ["Song A", "vida"],
        ["Song B", "vidb"],
        ["Song C", "vidc"],
      ]),
    );
    const response = await post("/settings/ytmusic", {
      cookie,
      tz: "Europe/Berlin",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("3 plays stored");

    const source = await sourceRow(0);
    const secret = source?.secret as ArrayBuffer;
    expect(secret).toBeTruthy();
    expect(new TextDecoder().decode(new Uint8Array(secret))).not.toContain(
      "fake-sapisid",
    );
    expect(await openSecret(testEnv() as never, secret)).toBe(cookie);
    expect(source?.tz).toBe("Europe/Berlin");
    expect(source?.next_pull_at).toBeGreaterThanOrEqual(
      now + pullIntervalSeconds,
    );
    expect(await playsCount()).toBe(3);

    const html = await (await get("/settings")).text();
    expect(html).toContain("cookie");
    expect(html).not.toContain(cookie);
    expect(html).not.toContain("fake-sapisid");
  });

  it("shares the source with an existing upload token", async () => {
    await seedUser();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind) VALUES (10, 1, 'ytmusic')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (10, ?1, 'abcd', ?2)",
    )
      .bind(await sha256(`msu_${"a".repeat(43)}`), now)
      .run();
    stubFetch(page([["Song A", "vida"]]));
    const response = await post("/settings/ytmusic", {
      cookie,
      tz: "UTC",
    });
    expect(response.status).toBe(200);
    const sources = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sources WHERE user_id = 1 AND kind = 'ytmusic'",
    ).first<{ n: number }>();
    expect(sources?.n).toBe(1);
    expect((await sourceRow())?.tz).toBe("UTC");
    expect(await playsCount()).toBe(1);
  });

  it("connects an empty history and schedules the pull", async () => {
    await seedUser();
    stubFetch(page([["Song A", "vida"]], "Last week"));
    const response = await post("/settings/ytmusic", {
      cookie,
      tz: "UTC",
    });
    expect(response.status).toBe(200);
    const source = await sourceRow(0);
    expect(source?.secret).toBeTruthy();
    expect(source?.play_seq).toBe(0);
    expect(source?.status).toBe("active");
    expect(source?.next_pull_at).toBeGreaterThanOrEqual(
      now + pullIntervalSeconds,
    );
    expect(await playsCount()).toBe(0);
  });

  it.each([
    {
      name: "a cookie without __Secure-3PAPISID",
      cookie: "SID=fake-sid; HSID=x",
      page: null,
      message: "__Secure-3PAPISID",
    },
    {
      name: "a signed-out page",
      cookie,
      page: signedOut(),
      message: "signed out",
    },
    {
      name: "a page that does not parse",
      cookie,
      page: `<html><script>ytcfg.set({"LOGGED_IN":true});</script></html>`,
      message: "did not parse",
    },
    {
      name: "an unknown time zone",
      cookie,
      page: null,
      tz: "Mars/Olympus",
      message: "time zone",
    },
  ])("refuses $name and stores nothing", async (entry) => {
    await seedUser();
    const fetcher = stubFetch(entry.page ?? signedOut());
    const response = await post("/settings/ytmusic", {
      cookie: entry.cookie,
      tz: entry.tz ?? "UTC",
    });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain(entry.message);
    expect(body).not.toContain(cookie);
    if (entry.page === null) expect(fetcher).not.toHaveBeenCalled();
    const sources = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sources",
    ).first<{ n: number }>();
    expect(sources?.n).toBe(0);
    expect(await playsCount()).toBe(0);
  });
});

describe("pull", () => {
  it("stores the page once across two pulls", async () => {
    await seedUser();
    await seedConnected();
    stubFetch(
      page([
        ["Song A", "vida"],
        ["Song B", "vidb"],
      ]),
    );
    await pullDueSources(testEnv() as never, now);
    expect(await playsCount()).toBe(2);
    const source = await sourceRow();
    expect(source?.next_pull_at).toBe(now + pullIntervalSeconds);
    expect(source?.status).toBe("active");

    await pullDueSources(testEnv() as never, now + pullIntervalSeconds);
    expect(await playsCount()).toBe(2);
  });

  it("stores each play once when a pull and an upload overlap", async () => {
    await seedUser();
    await seedConnected();
    await env.DB.prepare(
      "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (10, ?1, 'abcd', ?2)",
    )
      .bind(await sha256(`msu_${"a".repeat(43)}`), now)
      .run();
    stubFetch(
      page([
        ["Song A", "vida"],
        ["Song B", "vidb"],
      ]),
    );
    await pullDueSources(testEnv() as never, now);
    expect(await playsCount()).toBe(2);

    const today = new Date(now * 1000).toISOString().slice(0, 10);
    const response = await app.fetch(
      new Request(`${origin}/api/v1/upload`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer msu_${"a".repeat(43)}`,
        },
        body: JSON.stringify({
          plays: [
            {
              day: today,
              artist: "Artist C",
              title: "Song C",
              video_id: "vidc",
            },
            {
              day: today,
              artist: "Artist Song A",
              title: "Song A",
              video_id: "vida",
            },
            {
              day: today,
              artist: "Artist Song B",
              title: "Song B",
              video_id: "vidb",
            },
          ],
        }),
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inserted: 1 });
    expect(await playsCount()).toBe(3);
  });

  it("stops pulling on a signed-out page and reports the cause", async () => {
    await seedUser();
    await seedConnected();
    const fetcher = stubFetch(signedOut());
    await pullDueSources(testEnv() as never, now);
    const source = await sourceRow();
    expect(source?.status).toBe("error");
    expect(source?.error).toContain("signed you out");
    expect(source?.next_pull_at).toBeNull();

    await pullDueSources(testEnv() as never, now + 86400);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const html = await (await get("/settings")).text();
    expect(html).toContain("YouTube signed you out. Paste a new cookie.");
  });

  it("reschedules on an empty page and keeps the stored state", async () => {
    await seedUser();
    await seedConnected();
    const fetcher = stubFetch(
      page([
        ["Song A", "vida"],
        ["Song B", "vidb"],
      ]),
    );
    await pullDueSources(testEnv() as never, now);
    expect(await playsCount()).toBe(2);
    expect((await sourceRow())?.play_seq).toBe(2);

    fetcher.mockImplementation(
      async () => new Response(page([["Song C", "vidc"]], "Last week")),
    );
    await pullDueSources(testEnv() as never, now + pullIntervalSeconds);
    const source = await sourceRow();
    expect(await playsCount()).toBe(2);
    expect(source?.play_seq).toBe(2);
    expect(source?.status).toBe("active");
    expect(source?.next_pull_at).toBe(now + pullIntervalSeconds * 2);
  });

  it("backs off and retries after a network failure", async () => {
    await seedUser();
    await seedConnected();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connection reset"),
    );
    await pullDueSources(testEnv() as never, now);
    const source = await sourceRow();
    expect(source?.status).toBe("error");
    expect(source?.error).toBe("connection reset");
    expect(source?.idle_pulls).toBe(1);
    expect(source?.next_pull_at).toBeGreaterThan(now);
    expect(String(source?.error)).not.toContain(cookie);
  });
});

describe("disconnect and removal", () => {
  it("disconnects the cookie and keeps plays and tokens", async () => {
    await seedUser();
    await seedConnected();
    await env.DB.prepare(
      "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (10, ?1, 'abcd', ?2)",
    )
      .bind(await sha256("msu_x"), now)
      .run();
    stubFetch(page([["Song A", "vida"]]));
    await pullDueSources(testEnv() as never, now);
    expect(await playsCount()).toBe(1);

    const response = await post("/settings/ytmusic/disconnect", {});
    expect(response.status).toBe(303);
    const source = await sourceRow();
    expect(source?.secret).toBeNull();
    expect(source?.next_pull_at).toBeNull();
    expect(await playsCount()).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM tokens WHERE source_id = 10",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("removing the source deletes the cookie with it", async () => {
    await seedUser();
    await seedConnected();
    const response = await post("/settings/sources/remove", { id: "10" });
    expect(response.status).toBe(303);
    expect(await sourceRow()).toBeNull();
  });
});
