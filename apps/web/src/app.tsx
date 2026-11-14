import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env, Period, PeriodStats } from "./types";
import { getStats } from "./aggregate";
import { beginGithub, githubCallback, sessionUser } from "./auth";
import { renderCard, type CardTheme } from "./card";
import { pullDueSources } from "./cron";
import { page } from "./layout";
import { sourceNames } from "./names";
import { settingsApp, signInPage } from "./settings";
import { beginSpotify, spotifyCallback } from "./spotify";
import { uploadPlays } from "./upload";

const periods: Period[] = ["week", "month", "all"];

function readPeriod(value: string | undefined): Period | null {
  return value === undefined
    ? "week"
    : periods.includes(value as Period)
      ? (value as Period)
      : null;
}

function readCardSize(value: string | undefined): number | null {
  if (value === undefined) return 5;
  if (!/^(?:[1-9]|10)$/.test(value)) return null;
  return Number(value);
}

function readTheme(value: string | undefined): CardTheme | null {
  if (value === undefined) return "light";
  return value === "light" || value === "dark" ? value : null;
}

async function findUser(db: D1Database, name: string) {
  return db
    .prepare(
      `SELECT id, name,
       (
         SELECT group_concat(kind) FROM sources WHERE user_id = users.id
       ) AS kinds
       FROM users WHERE name = ?1 COLLATE NOCASE AND is_public = 1`,
    )
    .bind(name)
    .first<{
      id: number;
      name: string;
      kinds: string | null;
    }>();
}

async function getSnapshot(
  env: Env,
  user: { id: number; name: string },
  period: Period,
  now: number,
) {
  const key = `snap:${user.id}:${period}`;
  if (env.CACHE) {
    let cached: PeriodStats | null = null;
    try {
      cached = await env.CACHE.get<PeriodStats>(key, "json");
    } catch {
      cached = null;
    }
    if (
      cached &&
      cached.updated_at > now - (period === "all" ? 6 * 3600 : 15 * 60)
    )
      return cached;
  }
  const snapshot = await getStats(env.DB, user.id, user.name, period, now);
  if (env.CACHE) {
    await env.CACHE.put(key, JSON.stringify(snapshot), {
      expirationTtl: period === "all" ? 6 * 3600 : 15 * 60,
    }).catch(() => undefined);
  }
  return snapshot;
}

const periodNames: Record<Period, string> = {
  week: "Week",
  month: "Month",
  all: "All time",
};

const dailyBars = 30;

function list(items: Array<{ title: string; artist: string; plays: number }>) {
  if (items.length === 0) return <p class="muted">No plays in this period.</p>;
  return (
    <ol>
      {items.map((item, index) => (
        <li key={`${item.title}-${item.artist}`}>
          <span class="rank">{index + 1}</span>
          <span class="track">
            <b>{item.title}</b>
            {item.artist !== "" && <small>{item.artist}</small>}
          </span>
          <span class="count">{item.plays}</span>
        </li>
      ))}
    </ol>
  );
}

function sourceLine(kinds: string | null) {
  const names = new Set(
    (kinds?.split(",") ?? []).map((kind) => sourceNames[kind] ?? kind),
  );
  return names.size === 0 ? "None" : [...names].sort().join(", ");
}

function profilePage(
  snapshot: PeriodStats,
  origin: string,
  kinds: string | null,
) {
  const days = snapshot.daily.slice(-dailyBars);
  const maxDaily = Math.max(1, ...days.map((day) => day.plays));
  const cardUrl = `${origin}/u/${encodeURIComponent(snapshot.user.name)}.svg`;
  const updated = new Date(snapshot.updated_at * 1000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  const periodNote = periodNames[snapshot.period];
  return page({
    title: snapshot.user.name,
    head: (
      <>
        <meta
          property="og:title"
          content={`${snapshot.user.name}'s listening profile`}
        />
        <meta property="og:image" content={cardUrl} />
      </>
    ),
    account: <a href="/settings">Account</a>,
    footer: (
      <a
        href={`/u/${encodeURIComponent(snapshot.user.name)}.json?period=${snapshot.period}`}
      >
        Data as JSON
      </a>
    ),
    children: (
      <>
        <div class="page-head">
          <h1>{snapshot.user.name}</h1>
          <p class="meta">
            Sources: {sourceLine(kinds)}. Updated{" "}
            <time datetime={new Date(snapshot.updated_at * 1000).toISOString()}>
              {updated} UTC
            </time>
            .
          </p>
        </div>
        <nav class="segmented" aria-label="Time period">
          {periods.map((period) => (
            <a
              href={`?period=${period}`}
              aria-current={snapshot.period === period ? "page" : undefined}
            >
              {periodNames[period]}
            </a>
          ))}
        </nav>
        <dl class="stats">
          <div>
            <dt>Plays</dt>
            <dd>{snapshot.plays}</dd>
          </div>
          <div>
            <dt>Tracks</dt>
            <dd>{snapshot.unique_tracks}</dd>
          </div>
          <div>
            <dt>Artists</dt>
            <dd>{snapshot.unique_artists}</dd>
          </div>
        </dl>
        <section class="section">
          <div class="section-head">
            <h2>Top tracks</h2>
            <small>{periodNote}</small>
          </div>
          <div class="section-body">{list(snapshot.top_tracks)}</div>
        </section>
        <section class="section">
          <div class="section-head">
            <h2>Top artists</h2>
            <small>{periodNote}</small>
          </div>
          <div class="section-body">
            {list(
              snapshot.top_artists.map((item) => ({
                title: item.artist,
                artist: "",
                plays: item.plays,
              })),
            )}
          </div>
        </section>
        <section class="section">
          <div class="section-head">
            <h2>Plays per day</h2>
            <small>
              {snapshot.daily.length > dailyBars
                ? `Latest ${dailyBars} days with plays, UTC`
                : "Days with plays, UTC"}
            </small>
          </div>
          <div class="section-body">
            {days.length === 0 ? (
              <p class="muted">No plays in this period.</p>
            ) : (
              <>
                <div
                  class="daily"
                  role="img"
                  aria-label={`Plays per day from ${days[0]!.day} to ${days[days.length - 1]!.day}, at most ${maxDaily} a day`}
                >
                  {days.map((day) => (
                    <span
                      class="bar"
                      key={day.day}
                      style={`height: ${(day.plays / maxDaily) * 100}%`}
                      title={`${day.day}: ${day.plays} plays`}
                    />
                  ))}
                </div>
                <div class="axis">
                  <span>{days[0]!.day}</span>
                  <span>{days[days.length - 1]!.day}</span>
                </div>
              </>
            )}
          </div>
        </section>
      </>
    ),
  });
}

export const app = new Hono<{ Bindings: Env }>();

app.post(
  "/api/v1/upload",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (context) =>
      context.json({ error: "the body is over the 256 KiB limit" }, 413),
  }),
  uploadPlays,
);

app.get("/", async (context) => {
  const user = await sessionUser(context);
  if (user !== null) return context.redirect("/settings", 303);
  return context.html(signInPage());
});

app.get("/auth/github", (context) => beginGithub(context));

app.get("/auth/github/callback", (context) => githubCallback(context));

app.get("/auth/spotify", (context) => beginSpotify(context));

app.get("/auth/spotify/callback", (context) => spotifyCallback(context));

app.route("/settings", settingsApp);

app.get("/u/:path", async (context) => {
  const path = context.req.param("path") ?? "";
  const format = path.endsWith(".json")
    ? "json"
    : path.endsWith(".svg")
      ? "svg"
      : "html";
  const name =
    format === "json"
      ? path.slice(0, -5)
      : format === "svg"
        ? path.slice(0, -4)
        : path;
  const badRequest = (message: string) =>
    format === "json"
      ? context.json({ error: message }, 400)
      : context.text(message, 400);
  const period = readPeriod(context.req.query("period"));
  if (!period) return badRequest("period must be week, month or all");
  let card: { size: number; theme: CardTheme } | undefined;
  if (format === "svg") {
    const size = readCardSize(context.req.query("n"));
    if (size === null) return badRequest("n must be between 1 and 10");
    const theme = readTheme(context.req.query("theme"));
    if (theme === null) return badRequest("theme must be light or dark");
    card = { size, theme };
  }
  if (!name)
    return format === "json"
      ? context.json({ error: "not found" }, 404)
      : context.text("Not found", 404);
  const user = await findUser(context.env.DB, name);
  if (!user)
    return format === "json"
      ? context.json({ error: "not found" }, 404)
      : context.text("Not found", 404);
  const snapshot = await getSnapshot(
    context.env,
    user,
    period,
    Math.floor(Date.now() / 1000),
  );
  if (format === "html")
    return context.html(
      profilePage(snapshot, new URL(context.req.url).origin, user.kinds),
    );
  context.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'",
  );
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Cache-Control", "public, max-age=900");
  if (card) {
    context.header("Content-Type", "image/svg+xml");
    return context.body(renderCard(snapshot, card.size, card.theme));
  }
  context.header("Access-Control-Allow-Origin", "*");
  return context.json(snapshot);
});

app.notFound((context) => context.text("Not found", 404));

export async function scheduled(_controller: ScheduledController, env: Env) {
  await pullDueSources(env);
}
