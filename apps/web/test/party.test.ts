import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migrations from "virtual:web-migrations";
import {
  blend,
  youtubePlaylistUrl,
  type PartyCandidate,
  type PartyUser,
} from "../src/party-blend";

const now = Math.floor(Date.now() / 1000);

function candidate(
  trackId: number,
  artist: string,
  plays: number,
  videoId: string | null = `v${trackId}`,
): PartyCandidate {
  return {
    trackId,
    title: `Song ${trackId}`,
    artist,
    artistKey: artist,
    videoId,
    plays,
  };
}

function user(name: string, tracks: PartyCandidate[]): PartyUser {
  return { name, tracks };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

describe("blend", () => {
  it("puts shared tracks first, ordered by how many people share them", () => {
    const items = blend(
      [
        user("a", [
          candidate(1, "X", 9),
          candidate(2, "Y", 8),
          candidate(3, "Z", 7),
        ]),
        user("b", [candidate(3, "Z", 9), candidate(2, "Y", 7)]),
        user("c", [candidate(3, "Z", 6)]),
      ],
      4,
    );
    expect(items.map((item) => item.trackId)).toEqual([3, 2, 1]);
    expect(items[0]?.names).toEqual(["a", "b", "c"]);
    expect(items[1]?.names).toEqual(["a", "b"]);
  });

  it("round-robins the rest so a heavy listener cannot dominate", () => {
    const items = blend(
      [
        user(
          "heavy",
          [1, 2, 3, 4, 5, 6].map((id) => candidate(id, "X", 100 - id)),
        ),
        user("light", [candidate(7, "Y", 1)]),
      ],
      5,
    );
    expect(items.map((item) => item.trackId)).toEqual([1, 7, 2, 3, 4]);
    expect(items[1]?.names).toEqual(["light"]);
  });

  it("defers a turn so an artist sits at least four slots apart", () => {
    const items = blend(
      [
        user("a", [candidate(1, "Same", 9), candidate(2, "Same", 8)]),
        user("b", [
          candidate(3, "X", 9),
          candidate(4, "Y", 8),
          candidate(5, "Z", 7),
          candidate(6, "W", 6),
        ]),
      ],
      6,
    );
    expect(items.map((item) => item.trackId)).toEqual([1, 3, 4, 5, 2, 6]);
  });

  it("places a close artist when every candidate violates the gap", () => {
    const items = blend(
      [
        user(
          "a",
          [1, 2, 3].map((id) => candidate(id, "Same", 9 - id)),
        ),
      ],
      3,
    );
    expect(items.map((item) => item.trackId)).toEqual([1, 2, 3]);
  });

  it("is deterministic for the same input", () => {
    const users = [
      user("a", [candidate(1, "X", 5), candidate(2, "Y", 4)]),
      user("b", [candidate(2, "Y", 5), candidate(3, "Z", 4)]),
    ];
    expect(blend(users, 4)).toEqual(blend(users, 4));
  });

  it("builds the YouTube link from video ids only, capped at 50", () => {
    const items = blend(
      [
        user(
          "a",
          Array.from({ length: 75 }, (_, index) =>
            candidate(
              index + 1,
              `Artist ${index}`,
              100 - index,
              index % 15 === 0 ? null : `vid-${index}`,
            ),
          ),
        ),
      ],
      75,
    );
    const url = youtubePlaylistUrl(items);
    expect(url).not.toBeNull();
    expect(
      url?.startsWith("https://www.youtube.com/watch_videos?video_ids="),
    ).toBe(true);
    const ids = url?.split("video_ids=")[1]?.split(",");
    expect(ids).toHaveLength(50);
    expect(ids?.every((id) => id.startsWith("vid-"))).toBe(true);
    expect(items.filter((item) => item.videoId === null)).toHaveLength(5);
  });

  it("returns no link when no track has a video id", () => {
    const items = blend(
      [user("a", [candidate(1, "X", 5, null), candidate(2, "Y", 4, null)])],
      2,
    );
    expect(youtubePlaylistUrl(items)).toBeNull();
  });
});

async function seedParty(withAliases = true) {
  await env.DB.prepare(
    `INSERT INTO users (id, github_id, name, is_public, created_at) VALUES
     (1, 1, 'alice', 1, ?1), (2, 2, 'bob', 1, ?1), (3, 3, 'carol', 0, ?1)`,
  )
    .bind(now)
    .run();
  await env.DB.prepare(
    `INSERT INTO sources (id, user_id, kind) VALUES
     (10, 1, 'spotify'), (20, 2, 'spotify'), (30, 3, 'spotify')`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO artists (id, key, name) VALUES
     (1, 'arta', 'Artist A'), (2, 'artb', 'Artist B'), (3, 'artc', 'Artist C')`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO tracks (id, key, artist_id, title) VALUES
     (1, 'artaone', 1, 'One'), (2, 'artbtwo', 2, 'Two'),
     (3, 'artcthree', 3, 'Three'), (4, 'artafour', 1, 'Four')`,
  ).run();
  const play = (
    userId: number,
    sourceId: number,
    trackId: number,
    offset: number,
  ) =>
    env.DB.prepare(
      `INSERT INTO plays (user_id, played_at, source_id, track_id)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(userId, now - offset, sourceId, trackId);
  // Shared: track 1 for alice and bob. Rest: alice 2, bob 3, bob 4.
  await play(1, 10, 1, 3600).run();
  await play(1, 10, 2, 3700).run();
  await play(2, 20, 1, 3600).run();
  await play(2, 20, 3, 3700).run();
  await play(2, 20, 4, 3800).run();
  if (withAliases)
    await env.DB.prepare(
      `INSERT INTO track_aliases (kind, source_key, track_id) VALUES
       ('ytmusic', 'vid-one', 1), ('ytmusic', 'vid-two', 2),
       ('ytmusic', 'vid-three', 3)`,
    ).run();
}

describe("party route", () => {
  it("renders the form", async () => {
    const response = await SELF.fetch("https://music.rising.sh/party");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Party playlist");
    expect(html).toContain('name="u"');
    expect(html).toContain('name="n"');
  });

  it("redirects to the canonical shareable URL", async () => {
    const response = await SELF.fetch(
      "https://music.rising.sh/party?u=Alice&u=bob",
      { redirect: "manual" },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/party?u=alice%2Cbob&n=25");
  });

  it("blends two public profiles and lists tracks with no video id", async () => {
    await seedParty();
    const response = await SELF.fetch(
      "https://music.rising.sh/party?u=alice,bob&n=25",
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Play on YouTube");
    expect(html).toContain("watch_videos?video_ids=vid-one,vid-two,vid-three");
    expect(html).toContain("1 of 4 tracks have no YouTube link yet");
    expect(html).toContain("No YouTube link yet");
    expect(html).toContain("Four");
    expect(html).toContain("Artist A · alice + bob");
  });

  it("lists every track when none has a YouTube link", async () => {
    await seedParty(false);
    const response = await SELF.fetch(
      "https://music.rising.sh/party?u=alice,bob&n=25",
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("Play on YouTube");
    expect(html).not.toContain("video_ids=");
    expect(html).toContain("None of these tracks has a YouTube link yet.");
    for (const title of ["One", "Two", "Three", "Four"])
      expect(html).toContain(title);
  });

  it("refuses a private and an unknown profile the same way", async () => {
    await seedParty();
    const hidden = await SELF.fetch(
      "https://music.rising.sh/party?u=alice,carol",
    );
    const unknown = await SELF.fetch(
      "https://music.rising.sh/party?u=alice,nobody",
    );
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await hidden.text()).toBe(await unknown.text());
  });

  it.each(["u=alice,a%20b", "u=alice,a'b", "u=alice,a%27b"])(
    "does not loop on a name that needs percent-encoding (%s)",
    async (query) => {
      await seedParty();
      const first = await SELF.fetch(
        `https://music.rising.sh/party?${query}&n=25`,
        { redirect: "manual" },
      );
      const location = first.headers.get("location");
      if (first.status === 303 && location !== null) {
        const second = await SELF.fetch(`https://music.rising.sh${location}`, {
          redirect: "manual",
        });
        expect(second.status).toBe(404);
        return;
      }
      expect(first.status).toBe(404);
      expect(await first.text()).toContain("Profiles not available");
    },
  );

  it("prefills a single profile without an error", async () => {
    const response = await SELF.fetch("https://music.rising.sh/party?u=alice");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('value="alice"');
    expect(html).toContain("Add at least one more public profile.");
  });

  it("rejects a bad length and too many profiles", async () => {
    expect(
      (await SELF.fetch("https://music.rising.sh/party?u=a,b&n=12")).status,
    ).toBe(400);
    expect(
      (await SELF.fetch("https://music.rising.sh/party?u=a,b,c,d,e,f,g,h,i"))
        .status,
    ).toBe(400);
  });
});
