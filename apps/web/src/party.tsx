import type { Context } from "hono";
import { validName } from "./auth";
import {
  blend,
  youtubePlaylistUrl,
  type PartyTrack,
  type PartyUser,
} from "./party-blend";
import type { Env } from "./types";
import { EmptyState } from "./ui/empty";
import { Notice } from "./ui/notice";
import { PillButton } from "./ui/pill";
import { Playlist } from "./ui/playlist";
import { Section } from "./ui/section";
import { Page } from "./ui/shell";

const recentDays = 90;
const cacheSeconds = 600;

interface CandidateRow {
  track_id: number;
  title: string;
  artist: string;
  artist_id: number;
  plays: number;
  video_id: string | null;
}

const recentSql = `
  SELECT plays.track_id, tracks.title, artists.name AS artist,
         tracks.artist_id, COUNT(*) AS plays,
         (SELECT MIN(alias.source_key) FROM track_aliases AS alias
          WHERE alias.kind = 'ytmusic'
            AND alias.track_id = plays.track_id) AS video_id
  FROM plays
  JOIN tracks ON tracks.id = plays.track_id
  JOIN artists ON artists.id = tracks.artist_id
  WHERE plays.user_id = ?1 AND plays.dup = 0 AND plays.played_at >= ?2
  GROUP BY plays.track_id
  ORDER BY plays DESC, plays.track_id
  LIMIT ?3
`;

const allTimeSql = `
  SELECT totals.track_id, tracks.title, artists.name AS artist,
         tracks.artist_id, totals.plays,
         (SELECT MIN(alias.source_key) FROM track_aliases AS alias
          WHERE alias.kind = 'ytmusic'
            AND alias.track_id = totals.track_id) AS video_id
  FROM track_totals AS totals
  JOIN tracks ON tracks.id = totals.track_id
  JOIN artists ON artists.id = tracks.artist_id
  WHERE totals.user_id = ?1
  ORDER BY totals.plays DESC, totals.track_id
  LIMIT ?2
`;

interface PartyName {
  id: number;
  name: string;
}

function readNames(values: string[] | undefined) {
  const names: string[] = [];
  for (const value of values ?? [])
    for (const part of value.split(",")) {
      const name = part.trim().toLowerCase();
      if (name !== "" && !names.includes(name)) names.push(name);
    }
  return names;
}

async function publicUsers(db: D1Database, names: string[]) {
  const rows = await db
    .prepare(
      `SELECT id, name FROM users
       WHERE is_public = 1
         AND name IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(names))
    .all<PartyName>();
  const byName = new Map(
    rows.results.map((row) => [row.name.toLowerCase(), row]),
  );
  const users: PartyName[] = [];
  for (const name of names) {
    const user = byName.get(name);
    if (user === undefined) return null;
    users.push(user);
  }
  return users;
}

async function buildParty(
  db: D1Database,
  users: PartyName[],
  length: number,
  now: number,
) {
  const since = now - recentDays * 86400;
  const results = await db.batch(
    users.flatMap((user) => [
      db.prepare(recentSql).bind(user.id, since, length),
      db.prepare(allTimeSql).bind(user.id, length),
    ]),
  );
  const partyUsers: PartyUser[] = users.map((user, index) => {
    const recent = results[2 * index]?.results as unknown as CandidateRow[];
    const allTime = results[2 * index + 1]
      ?.results as unknown as CandidateRow[];
    const seen = new Set(recent.map((row) => row.track_id));
    const tracks = [
      ...recent,
      ...allTime.filter((row) => !seen.has(row.track_id)),
    ]
      .slice(0, length)
      .map((row, index2) => ({
        trackId: row.track_id,
        title: row.title,
        artist: row.artist,
        artistKey: String(row.artist_id),
        videoId: row.video_id,
        // Shared ranking sums 90-day counts, so fill rows count as 0.
        plays: index2 < recent.length ? row.plays : 0,
      }));
    return { name: user.name, tracks };
  });
  return blend(partyUsers, length);
}

async function cachedParty(env: Env, key: string) {
  if (env.CACHE === undefined) return null;
  try {
    return await env.CACHE.get<PartyTrack[]>(key, "json");
  } catch {
    return null;
  }
}

async function storeParty(env: Env, key: string, items: PartyTrack[]) {
  await env.CACHE?.put(key, JSON.stringify(items), {
    expirationTtl: cacheSeconds,
  }).catch(() => undefined);
}

interface FormOptions {
  names?: string[];
  n?: string;
  notice?: string;
  error?: string;
}

function formPage({ names = [], n = "25", notice, error }: FormOptions) {
  return Page({
    title: "Party playlist",
    account: <a href="/settings">Account</a>,
    children: (
      <>
        <div class="page-head">
          <h1>Party playlist</h1>
          <p>
            Blend the top tracks of two to eight public profiles into one
            playlist that opens on YouTube.
          </p>
        </div>
        {notice !== undefined && <Notice>{notice}</Notice>}
        {error !== undefined && (
          <p class="form-error" role="alert">
            <b>Error:</b> {error}
          </p>
        )}
        <form method="get" action="/party" class="stack">
          {Array.from({ length: 8 }, (_, index) => (
            <div class="field" key={index}>
              <label for={`u${index + 1}`}>
                Profile {index + 1}
                {index > 1 && " (optional)"}
              </label>
              <input
                id={`u${index + 1}`}
                name="u"
                type="text"
                value={names[index] ?? ""}
                maxlength={39}
                spellcheck={false}
                autocomplete="off"
                required={index < 2}
              />
            </div>
          ))}
          <div class="field">
            <label for="n">Length</label>
            <select id="n" name="n">
              <option value="25" selected={n === "25"}>
                25 tracks
              </option>
              <option value="50" selected={n === "50"}>
                50 tracks
              </option>
            </select>
          </div>
          <div>
            <PillButton variant="primary">Make the playlist</PillButton>
          </div>
        </form>
      </>
    ),
  });
}

function unavailablePage() {
  return Page({
    title: "Party playlist",
    account: <a href="/settings">Account</a>,
    children: (
      <EmptyState
        heading="h1"
        title="Profiles not available"
        body="One or more of these names is not a public profile. Check the spelling, or ask the person to make their profile public in settings."
        action={{ href: "/party", label: "Start over" }}
      />
    ),
  });
}

function resultPage(names: string[], items: PartyTrack[]) {
  const missing = items.filter((item) => item.videoId === null);
  const url = youtubePlaylistUrl(items);
  return Page({
    title: "Party playlist",
    account: <a href="/settings">Account</a>,
    children: (
      <>
        <div class="page-head">
          <h1>Party playlist</h1>
          <p class="meta">
            {names.join(", ")} · {items.length} tracks
          </p>
        </div>
        {items.length === 0 ? (
          <EmptyState
            title="No plays yet"
            body="None of these profiles has any plays yet, so there is nothing to blend."
          />
        ) : (
          <>
            <div class="stack">
              {url !== null && (
                <div>
                  <a
                    class="pill primary"
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Play on YouTube
                  </a>
                </div>
              )}
              <p class="hint">
                {url === null
                  ? "None of these tracks has a YouTube link yet."
                  : missing.length === 0
                    ? "Every track opens on YouTube."
                    : `${missing.length} of ${items.length} tracks have no YouTube link yet.`}{" "}
                Share this page's URL to rebuild the playlist from the latest
                plays.
              </p>
            </div>
            <Section title="Playlist" aside={`${names.length} profiles`}>
              <Playlist items={items} />
            </Section>
            {missing.length > 0 && (
              <Section title="No YouTube link yet">
                <ul class="rows">
                  {missing.map((item) => (
                    <li key={item.trackId}>
                      <span class="track">
                        <b>{item.title}</b>
                        <small>{item.artist}</small>
                      </span>
                      <span class="rank">{items.indexOf(item) + 1}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </>
    ),
  });
}

export async function partyRoute(context: Context<{ Bindings: Env }>) {
  const rawNames = context.req.queries("u") ?? [];
  const names = readNames(rawNames);
  const nParam = context.req.query("n");
  const hasInput = rawNames.length > 0 || nParam !== undefined;
  const n = nParam ?? "25";
  const form = (options: FormOptions, status: 200 | 400 = 200) =>
    context.html(formPage(options), status);

  if (!hasInput) return form({});
  if (n !== "25" && n !== "50")
    return form({ names, n: "25", error: "The length is 25 or 50." }, 400);
  if (names.length === 0 || names.length > 8)
    return form({ names, error: "Pick two to eight profiles." }, 400);
  if (names.some((name) => !validName(name)))
    return context.html(unavailablePage(), 404);
  if (names.length === 1)
    return form({
      names,
      notice: "Add at least one more public profile.",
    });

  // Compare decoded values, never the serialized query: a name that differs
  // from the canonical joined list redirects once to the form below and then
  // matches.
  const joined = names.join(",");
  if (!(rawNames.length === 1 && rawNames[0] === joined && nParam === n)) {
    const target = new URLSearchParams({ u: joined, n });
    return context.redirect(`/party?${target}`, 303);
  }

  const users = await publicUsers(context.env.DB, names);
  if (users === null) return context.html(unavailablePage(), 404);

  const cacheKey = `party:${n}:${names.join(",")}`;
  let items = await cachedParty(context.env, cacheKey);
  if (items === null) {
    items = await buildParty(
      context.env.DB,
      users,
      Number(n),
      Math.floor(Date.now() / 1000),
    );
    await storeParty(context.env, cacheKey, items);
  }
  return context.html(
    resultPage(
      users.map((user) => user.name),
      items,
    ),
  );
}
