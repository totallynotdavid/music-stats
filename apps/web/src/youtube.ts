export const historyUrl = "https://music.youtube.com/history";

// Without a browser User-Agent, music.youtube.com answers with a 2 KB stub
// that has no initial data and no sign-in flag (measured 2026-11-14). This is
// the agent the crate sends.
const browserUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MARKER = "});ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});";
const DATA_PREFIX = ", data: '";
const DATA_SUFFIX = "'}";
const SIGNED_IN = '"LOGGED_IN":true';
const SIGNED_OUT = '"LOGGED_IN":false';

const LAST_WEEK_OFFSET_DAYS = 4;
const THIS_WEEK_OFFSET_DAYS = 3;
const MONTH_MIN_AGE_DAYS = 14;
const MAX_VIDEO_ID_LEN = 32;

export class SignedOutError extends Error {}
export class HistoryPageError extends Error {}

const sapisidPattern = /__Secure-3PAPISID=([^;]+)/;

export function hasSapisid(cookie: string) {
  return sapisidPattern.test(cookie);
}

// The cookie field a browser copies carries every google.com cookie; the page
// needs the consent cookie too, which a copied string can lack.
function sanitizeCookie(cookie: string) {
  const withoutUnicode = cookie.replace(/[Ā-￿]/g, "");
  const normalized = withoutUnicode.replace(/\s+/g, " ").trim();
  return normalized.includes("SOCS=") ? normalized : `${normalized}; SOCS=CAI`;
}

async function sapisidHash(sapisid: string, timestamp: number) {
  const input = `${timestamp} ${sapisid} https://music.youtube.com`;
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type YouTubeFetcher = typeof fetch;

export async function fetchHistoryPage(
  cookie: string,
  fetcher: YouTubeFetcher = fetch,
  now = Math.floor(Date.now() / 1000),
) {
  const sapisid = sapisidPattern.exec(cookie)?.[1];
  if (sapisid === undefined) throw new Error("cookie lacks __Secure-3PAPISID");
  const authorization = `SAPISIDHASH ${now}_${await sapisidHash(sapisid, now)}`;
  const response = await fetcher(historyUrl, {
    headers: {
      cookie: sanitizeCookie(cookie),
      authorization,
      "user-agent": browserUserAgent,
    },
  });
  if (!response.ok)
    throw new Error(`YouTube Music returned ${response.status}`);
  return response.text();
}

// A signed-out page still answers 200 with an empty history, so the page's own
// sign-in flag is the only reliable sign of a dead cookie.
export function ensureSignedIn(html: string) {
  if (html.includes(SIGNED_IN)) return;
  if (html.includes(SIGNED_OUT))
    throw new SignedOutError("YouTube Music answered as signed out");
  throw new HistoryPageError(
    "the history page has no LOGGED_IN flag; YouTube Music may have changed its page",
  );
}

export function extractJsonFromHtml(html: string) {
  const markerPos = html.indexOf(MARKER);
  if (markerPos < 0)
    throw new HistoryPageError("YTMUSIC_INITIAL_DATA marker not found in HTML");
  const jsObjStart = html.lastIndexOf("{", markerPos);
  if (jsObjStart < 0)
    throw new HistoryPageError("Opening brace not found before marker");
  const jsObj = extractBalancedJson(html, jsObjStart);
  const decoded = decodeHexEscapes(jsObj);
  const json = extractDataField(decoded);
  return json.replaceAll("\\'", "'").replaceAll("\\\\", "\\");
}

function extractBalancedJson(html: string, start: number) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new HistoryPageError("Unbalanced JSON object");
}

function hexDigit(code: number) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

// Each \xNN escape spells a byte, and escapes can spell out UTF-8 sequences,
// so bytes are collected first and decoded once at the end.
function decodeHexEscapes(input: string) {
  const source = new TextEncoder().encode(input);
  const result = new Uint8Array(source.length);
  let length = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (i + 3 < source.length && source[i] === 0x5c && source[i + 1] === 0x78) {
      const high = hexDigit(source[i + 2]);
      const low = hexDigit(source[i + 3]);
      if (high >= 0 && low >= 0) {
        result[length] = high * 16 + low;
        length += 1;
        i += 3;
        continue;
      }
    }
    result[length] = source[i];
    length += 1;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      result.subarray(0, length),
    );
  } catch {
    throw new HistoryPageError("Escapes do not decode to UTF-8");
  }
}

function extractDataField(decoded: string) {
  const dataStart = decoded.indexOf(DATA_PREFIX);
  if (dataStart < 0)
    throw new HistoryPageError("data field not found in JS object");
  const remaining = decoded.slice(dataStart + DATA_PREFIX.length);
  const jsonEnd = remaining.lastIndexOf(DATA_SUFFIX);
  if (jsonEnd < 0) throw new HistoryPageError("data field closing not found");
  return remaining.slice(0, jsonEnd);
}

export interface YouTubePlay {
  artist: string;
  title: string;
  videoId: string | null;
  day: string | null;
}

const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(day: string) {
  return Date.parse(`${day}T00:00:00.000Z`) / 86400000;
}

function dayString(number: number) {
  return new Date(number * 86400000).toISOString().slice(0, 10);
}

// The civil day in the source's time zone, as the crate's chrono_tz resolves
// "Today" and "Yesterday".
export function todayIn(nowSeconds: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowSeconds * 1000));
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const MONTHS: string[][] = [
  ["january", "enero", "janeiro", "gennaio", "janvier"],
  ["february", "febrero", "fevereiro", "febbraio", "février"],
  ["march", "marzo", "março", "mars"],
  ["april", "abril", "aprile", "avril"],
  ["may", "mayo", "maio", "maggio", "mai"],
  ["june", "junio", "junho", "giugno", "juin"],
  ["july", "julio", "julho", "luglio", "juillet"],
  ["august", "agosto", "août"],
  [
    "september",
    "septiembre",
    "setiembre",
    "setembro",
    "settembre",
    "septembre",
  ],
  ["october", "octubre", "outubro", "ottobre", "octobre"],
  ["november", "noviembre", "novembro", "novembre"],
  ["december", "diciembre", "dezembro", "dicembre", "décembre"],
];

function monthNumber(word: string) {
  const index = MONTHS.findIndex((names) => names.includes(word));
  return index < 0 ? undefined : index + 1;
}

type Heading = { kind: "day"; day: string } | { kind: "span"; day: string };

// A heading such as "October 2026" or "octubre de 2026" holds only plays older
// than the Last week heading, so the date is the 15th, moved back to
// MONTH_MIN_AGE_DAYS ago for the current month and kept inside the month.
function resolveMonthHeading(lower: string, today: string) {
  const words = lower.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
  const month = words.map(monthNumber).find((value) => value !== undefined);
  const year = Number(
    words.find((word) => word.length === 4 && /^\d{4}$/.test(word)),
  );
  if (month === undefined || !Number.isInteger(year)) return undefined;
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const middle = `${year}-${String(month).padStart(2, "0")}-15`;
  const newest = dayString(dayNumber(today) - MONTH_MIN_AGE_DAYS);
  const date = middle < newest ? middle : newest;
  return date > first ? date : first;
}

function resolveHeading(label: string, today: string): Heading | undefined {
  const lower = label.toLowerCase();
  const matches = (words: string[]) =>
    words.some((word) => lower.includes(word));

  const direct = dayPattern.exec(label);
  if (direct !== null) {
    const day = `${direct[1]}-${direct[2]}-${direct[3]}`;
    if (dayString(dayNumber(day)) === day) return { kind: "day", day };
  }
  const month = resolveMonthHeading(lower, today);
  if (month !== undefined) return { kind: "span", day: month };
  if (matches(["today", "hoy", "hoje", "oggi", "aujourd'hui"]))
    return { kind: "day", day: today };
  if (matches(["yesterday", "ayer", "ontem", "ieri", "hier"]))
    return { kind: "day", day: dayString(dayNumber(today) - 1) };
  if (
    matches([
      "last week",
      "última semana",
      "semana passada",
      "settimana scorsa",
      "semaine dernière",
    ])
  )
    return {
      kind: "span",
      day: dayString(dayNumber(today) - LAST_WEEK_OFFSET_DAYS),
    };
  if (
    matches(["this week", "esta semana", "questa settimana", "cette semaine"])
  )
    return {
      kind: "span",
      day: dayString(dayNumber(today) - THIS_WEEK_OFFSET_DAYS),
    };
  return undefined;
}

function isVideoId(id: string) {
  return (
    id.length > 0 &&
    id.length <= MAX_VIDEO_ID_LEN &&
    /^[A-Za-z0-9_-]+$/.test(id)
  );
}

function isArtistEndpoint(endpoint: Record<string, unknown>) {
  const browse = endpoint.browseEndpoint as Record<string, unknown> | undefined;
  const configs = browse?.browseEndpointContextSupportedConfigs as
    | Record<string, unknown>
    | undefined;
  const music = configs?.browseEndpointContextMusicConfig as
    | Record<string, unknown>
    | undefined;
  return music?.pageType === "MUSIC_PAGE_TYPE_ARTIST";
}

function readRuns(column: unknown) {
  const renderer = (column as Record<string, unknown> | undefined)?.[
    "musicResponsiveListItemFlexColumnRenderer"
  ] as Record<string, unknown> | undefined;
  const text = renderer?.text as Record<string, unknown> | undefined;
  return Array.isArray(text?.runs)
    ? (text.runs as Record<string, unknown>[])
    : [];
}

function parseListItem(item: unknown, heading: Heading) {
  const renderer = (item as Record<string, unknown>)[
    "musicResponsiveListItemRenderer"
  ] as Record<string, unknown> | undefined;
  const columns = renderer?.flexColumns;
  if (!Array.isArray(columns)) return undefined;

  let title: string | undefined;
  let videoId: string | null = null;
  let artist: string | undefined;
  for (const column of columns) {
    for (const run of readRuns(column)) {
      const endpoint = run.navigationEndpoint as
        | Record<string, unknown>
        | undefined;
      if (endpoint === undefined) continue;
      const text = typeof run.text === "string" ? run.text : undefined;
      if ("watchEndpoint" in endpoint) {
        if (title === undefined) {
          title = text;
          const watch = endpoint.watchEndpoint as Record<string, unknown>;
          const id = watch?.videoId;
          videoId = typeof id === "string" && isVideoId(id) ? id : null;
        }
      } else if (isArtistEndpoint(endpoint)) {
        artist = artist ?? text;
      }
    }
  }
  if (title === undefined) return undefined;
  return {
    artist: artist ?? "Unknown Artist",
    title,
    videoId,
    day: heading.kind === "day" ? heading.day : null,
  } satisfies YouTubePlay;
}

export function parseHistoryJson(jsonText: string, today: string) {
  let json: unknown;
  try {
    json = JSON.parse(jsonText);
  } catch {
    throw new HistoryPageError("Invalid JSON");
  }
  const tabs = (json as Record<string, unknown>)?.contents as
    | Record<string, unknown>
    | undefined;
  const browse = tabs?.singleColumnBrowseResultsRenderer as
    | Record<string, unknown>
    | undefined;
  const tabList = browse?.tabs;
  const tab = Array.isArray(tabList)
    ? (tabList[0] as Record<string, unknown> | undefined)
    : undefined;
  const tabRenderer = tab?.tabRenderer as Record<string, unknown> | undefined;
  const content = tabRenderer?.content as Record<string, unknown> | undefined;
  const sectionList = content?.sectionListRenderer as
    | Record<string, unknown>
    | undefined;
  const shelves = sectionList?.contents;
  if (!Array.isArray(shelves))
    throw new HistoryPageError("Expected structure not found in JSON");

  const plays: YouTubePlay[] = [];
  for (const shelf of shelves) {
    const renderer = (shelf as Record<string, unknown>)[
      "musicShelfRenderer"
    ] as Record<string, unknown> | undefined;
    if (renderer === undefined) continue;
    const titleRuns = (renderer.title as Record<string, unknown> | undefined)
      ?.runs;
    const label =
      Array.isArray(titleRuns) &&
      typeof (titleRuns[0] as Record<string, unknown>)?.text === "string"
        ? ((titleRuns[0] as Record<string, unknown>).text as string)
        : "Unknown";
    const items = Array.isArray(renderer.contents)
      ? (renderer.contents as unknown[])
      : [];
    const heading = resolveHeading(label, today);
    if (heading === undefined) continue;
    for (const item of items) {
      const play = parseListItem(item, heading);
      if (play !== undefined) plays.push(play);
    }
  }
  return plays;
}

export function parseHistoryPage(html: string, today: string): YouTubePlay[] {
  ensureSignedIn(html);
  return parseHistoryJson(extractJsonFromHtml(html), today);
}
