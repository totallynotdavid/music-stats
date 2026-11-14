import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import {
  buildGame,
  getGame,
  matchTyped,
  putGame,
  scoreFor,
  serveRound,
} from "../src/play/game";
import type { Candidate } from "../src/play/sources";

const origin = "https://music.rising.sh";
const testEnv = () => ({ DB: env.DB, CACHE: env.CACHE });

const deezerTrack = (id: number, title: string, preview = true) => ({
  id,
  title,
  link: `https://www.deezer.com/track/${id}`,
  preview: preview ? `https://cdn.example/${id}.mp3` : "",
  artist: { name: "Artist" },
  album: { cover_medium: `https://cdn.example/${id}.jpg` },
});

function stubFetch(
  handlers: Array<[RegExp, unknown | ((url: string) => unknown)]>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      for (const [pattern, body] of handlers) {
        if (pattern.test(url)) {
          const data = typeof body === "function" ? body(url) : body;
          return new Response(JSON.stringify(data), {
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

async function startGame(slug: string, mode: string) {
  const response = await app.fetch(
    new Request(`${origin}/play`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams({ category: slug, mode }).toString(),
    }),
    testEnv() as never,
  );
  expect(response.status).toBe(303);
  const location = response.headers.get("location") ?? "";
  expect(location).toMatch(/^\/play\//);
  return location.slice(6);
}

async function answer(id: string, fields: Record<string, string>) {
  return app.fetch(
    new Request(`${origin}/play/${id}/answer`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams(fields).toString(),
    }),
    testEnv() as never,
  );
}

async function next(id: string) {
  return app.fetch(
    new Request(`${origin}/play/${id}/next`, {
      method: "POST",
      headers: { origin },
    }),
    testEnv() as never,
  );
}

const get = (path: string) =>
  app.fetch(new Request(`${origin}${path}`), testEnv() as never);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/play", () => {
  it("lists the seeded categories", async () => {
    const response = await get("/play");
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const name of [
      "Pop",
      "Rock",
      "Metal",
      "K-pop",
      "Anime",
      "Top 50 Japan",
      "Top 50 Peru",
      "Top 50 Global",
      "From my listening",
    ])
      expect(body).toContain(name);
  });

  it("builds a game whose rounds have previews, skipping tracks without one", async () => {
    const chart = Array.from({ length: 12 }, (_, i) =>
      deezerTrack(100 + i, `Song ${i}`, i % 2 === 0),
    );
    stubFetch([
      [/api\.deezer\.com\/chart\/132\/tracks/, { data: chart }],
      [
        /api\.deezer\.com\/track\/(\d+)/,
        (url: string) => {
          const id = Number(/track\/(\d+)/.exec(url)![1]);
          return deezerTrack(id, "x", id % 2 === 0);
        },
      ],
    ]);
    const id = await startGame("pop", "typed");
    const response = await get(`/play/${id}`);
    expect(response.status).toBe(200);
    const game = await getGame(testEnv() as never, id);
    expect(game).not.toBeNull();
    const served = game!.candidates[game!.current!.index];
    expect(Number(served.title.replace("Song ", "")) % 2).toBe(0);
  });

  it("serves the same choices on every load of a round", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/chart\/132\/tracks/,
        {
          data: [1, 2, 3, 4, 5, 6].map((i) => deezerTrack(i, `Track ${i}`)),
        },
      ],
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => deezerTrack(Number(/track\/(\d+)/.exec(url)![1]), "x"),
      ],
    ]);
    const id = await startGame("pop", "choices");
    const first = await (await get(`/play/${id}`)).text();
    const second = await (await get(`/play/${id}`)).text();
    const pick = (body: string) =>
      [...body.matchAll(/name="choice" value="([^"]*)"/g)].map((m) => m[1]);
    expect(pick(first)).toHaveLength(4);
    expect(pick(first)).toEqual(pick(second));
  });

  it("keeps the right answer out of the round response", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/chart\/132\/tracks/,
        {
          data: [1, 2, 3, 4].map((i) =>
            deezerTrack(i, i === 1 ? "Secret Song" : `Other ${i}`),
          ),
        },
      ],
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => {
          const id = Number(/track\/(\d+)/.exec(url)![1]);
          return deezerTrack(id, id === 1 ? "Secret Song" : `Other ${id}`);
        },
      ],
    ]);
    const id = await startGame("pop", "typed");
    const body = await (await get(`/play/${id}`)).text();
    const served = (await getGame(testEnv() as never, id))!;
    const answer = served.candidates[served.current!.index];
    expect(body).not.toContain(answer.title);
    expect(body).toContain(`${answer.deezerId}.mp3`);
  });

  it("scores by the time the server measured, not a client value", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/chart\/132\/tracks/,
        {
          data: [1, 2, 3, 4].map((i) =>
            deezerTrack(i, i === 1 ? "Known Song" : `Filler ${i}`),
          ),
        },
      ],
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => {
          const id = Number(/track\/(\d+)/.exec(url)![1]);
          return deezerTrack(id, id === 1 ? "Known Song" : `Filler ${id}`);
        },
      ],
    ]);
    const id = await startGame("pop", "choices");
    await get(`/play/${id}`);
    const game = (await getGame(testEnv() as never, id))!;
    const answerTitle = game.candidates[game.current!.index].title;
    game.current!.servedAt = Date.now() - 5_000;
    await putGame(testEnv() as never, game);
    const response = await answer(id, { choice: answerTitle });
    expect(response.status).toBe(303);
    const done = (await getGame(testEnv() as never, id))!;
    expect(done.results[0].correct).toBe(true);
    expect(done.results[0].score).toBeGreaterThan(640);
    expect(done.results[0].score).toBeLessThanOrEqual(700);
    const timed = (await getGame(testEnv() as never, id))!;
    expect(timed.total).toBe(done.results[0].score);
  });

  it("accepts lenient typed answers and rejects a different title", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/chart\/132\/tracks/,
        {
          data: [1, 2, 3, 4].map((i) => deezerTrack(i, "Café del Mar")),
        },
      ],
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) =>
          deezerTrack(Number(/track\/(\d+)/.exec(url)![1]), "Café del Mar"),
      ],
    ]);
    const id = await startGame("pop", "typed");
    await get(`/play/${id}`);
    await answer(id, { answer: "cafe del mar (live)" });
    let game = (await getGame(testEnv() as never, id))!;
    expect(game.results[0].correct).toBe(true);
    await next(id);
    await get(`/play/${id}`);
    await answer(id, { answer: "Something Else Entirely" });
    game = (await getGame(testEnv() as never, id))!;
    expect(game.results.at(-1)!.correct).toBe(false);
    expect(game.results.at(-1)!.score).toBe(0);
  });

  it("refuses answers once a game is finished or gone", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/chart\/132\/tracks/,
        {
          data: [1, 2, 3, 4].map((i) =>
            deezerTrack(i, i === 1 ? "Only Song" : `Rest ${i}`),
          ),
        },
      ],
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => {
          const id = Number(/track\/(\d+)/.exec(url)![1]);
          return deezerTrack(id, id === 1 ? "Only Song" : `Rest ${id}`);
        },
      ],
    ]);
    const id = await startGame("pop", "choices");
    await get(`/play/${id}`);
    const game = (await getGame(testEnv() as never, id))!;
    game.phase = "done";
    game.current = null;
    game.results.push({
      title: "Only Song",
      artist: "Artist",
      cover: null,
      link: null,
      service: "deezer",
      answer: "Only Song",
      correct: true,
      timedOut: false,
      score: 900,
    });
    await putGame(testEnv() as never, game);
    const refused = await answer(id, { choice: "Only Song" });
    expect(refused.status).toBe(303);
    const after = (await getGame(testEnv() as never, id))!;
    expect(after.results.length).toBe(1);
    const missing = await answer("no-such-game", { choice: "x" });
    expect(missing.status).toBe(404);
  });
});

describe("typed matching", () => {
  it.each([
    ["Cafe Del Mar", "Café del Mar", true],
    ["cafe del mar (live)", "Café del Mar", true],
    ["Weird Fishes", "Weird Fishes / Arpeggi", false],
    ["Otonake", "Otonoke", true],
    ["Blue", "Green", false],
  ])("%s vs %s → %s", (given, title, expected) => {
    expect(matchTyped(given, title)).toBe(expected);
  });

  it("scores linearly and times out at 15 s", () => {
    expect(scoreFor(0)).toBe(1000);
    expect(scoreFor(7_500)).toBe(550);
    expect(scoreFor(15_000)).toBe(0);
    expect(scoreFor(20_000)).toBe(0);
  });
});

describe("preview resolution", () => {
  const game = (candidates: Candidate[]) =>
    buildGame(
      testEnv() as never,
      { slug: "mine", name: "Mine", feed: "mine", ref: null },
      "typed",
      candidates,
    );

  it("lets an ISRC hit win over search", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("isrc:"))
          return Response.json({
            ...deezerTrack(7, "Track"),
            preview: "https://cdn.example/isrc.mp3",
            artist: { name: "Real Artist" },
          });
        return Response.json({ data: [] });
      }),
    );
    const built = await game([
      {
        title: "Track",
        artist: "Real Artist",
        cover: null,
        link: null,
        isrc: "USABC1234567",
      },
    ]);
    const served = await serveRound(testEnv() as never, built, Date.now());
    expect(served.preview?.url).toBe("https://cdn.example/isrc.mp3");
    expect(calls.some((url) => url.includes("isrc:USABC1234567"))).toBe(true);
    expect(calls.some((url) => url.includes("/search?"))).toBe(false);
  });

  it("rejects a search hit by another artist and falls back to Apple", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/search/,
        {
          data: [{ ...deezerTrack(9, "Track"), artist: { name: "Remixer" } }],
        },
      ],
      [
        /itunes\.apple\.com\/search/,
        {
          results: [
            {
              trackName: "Track",
              artistName: "Wanted Artist",
              previewUrl: "https://audio.example/apple.m4a",
              trackViewUrl: "https://music.apple.com/track",
              artworkUrl100: "https://img.example/a.jpg",
            },
          ],
        },
      ],
    ]);
    const built = await game([
      { title: "Track", artist: "Wanted Artist", cover: null, link: null },
    ]);
    const served = await serveRound(testEnv() as never, built, Date.now());
    expect(served.preview?.service).toBe("apple");
    expect(served.preview?.url).toBe("https://audio.example/apple.m4a");
  });
});
