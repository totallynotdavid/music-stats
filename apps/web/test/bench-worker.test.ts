import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import worker from "../bench/index";
import { pullDueSources } from "../src/cron";

const now = Math.floor(Date.now() / 1000);
const key = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);

const testEnv = () =>
  ({
    ...env,
    SPOTIFY_CLIENT_ID: "spotify-id",
    SPOTIFY_CLIENT_SECRET: "spotify-secret",
    SPOTIFY_ENCRYPTION_KEY: key,
  }) as never;

describe("bench worker", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await reset();
  });

  it("leaves the bench source idle after /pull", async () => {
    await applyD1Migrations(env.DB, migrations);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await worker.fetch(
      new Request("http://bench/pull?repeat=1") as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      testEnv(),
    );
    expect(response.status).toBe(200);
    const source = await env.DB.prepare(
      "SELECT next_pull_at FROM sources WHERE id = -1",
    ).first<{ next_pull_at: number | null }>();
    expect(source?.next_pull_at).toBeNull();
    fetchSpy.mockClear();
    await pullDueSources(testEnv(), now + 86400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stores new plays on every repeat", async () => {
    await applyD1Migrations(env.DB, migrations);
    const response = await worker.fetch(
      new Request("http://bench/store?repeat=2") as Request<
        unknown,
        IncomingRequestCfProperties
      >,
      testEnv(),
    );
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM plays WHERE user_id = -1",
    ).first<{ n: number }>();
    expect(row?.n).toBe(300);
  });
});
