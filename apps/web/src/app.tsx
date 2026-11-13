import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env, Period, PeriodStats } from "./types";
import { getStats } from "./aggregate";
import { beginGithub, githubCallback, sessionUser } from "./auth";
import { renderCard, type CardTheme } from "./card";
import { pullDueSources } from "./cron";
import { settingsApp, signInPage } from "./settings";
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
       EXISTS (
         SELECT 1 FROM sources WHERE user_id = users.id AND kind = 'lastfm'
       ) AS has_lastfm
       FROM users WHERE name = ?1 COLLATE NOCASE AND is_public = 1`,
    )
    .bind(name)
    .first<{ id: number; name: string; has_lastfm: number }>();
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

function list(items: Array<{ title: string; artist: string; plays: number }>) {
  if (items.length === 0)
    return <p class="empty">No listening history in this period.</p>;
  return (
    <ol>
      {items.map((item, index) => (
        <li key={`${item.title}-${item.artist}`}>
          <span class="rank">{index + 1}</span>
          <span class="track">
            <b>{item.title}</b>
            <small>{item.artist}</small>
          </span>
          <span class="count">{item.plays}</span>
        </li>
      ))}
    </ol>
  );
}

function profilePage(
  snapshot: PeriodStats,
  origin: string,
  lastFmCredit: boolean,
) {
  const maxDaily = Math.max(1, ...snapshot.daily.map((day) => day.plays));
  const cardUrl = `${origin}/u/${encodeURIComponent(snapshot.user.name)}.svg`;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          property="og:title"
          content={`${snapshot.user.name}'s listening profile`}
        />
        <meta property="og:image" content={cardUrl} />
        <link rel="stylesheet" href="/styles.css" />
        <title>{snapshot.user.name} · music stats</title>
      </head>
      <body>
        <main class="shell">
          <span class="eyebrow">music stats</span>
          <h1>{snapshot.user.name}</h1>
          <p class="lede">A record of the music this listener played.</p>
          <nav class="periods" aria-label="Time period">
            {periods.map((period) => (
              <a
                href={`?period=${period}`}
                aria-current={snapshot.period === period ? "page" : undefined}
              >
                {period}
              </a>
            ))}
          </nav>
          <section class="stats" aria-label="Summary">
            <div class="stat">
              <strong>{snapshot.plays}</strong>
              <span>plays</span>
            </div>
            <div class="stat">
              <strong>{snapshot.unique_tracks}</strong>
              <span>tracks</span>
            </div>
            <div class="stat">
              <strong>{snapshot.unique_artists}</strong>
              <span>artists</span>
            </div>
          </section>
          <div class="grid">
            <section class="panel">
              <div class="panel-header">
                <h2>Top tracks</h2>
                <small>{snapshot.period}</small>
              </div>
              {list(snapshot.top_tracks)}
            </section>
            <section class="panel">
              <div class="panel-header">
                <h2>Top artists</h2>
                <small>{snapshot.period}</small>
              </div>
              {list(
                snapshot.top_artists.map((item) => ({
                  title: item.artist,
                  artist: "",
                  plays: item.plays,
                })),
              )}
            </section>
            <section class="panel">
              <div class="panel-header">
                <h2>Plays per day</h2>
                <small>UTC</small>
              </div>
              {snapshot.daily.length === 0 ? (
                <p class="empty">No listening history in this period.</p>
              ) : (
                <div class="daily">
                  {snapshot.daily.map((day) => (
                    <div class="day" key={day.day}>
                      <span
                        class="bar"
                        style={`height: ${(day.plays / maxDaily) * 100}%`}
                        title={`${day.plays} plays`}
                      />
                      <small>{day.day.slice(5)}</small>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
          <footer>
            Updated{" "}
            {new Date(snapshot.updated_at * 1000)
              .toISOString()
              .slice(0, 16)
              .replace("T", " ")}{" "}
            UTC ·{" "}
            <a
              href={`/u/${encodeURIComponent(snapshot.user.name)}.json?period=${snapshot.period}`}
            >
              JSON
            </a>
            {lastFmCredit && (
              <>
                {" "}
                · <a href="https://www.last.fm">powered by AudioScrobbler</a>
              </>
            )}
          </footer>
        </main>
      </body>
    </html>
  );
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
  if (!user || (user.has_lastfm === 1 && !context.env.LASTFM_APPROVAL))
    return format === "json"
      ? context.json({ error: "not found" }, 404)
      : context.text("Not found", 404);
  const lastFm = user.has_lastfm === 1;
  const snapshot = await getSnapshot(
    context.env,
    user,
    period,
    Math.floor(Date.now() / 1000),
  );
  if (format === "html") {
    if (lastFm) context.header("Cache-Control", "public, max-age=60");
    return context.html(
      profilePage(snapshot, new URL(context.req.url).origin, lastFm),
    );
  }
  context.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'",
  );
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Cache-Control", `public, max-age=${lastFm ? 60 : 900}`);
  if (card) {
    context.header("Content-Type", "image/svg+xml");
    return context.body(renderCard(snapshot, card.size, card.theme, lastFm));
  }
  context.header("Access-Control-Allow-Origin", "*");
  return context.json(
    lastFm
      ? {
          ...snapshot,
          credit: { name: "Last.fm", url: "https://www.last.fm" },
        }
      : snapshot,
  );
});

app.notFound((context) => context.text("Not found", 404));

export async function scheduled(_controller: ScheduledController, env: Env) {
  await pullDueSources(env);
}
