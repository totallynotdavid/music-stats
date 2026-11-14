import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import {
  openTokens,
  playInputs,
  pullSpotify,
  sealTokens,
} from "../src/spotify";
import type { SourceRow } from "../src/types";
import fixture from "./fixtures/spotify-recently-played.json";

const now = Math.floor(Date.now() / 1000);
const origin = "https://music.rising.sh";
const session = `sess_${"s".repeat(40)}`;
const key = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);

const testEnv = () => ({
  DB: env.DB,
  CACHE: env.CACHE,
  SPOTIFY_CLIENT_ID: "spotify-id",
  SPOTIFY_CLIENT_SECRET: "spotify-secret",
  SOURCE_ENCRYPTION_KEY: key,
});

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function seedUser() {
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, name, created_at) VALUES (1, 1, 'alice', ?1)",
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, 1, ?2)",
  )
    .bind(await sha256(session), now + 30 * 86400)
    .run();
}

async function seedSource(tokens: object, extra = "") {
  const secret = await sealTokens(testEnv() as never, tokens as never);
  await env.DB.prepare(
    `INSERT INTO sources (id, user_id, kind, account, secret, next_pull_at)
     VALUES (10, 1, 'spotify', 'spotify-user', ?1, ?2) ${extra}`,
  )
    .bind(secret, now)
    .run();
}

async function sourceRow() {
  return (await env.DB.prepare("SELECT * FROM sources").first()) as SourceRow;
}

const cookie = `__Host-session=${session}`;

function callback(query: string, state: string | null) {
  return app.fetch(
    new Request(`${origin}/auth/spotify/callback?${query}`, {
      headers: {
        cookie:
          state === null ? cookie : `${cookie}; __Host-spotify-state=${state}`,
      },
    }),
    testEnv() as never,
  );
}

function apiFetch(pages: Record<string, () => Response>) {
  return async (input: RequestInfo | URL) => {
    const url = input.toString();
    for (const [prefix, make] of Object.entries(pages))
      if (url.startsWith(prefix)) return make();
    return new Response("unexpected url " + url, { status: 500 });
  };
}

const tokenOk = (refresh = "refresh-1") =>
  new Response(
    JSON.stringify({
      access_token: "access-1",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: "user-read-recently-played",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const playsBody = () =>
  new Response(JSON.stringify(fixture), {
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

describe("connect", () => {
  it("refuses a missing state and a wrong state", async () => {
    await seedUser();
    expect((await callback("code=c&state=x", null)).status).toBe(400);
    expect((await callback("code=c&state=x", "other")).status).toBe(400);
    expect((await callback("state=x", "x")).status).toBe(400);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM sources").first<{
        n: number;
      }>(),
    ).toEqual({ n: 0 });
  });

  it("stores a sealed source on a good callback", async () => {
    await seedUser();
    vi.stubGlobal(
      "fetch",
      apiFetch({
        "https://accounts.spotify.com/api/token": () => tokenOk(),
        "https://api.spotify.com/v1/me": () =>
          new Response(JSON.stringify({ id: "spotify-user" }), { status: 200 }),
      }),
    );
    const response = await app.fetch(
      new Request(`${origin}/auth/spotify/callback?code=c&state=good`, {
        headers: { cookie: `${cookie}; __Host-spotify-state=good` },
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(303);
    const source = await sourceRow();
    expect(source.kind).toBe("spotify");
    expect(source.account).toBe("spotify-user");
    expect(source.next_pull_at).toBeGreaterThan(0);
    const secret = new TextDecoder().decode(
      new Uint8Array(source.secret as ArrayBuffer),
    );
    expect(secret).not.toContain("refresh-1");
    const tokens = await openTokens(
      testEnv() as never,
      source.secret as Uint8Array,
    );
    expect(tokens.r).toBe("refresh-1");
    expect(tokens.a).toBe("access-1");
  });
});

describe("pull", () => {
  it("stores the fixture plays once and none again", async () => {
    await seedUser();
    await seedSource({ r: "refresh-1", a: "access-1", e: now + 3600 });
    const fetcher = apiFetch({
      "https://api.spotify.com/v1/me/player/recently-played": () => playsBody(),
    });
    const first = await pullSpotify(
      testEnv() as never,
      await sourceRow(),
      fetcher,
      now,
    );
    expect(first.inserted).toBe(fixture.items.length);
    const plays = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM plays",
    ).first<{ n: number }>();
    const second = await pullSpotify(
      testEnv() as never,
      await sourceRow(),
      fetcher,
      now + 900,
    );
    expect(second.inserted).toBe(0);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM plays").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(plays?.n);
  });

  it("refreshes an expired access token and stores a rotated refresh token", async () => {
    await seedUser();
    await seedSource({ r: "refresh-old", a: "access-old", e: now - 10 });
    const calls: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      const url = input.toString();
      calls.push(url);
      if (url.startsWith("https://accounts.spotify.com/api/token"))
        return tokenOk("refresh-new");
      return playsBody();
    };
    const result = await pullSpotify(
      testEnv() as never,
      await sourceRow(),
      fetcher,
      now,
    );
    expect(result.inserted).toBe(fixture.items.length);
    expect(calls[0]).toContain("/api/token");
    const tokens = await openTokens(
      testEnv() as never,
      (await sourceRow()).secret as Uint8Array,
    );
    expect(tokens.r).toBe("refresh-new");
    expect(tokens.a).toBe("access-1");
  });

  it("sets the error status on invalid_grant", async () => {
    await seedUser();
    await seedSource({ r: "refresh-dead" });
    const fetcher = apiFetch({
      "https://accounts.spotify.com/api/token": () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
    });
    await pullSpotify(testEnv() as never, await sourceRow(), fetcher, now);
    const source = await sourceRow();
    expect(source.status).toBe("error");
    expect(source.error).toContain("connect Spotify");
    expect(source.next_pull_at).toBeNull();
  });

  it("waits out Retry-After on a 429", async () => {
    await seedUser();
    await seedSource({ r: "refresh-1", a: "access-1", e: now + 3600 });
    const fetcher = apiFetch({
      "https://api.spotify.com/v1/me/player/recently-played": () =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "90" },
        }),
    });
    await pullSpotify(testEnv() as never, await sourceRow(), fetcher, now);
    const source = await sourceRow();
    expect(source.next_pull_at).toBe(now + 90);
    expect(source.status).toBe("active");
  });
});

describe("fixture shape", () => {
  it("maps a play to a spotify alias and isrc", () => {
    const inputs = playInputs(
      fixture.items.slice(0, 1).map((item) => ({
        at: Math.floor(Date.parse(item.played_at) / 1000),
        track: item.track as never,
      })),
      1,
      10,
    );
    expect(inputs[0]?.kind).toBe("spotify");
    expect(inputs[0]?.sourceKey).toBe(fixture.items[0]?.track.id);
    expect(inputs[0]?.isrc).toBe(fixture.items[0]?.track.external_ids.isrc);
  });
});
