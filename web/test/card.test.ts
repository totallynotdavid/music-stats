import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migrations from "virtual:web-migrations";
import { cutToWidth, displayWidth, renderCard } from "../src/card";
import type { PeriodStats } from "../src/types";

const now = Math.floor(Date.now() / 1000);

async function seedUser() {
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, name, created_at) VALUES (1, 1, 'alice', ?1)",
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sources (id, user_id, kind, account, next_pull_at) VALUES (10, 1, 'listenbrainz', 'alice-lb', ?1)",
  )
    .bind(now)
    .run();
}

async function seedTracks(titles: string[]) {
  for (const [index, title] of titles.entries()) {
    const artist = await env.DB.prepare(
      "INSERT INTO artists (key, name) VALUES (?1, ?2) RETURNING id",
    )
      .bind(`artist-${index}`, `Artist ${index}`)
      .first<{ id: number }>();
    const track = await env.DB.prepare(
      "INSERT INTO tracks (key, artist_id, title) VALUES (?1, ?2, ?3) RETURNING id",
    )
      .bind(`artist-${index}${title}`, artist?.id, title)
      .first<{ id: number }>();
    for (let play = 0; play < titles.length - index; play += 1) {
      await env.DB.prepare(
        "INSERT INTO plays (user_id, played_at, source_id, track_id) VALUES (1, ?1, 10, ?2)",
      )
        .bind(now - index * 100 - play, track?.id)
        .run();
    }
  }
}

async function fetchCard(query = "") {
  return SELF.fetch(`https://music.rising.sh/u/alice.svg${query}`);
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

describe("card", () => {
  it("renders each theme", async () => {
    await seedUser();
    const light = await (await fetchCard("?theme=light")).text();
    const dark = await (await fetchCard("?theme=dark")).text();
    expect(light).toContain("oklch(99% 0.008 84)");
    expect(dark).toContain("oklch(25% 0.03 70)");
    expect(dark).not.toBe(light);
  });

  it("serves the headers the public surface requires", async () => {
    await seedUser();
    for (const url of [
      "https://music.rising.sh/u/alice.svg",
      "https://music.rising.sh/u/alice.json",
    ]) {
      const response = await SELF.fetch(url);
      expect(response.headers.get("Content-Security-Policy")).toBe(
        "default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=900");
    }
    const card = await fetchCard();
    expect(card.headers.get("Content-Type")).toBe("image/svg+xml");
    const json = await SELF.fetch("https://music.rising.sh/u/alice.json");
    expect(json.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("answers 400 for each invalid parameter", async () => {
    await seedUser();
    for (const query of [
      "?period=day",
      "?period=",
      "?n=0",
      "?n=11",
      "?n=05",
      "?n=0005",
      "?n=two",
      "?n=1.5",
      "?n=",
      "?theme=sepia",
      "?theme=",
    ]) {
      expect((await fetchCard(query)).status, query).toBe(400);
    }
  });

  it("bounds n to 1..10 rows with a default of 5", async () => {
    await seedUser();
    await seedTracks(["One", "Two", "Three", "Four", "Five", "Six", "Seven"]);
    const defaultsTo = await (await fetchCard()).text();
    expect(defaultsTo).toContain("Five");
    expect(defaultsTo).not.toContain("Six");
    const one = await (await fetchCard("?n=1")).text();
    expect(one).toContain("One");
    expect(one).not.toContain("Two");
    const ten = await (await fetchCard("?n=10")).text();
    expect(ten).toContain("Seven");
  });

  it("answers 404 for a hidden or unknown user", async () => {
    await seedUser();
    await env.DB.prepare(
      "INSERT INTO users (github_id, name, is_public, created_at) VALUES (2, 'hidden', 0, ?1)",
    )
      .bind(now)
      .run();
    expect(
      (await SELF.fetch("https://music.rising.sh/u/hidden.svg")).status,
    ).toBe(404);
    expect(
      (await SELF.fetch("https://music.rising.sh/u/unknown.svg")).status,
    ).toBe(404);
  });

  it("reads one stored snapshot on the profile, the JSON and the card", async () => {
    await seedUser();
    await seedTracks(["One", "Two", "Three"]);
    const json = await (
      await SELF.fetch("https://music.rising.sh/u/alice.json?period=month")
    ).json<any>();
    expect(json.plays).toBe(6);
    expect(await env.CACHE.get("snap:1:month", "json")).toEqual(json);
    const track = await env.DB.prepare("SELECT id FROM tracks LIMIT 1").first<{
      id: number;
    }>();
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, track_id) VALUES (1, ?1, 10, ?2)",
    )
      .bind(now - 30, track?.id)
      .run();
    const card = await (await fetchCard("?period=month")).text();
    const profile = await (
      await SELF.fetch("https://music.rising.sh/u/alice?period=month")
    ).text();
    const updated = new Date(json.updated_at * 1000)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
    expect(card).toContain(`${json.plays} plays`);
    expect(card).toContain(`Updated ${updated} UTC`);
    expect(profile).toContain(`<strong>${json.plays}</strong>`);
    expect(profile).toContain(`Updated ${updated} UTC`);
    expect(profile).toContain("u/alice.svg");
    const secondCard = await (await fetchCard("?period=month&n=2")).text();
    expect(secondCard).toContain(`Updated ${updated} UTC`);
  });
});

describe("card text", () => {
  const snapshot = {
    schema: 1,
    user: { name: "alice" },
    period: "week",
    from: now - 7 * 86400,
    to: now,
    plays: 3,
    unique_tracks: 1,
    unique_artists: 1,
    top_tracks: [{ title: "A<&\"' title", artist: "An<&\"' artist", plays: 3 }],
    top_artists: [{ artist: "An<&\"' artist", plays: 3 }],
    daily: [{ day: "2026-11-12", plays: 3 }],
    updated_at: now,
  } satisfies PeriodStats;

  it("escapes markup in artist, title and name", () => {
    const svg = renderCard(snapshot, 5, "light");
    expect(svg).toContain("A&lt;&amp;&quot;&#39; title");
    expect(svg).toContain("An&lt;&amp;&quot;&#39; artist");
    expect(svg).not.toContain('A<&"');
  });

  it("cuts text by display width with wide characters counting two", () => {
    expect(displayWidth("ラーメン")).toBe(8);
    expect(displayWidth("🚀")).toBe(2);
    expect(displayWidth("🫠")).toBe(2);
    expect(displayWidth("❤️")).toBe(2);
    expect(displayWidth("\u{3040}")).toBe(1);
    expect(displayWidth("\u{302e}")).toBe(0);
    expect(displayWidth("\u{e0101}")).toBe(0);
    expect(
      displayWidth("🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"),
    ).toBe(2);
    expect(displayWidth("\u{17d8}")).toBe(3);
    expect(cutToWidth("ラーメンラーメン", 10)).toBe("ラーメン…");
    expect(cutToWidth("あいうえおかき", 10)).toBe("あいうえ…");
    expect(cutToWidth("plain title", 20)).toBe("plain title");
    const svg = renderCard(
      {
        ...snapshot,
        top_tracks: [
          {
            title: "あいうえおかきくけこさしすせそ",
            artist: "artist",
            plays: 1,
          },
        ],
      },
      5,
      "light",
    );
    expect(svg).toContain("あいうえおかきくけこさし…");
    expect(svg).not.toContain("せそ");
  });
});
