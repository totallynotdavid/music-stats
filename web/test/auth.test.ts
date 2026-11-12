import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";

const now = Math.floor(Date.now() / 1000);
const origin = "https://music.rising.sh";

const testEnv = () => ({
  DB: env.DB,
  CACHE: env.CACHE,
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
});

function cookieValue(response: Response, name: string) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${name}=([^;]*)`).exec(header);
  return match?.[1];
}

function githubMock(user: { id: number; login: string }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://github.com/login/oauth/access_token")
      return new Response(JSON.stringify({ access_token: "gh-token" }), {
        headers: { "content-type": "application/json" },
      });
    if (url === "https://api.github.com/user")
      return new Response(JSON.stringify(user), {
        headers: { "content-type": "application/json" },
      });
    return new Response("unexpected", { status: 500 });
  });
}

async function begin() {
  const response = await app.fetch(
    new Request(`${origin}/auth/github`),
    testEnv() as never,
  );
  const state = new URL(
    response.headers.get("location") ?? "",
  ).searchParams.get("state");
  return { response, state };
}

async function signIn(user: { id: number; login: string }) {
  const { state } = await begin();
  const fetcher = githubMock(user);
  vi.stubGlobal("fetch", fetcher);
  const response = await app.fetch(
    new Request(`${origin}/auth/github/callback?code=code-1&state=${state}`, {
      headers: { cookie: `__Host-oauth-state=${state}` },
    }),
    testEnv() as never,
  );
  return {
    response,
    fetcher,
    session: cookieValue(response, "__Host-session"),
  };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sign-in page", () => {
  it("states that profiles are public", async () => {
    const response = await app.fetch(
      new Request(`${origin}/`),
      testEnv() as never,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Profiles are public");
    expect(body).toContain("/auth/github");
  });

  it("redirects a signed-in visitor to settings", async () => {
    const { session } = await signIn({ id: 7, login: "octo" });
    const response = await app.fetch(
      new Request(`${origin}/`, {
        headers: { cookie: `__Host-session=${session}` },
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings");
  });
});

describe("/auth/github", () => {
  it("redirects to GitHub with a state cookie and no scope", async () => {
    const { response } = await begin();
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.origin + target.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(target.searchParams.get("client_id")).toBe("test-client-id");
    expect(target.searchParams.get("redirect_uri")).toBe(
      `${origin}/auth/github/callback`,
    );
    expect(target.searchParams.get("state")).toHaveLength(22);
    expect(target.searchParams.has("scope")).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("__Host-oauth-state=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("answers 503 when the client id and secret are missing", async () => {
    const response = await app.fetch(new Request(`${origin}/auth/github`), {
      DB: env.DB,
      CACHE: env.CACHE,
    } as never);
    expect(response.status).toBe(503);
  });
});

describe("/auth/github/callback", () => {
  it.each<[string, { cookie?: string }]>([
    ["a missing state cookie", {}],
    ["a mismatched state", { cookie: "other" }],
  ])("rejects %s", async (_name, setup) => {
    const { state } = await begin();
    const response = await app.fetch(
      new Request(`${origin}/auth/github/callback?code=c&state=${state}`, {
        headers:
          setup.cookie === undefined
            ? {}
            : { cookie: `__Host-oauth-state=${setup.cookie}` },
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(400);
  });

  it("creates the user, stores github_id and discards the token", async () => {
    const { response, fetcher, session } = await signIn({
      id: 12345,
      login: "OctoCat",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(session).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("__Host-session=");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");

    const user = await env.DB.prepare(
      "SELECT github_id, name, is_public FROM users",
    ).first<{ github_id: number; name: string; is_public: number }>();
    expect(user).toEqual({ github_id: 12345, name: "octocat", is_public: 1 });
    const sessions = await env.DB.prepare(
      "SELECT user_id, expires_at FROM sessions",
    ).all<{ user_id: number; expires_at: number }>();
    expect(sessions.results).toHaveLength(1);
    expect(sessions.results[0]?.expires_at).toBeGreaterThanOrEqual(
      now + 29 * 86400,
    );
    const columnCheck = await env.DB.prepare(
      "SELECT * FROM users WHERE github_id = 12345",
    ).first();
    expect(JSON.stringify(columnCheck)).not.toContain("gh-token");
  });

  it("keeps a renamed profile name on the next sign-in", async () => {
    await env.DB.prepare(
      "INSERT INTO users (github_id, name, created_at) VALUES (9, 'renamed', ?1)",
    )
      .bind(now)
      .run();
    await signIn({ id: 9, login: "Whatever" });
    const user = await env.DB.prepare(
      "SELECT name FROM users WHERE github_id = 9",
    ).first<{ name: string }>();
    expect(user?.name).toBe("renamed");
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });

  it("picks a free name when the GitHub login is taken", async () => {
    await env.DB.prepare(
      "INSERT INTO users (github_id, name, created_at) VALUES (1, 'octo', ?1)",
    )
      .bind(now)
      .run();
    await signIn({ id: 42, login: "Octo" });
    const user = await env.DB.prepare(
      "SELECT name FROM users WHERE github_id = 42",
    ).first<{ name: string }>();
    expect(user?.name).toBe("octo-2");
  });

  it("answers 502 when the code exchange fails", async () => {
    const { state } = await begin();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 })),
    );
    const response = await app.fetch(
      new Request(`${origin}/auth/github/callback?code=bad&state=${state}`, {
        headers: { cookie: `__Host-oauth-state=${state}` },
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(502);
  });
});
