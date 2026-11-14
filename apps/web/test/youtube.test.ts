import { describe, expect, it } from "vitest";
import {
  ensureSignedIn,
  extractJsonFromHtml,
  fetchHistoryPage,
  HistoryPageError,
  parseHistoryJson,
  parseHistoryPage,
  SignedOutError,
  todayIn,
} from "../src/youtube";
// @ts-expect-error vite ?raw import
import fixture from "./fixtures/history.html?raw";

const now = Math.floor(Date.now() / 1000);

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

function historyJson(shelves: unknown[]) {
  return JSON.stringify({
    contents: {
      singleColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: { contents: shelves },
              },
            },
          },
        ],
      },
    },
  });
}

function historyPage(json: string, loggedIn = true) {
  return (
    `<html><script>ytcfg.set({"LOGGED_IN":${loggedIn}});</script>` +
    `<script>initialData.push({path: '/browse', data: '${jsEscape(json)}'});` +
    `ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});</script></html>`
  );
}

export function signedOutPage() {
  return `<html><script>ytcfg.set({"LOGGED_IN":false});</script></html>`;
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

function item(title: string, videoId: string, artist = "Artist A") {
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
            text: { runs: [artistRun(artist)] },
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

describe("history page extraction", () => {
  it("fetches the history page as a desktop browser", async () => {
    let sent: Headers | undefined;
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response("page");
    }) as typeof fetch;
    await fetchHistoryPage("__Secure-3PAPISID=fake", fetcher, now);
    expect(sent?.get("user-agent")).toMatch(/^Mozilla\/5\.0 .*Chrome\//);
    expect(sent?.get("authorization")).toMatch(
      /^SAPISIDHASH \d+_[0-9a-f]{40}$/,
    );
  });

  it("detects a signed-out page", () => {
    expect(() => ensureSignedIn(signedOutPage())).toThrow(SignedOutError);
    expect(() => ensureSignedIn("<html></html>")).toThrow(HistoryPageError);
  });

  it("rejects a page without the marker", () => {
    expect(() =>
      extractJsonFromHtml(
        `<html><script>ytcfg.set({"LOGGED_IN":true});</script></html>`,
      ),
    ).toThrow(HistoryPageError);
  });

  it("parses a synthetic page like the crate's fixture builder", () => {
    const json = historyJson([shelf("Today", [item("Song A", "vid1")])]);
    const plays = parseHistoryPage(historyPage(json), "2026-01-15");
    expect(plays).toEqual([
      {
        artist: "Artist A",
        title: "Song A",
        videoId: "vid1",
        day: "2026-01-15",
      },
    ]);
  });
});

describe("history fixture", () => {
  it("gives the same plays the crate's tests expect", () => {
    const json = extractJsonFromHtml(fixture);
    const today = todayIn(now, "UTC");
    const plays = parseHistoryJson(json, today);
    expect(plays.length).toBe(200);
    expect(plays[0]?.videoId).toBe("rSvTmvpx0JI");
    expect(plays.find((play) => play.title === "Golden")?.artist).toBe(
      "HUNTR/X",
    );
    expect(
      plays.find((play) => play.artist.startsWith("Pelo Mad"))?.artist,
    ).toBe("Pelo Madueño");
    expect(plays.find((play) => play.artist === "PENTAGON")?.title).toBe(
      "Shine (빛나리)",
    );
    expect(plays.every((play) => play.videoId !== null)).toBe(true);
    for (const play of plays)
      if (play.day !== null) expect(play.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("resolves Today and Yesterday in the source's zone, not UTC", () => {
    const json = extractJsonFromHtml(fixture);
    const zone = "Pacific/Kiritimati";
    const plays = parseHistoryJson(json, todayIn(now, zone));
    const days = new Set(
      plays
        .map((play) => play.day)
        .filter((day): day is string => day !== null),
    );
    const expected = new Set(
      [0, 1].map((offset) => {
        const day = todayIn(now - offset * 86400, zone);
        return day;
      }),
    );
    expect(days.size).toBeGreaterThan(0);
    for (const day of days) expect(expected.has(day)).toBe(true);
  });
});

describe("history json", () => {
  const today = "2026-01-15";

  it.each([
    ["Today", "2026-01-15"],
    ["Yesterday", "2026-01-14"],
    ["2024-01-15", "2024-01-15"],
    ["Hoy", "2026-01-15"],
    ["Ontem", "2026-01-14"],
  ])("dates plays under %s", (label, day) => {
    const plays = parseHistoryJson(
      historyJson([shelf(label, [item("T", "v")])]),
      today,
    );
    expect(plays[0]?.day).toBe(day);
  });

  it.each([
    ["Last week"],
    ["Última semana"],
    ["This week"],
    ["October 2024"],
    ["an unknown shelf"],
  ])("drops the day under %s", (label) => {
    const plays = parseHistoryJson(
      historyJson([shelf(label, [item("T", "v")])]),
      today,
    );
    if (label === "an unknown shelf") expect(plays).toEqual([]);
    else expect(plays[0]?.day).toBeNull();
  });

  it("keeps a play whose video id is malformed, without the id", () => {
    const plays = parseHistoryJson(
      historyJson([shelf("Today", [item("T", "has space")])]),
      today,
    );
    expect(plays[0]?.videoId).toBeNull();
    expect(plays[0]?.title).toBe("T");
  });

  it("names a missing artist Unknown Artist", () => {
    const noArtist = {
      musicResponsiveListItemRenderer: {
        flexColumns: [
          {
            musicResponsiveListItemFlexColumnRenderer: {
              text: { runs: [watchRun("T", "v")] },
            },
          },
          {
            musicResponsiveListItemFlexColumnRenderer: {
              text: { runs: [{ text: "2024" }] },
            },
          },
        ],
      },
    };
    const plays = parseHistoryJson(
      historyJson([shelf("Today", [noArtist])]),
      today,
    );
    expect(plays[0]?.artist).toBe("Unknown Artist");
  });
});
