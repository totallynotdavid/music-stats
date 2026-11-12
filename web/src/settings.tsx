import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import {
  base64url,
  cookieClear,
  endSession,
  sessionUser,
  sha256Bytes,
  validName,
  type SignedInUser,
} from "./auth";
import type { Env } from "./types";
import { importPlays, importRemove } from "./import";

const exportPageSize = 1000;
const importBodyLimit = 64 * 1024;

const exportScript = `
const exportAll = document.getElementById("export-all");
exportAll?.addEventListener("click", async (event) => {
  event.preventDefault();
  const label = exportAll.textContent;
  exportAll.textContent = "Exporting…";
  const parts = [];
  let url = "/settings/export";
  while (url !== null) {
    const page = await fetch(url);
    parts.push(await page.text());
    const link = page.headers.get("link");
    url = /<([^>]+)>;\\s*rel="next"/.exec(link ?? "")?.[1] ?? null;
  }
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(
    new Blob(parts, { type: "application/x-ndjson" }),
  );
  anchor.download = \`music-stats-\${exportAll.dataset.name}.ndjson\`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  exportAll.textContent = label;
});
`;

interface SourceInfo {
  id: number;
  kind: string;
  account: string | null;
  status: string;
  error: string | null;
  maybe_missing: number;
  last_ok_at: number | null;
}

interface TokenInfo {
  id: number;
  hint: string;
  created_at: number;
  last_used_at: number | null;
}

interface ExportRow {
  played_at: number;
  source_id: number;
  source: string;
  ref: string;
  artist: string;
  title: string;
}

const sourceKinds = ["listenbrainz", "lastfm"] as const;

const kindNames: Record<string, string> = {
  listenbrainz: "ListenBrainz",
  lastfm: "Last.fm",
  spotify: "Spotify",
  ytmusic: "YouTube Music",
  spotify_import: "Spotify import",
  ytmusic_import: "YouTube Music import",
};

const importSourceNames: Record<string, string> = {
  spotify_import: "spotify",
  ytmusic_import: "ytmusic",
};

function dayText(timestamp: number | null) {
  if (timestamp === null) return "never";
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function sourceStatus(source: SourceInfo, lastFmApproved: boolean) {
  if (source.kind === "lastfm" && !lastFmApproved)
    return "waiting for Last.fm approval";
  if (source.status === "gap")
    return "uploads lost touch; plays between the last aligned upload and the next one may be missing";
  if (source.status === "error")
    return `error: ${source.error ?? "the last pull failed"}`;
  return "active";
}

function sourceNote(source: SourceInfo) {
  if (source.maybe_missing > 0)
    return `up to ${source.maybe_missing} plays of repeated songs may be missing`;
  return null;
}

function shell(title: string, children: unknown) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="/styles.css" />
        <title>{title} · music stats</title>
      </head>
      <body>
        <main class="shell">{children}</main>
      </body>
    </html>
  );
}

export function signInPage() {
  return shell(
    "Sign in",
    <>
      <span class="eyebrow">music stats</span>
      <h1>Your listening, on record.</h1>
      <p class="lede">
        A public profile of every play you connect, at <code>/u/your-name</code>
        .
      </p>
      <p class="lede">
        Profiles are public: anyone can open your page and read your listening
        history. You can hide yours later in settings.
      </p>
      <p>
        <a class="button primary" href="/auth/github">
          Sign in with GitHub
        </a>
      </p>
    </>,
  );
}

interface PageOptions {
  notice?: string;
  error?: string;
  field?: string;
  issuedToken?: string;
}

function settingsPage(
  user: SignedInUser,
  sources: SourceInfo[],
  tokens: TokenInfo[],
  options: PageOptions & { lastFmApproved: boolean },
) {
  const { notice, error, field, issuedToken, lastFmApproved } = options;
  const fieldError = (name: string) =>
    field === name && error ? (
      <p class="form-error" role="alert">
        {error}
      </p>
    ) : null;
  const topError = field === undefined && error !== undefined && (
    <p class="form-error" role="alert">
      {error}
    </p>
  );
  const pulledSources = sources.filter(
    (source) => !(source.kind in importSourceNames),
  );
  const importedSources = sources.filter(
    (source) => source.kind in importSourceNames,
  );
  return shell(
    "Settings",
    <>
      <header class="page-head">
        <div>
          <span class="eyebrow">music stats</span>
          <h1>Settings</h1>
          <p class="lede">
            Signed in as <b>{user.name}</b> ·{" "}
            <a href={`/u/${encodeURIComponent(user.name)}`}>view profile</a>
          </p>
        </div>
        <form method="post" action="/settings/sign-out">
          <button type="submit">Sign out</button>
        </form>
      </header>
      {notice !== undefined && <p class="notice">{notice}</p>}
      {topError}
      {issuedToken !== undefined && (
        <section class="notice" aria-label="New upload token">
          <p>Your new upload token. It is shown once; store it now.</p>
          <code class="token">{issuedToken}</code>
        </section>
      )}
      <section class="panel">
        <div class="panel-header">
          <h2>Profile</h2>
        </div>
        <form method="post" action="/settings/profile">
          <div class="field">
            <label for="name">Profile name</label>
            <input
              id="name"
              name="name"
              type="text"
              value={user.name}
              minlength={1}
              maxlength={39}
              required
              spellcheck={false}
              autocomplete="off"
            />
            <small>
              Lowercase letters, digits and hyphens, no hyphen at either end.
              Your page lives at /u/&lt;name&gt;.
            </small>
            {fieldError("name")}
          </div>
          <label class="check" for="is_public">
            <input
              id="is_public"
              name="is_public"
              type="checkbox"
              checked={user.is_public === 1}
            />
            <span>Public profile</span>
          </label>
          <small class="hint">
            Hidden profiles answer 404 on the page, the JSON and the card.
          </small>
          <div>
            <button class="primary" type="submit">
              Save profile
            </button>
          </div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>Sources</h2>
        </div>
        {pulledSources.length === 0 ? (
          <p class="empty">
            No sources yet. Connect ListenBrainz or Last.fm to start recording.
          </p>
        ) : (
          <ul class="rows">
            {pulledSources.map((source) => (
              <li key={source.id}>
                <span class="track">
                  <b>{kindNames[source.kind] ?? source.kind}</b>
                  <small>
                    {source.account ?? "upload token"} ·{" "}
                    {sourceStatus(source, lastFmApproved)}
                    {sourceNote(source) !== null && (
                      <> · {sourceNote(source)}</>
                    )}
                  </small>
                </span>
                <form method="post" action="/settings/sources/remove">
                  <input type="hidden" name="id" value={source.id} />
                  <button type="submit">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form method="post" action="/settings/sources" class="form-row">
          <div class="field">
            <label for="source-kind">Service</label>
            <select id="source-kind" name="kind">
              {sourceKinds.map((kind) => (
                <option value={kind}>{kindNames[kind]}</option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="source-account">Username</label>
            <input
              id="source-account"
              name="account"
              type="text"
              required
              spellcheck={false}
              autocomplete="off"
            />
            {fieldError("source")}
          </div>
          <div class="field actions">
            <button type="submit">Connect</button>
          </div>
        </form>
        <small class="hint">
          A source is claimed by name. The service reads the public ListenBrainz
          or Last.fm history of that account.
        </small>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>YouTube Music uploads</h2>
        </div>
        {tokens.length === 0 ? (
          <p class="empty">
            No upload token yet. Issue one and put it in your GitHub Action's
            secrets as UPLOAD_TOKEN.
          </p>
        ) : (
          <ul class="rows">
            {tokens.map((token) => (
              <li key={token.id}>
                <span class="track">
                  <b>
                    <code>…{token.hint}</code>
                  </b>
                  <small>
                    created {dayText(token.created_at)} · last used{" "}
                    {dayText(token.last_used_at)}
                  </small>
                </span>
                <form method="post" action="/settings/tokens/revoke">
                  <input type="hidden" name="id" value={token.id} />
                  <button type="submit">Revoke</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form method="post" action="/settings/tokens">
          <button type="submit">Issue a new token</button>
        </form>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>Import history</h2>
        </div>
        <p class="empty">
          Bring in Spotify's extended streaming history or the watch history of
          a Google Takeout export. The browser reads the files and sends the
          plays in small batches; the files never leave this device.
        </p>
        <div class="field">
          <label for="import-files">History files</label>
          <input id="import-files" type="file" accept=".json" multiple />
          <small>
            JSON files only; unzip the export first. A Spotify file is a
            Streaming_History_Audio file, a Takeout file is watch-history.json.
          </small>
        </div>
        <div>
          <button id="import-start" type="button">
            Start the import
          </button>
        </div>
        <p id="import-status" role="status"></p>
        <ul class="rows" id="import-sources">
          {importedSources.map((source) => (
            <li key={source.id}>
              <span class="track">
                <b>{kindNames[source.kind] ?? source.kind}</b>
                <small>last batch {dayText(source.last_ok_at)}</small>
              </span>
              <button
                type="button"
                data-import-remove={importSourceNames[source.kind]}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <script type="module" src="/import.js"></script>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>Export</h2>
        </div>
        <p class="empty">
          <a id="export-all" href="/settings/export" data-name={user.name}>
            Download your plays
          </a>{" "}
          as NDJSON, one play per line. Without JavaScript the link returns the
          first 1,000 plays; each page's Link header points at the next.
        </p>
        <script
          type="module"
          dangerouslySetInnerHTML={{ __html: exportScript }}
        />
      </section>
      <section class="panel danger">
        <div class="panel-header">
          <h2>Delete account</h2>
        </div>
        <p class="empty">
          Deletes every play, source, token and session of this account. There
          is no undo.
        </p>
        <form method="post" action="/settings/delete">
          <div class="field">
            <label for="confirm">Type {user.name} to confirm</label>
            <input
              id="confirm"
              name="confirm"
              type="text"
              required
              spellcheck={false}
              autocomplete="off"
            />
            {fieldError("confirm")}
          </div>
          <button class="danger" type="submit">
            Delete this account
          </button>
        </form>
      </section>
    </>,
  );
}

function recountStatements(db: D1Database, userId: number) {
  return [
    db.prepare("DELETE FROM track_totals WHERE user_id = ?1").bind(userId),
    db
      .prepare(
        `INSERT INTO track_totals (user_id, track_id, plays, last_played_at)
         SELECT user_id, track_id, COUNT(*), MAX(played_at)
         FROM plays WHERE user_id = ?1 AND dup = 0 GROUP BY track_id`,
      )
      .bind(userId),
    db.prepare("DELETE FROM daily_totals WHERE user_id = ?1").bind(userId),
    db
      .prepare(
        `INSERT INTO daily_totals (user_id, day, plays)
         SELECT user_id, played_at / 86400, COUNT(*)
         FROM plays WHERE user_id = ?1 AND dup = 0
         GROUP BY played_at / 86400`,
      )
      .bind(userId),
    db.prepare("DELETE FROM artist_totals WHERE user_id = ?1").bind(userId),
    db
      .prepare(
        `INSERT INTO artist_totals (user_id, artist_id, plays)
         SELECT plays.user_id, tracks.artist_id, COUNT(*)
         FROM plays JOIN tracks ON tracks.id = plays.track_id
         WHERE plays.user_id = ?1 AND plays.dup = 0
         GROUP BY tracks.artist_id`,
      )
      .bind(userId),
  ];
}

export function sourceRemovalStatements(
  db: D1Database,
  userId: number,
  sourceId: number,
) {
  return [
    db
      .prepare("DELETE FROM plays WHERE user_id = ?1 AND source_id = ?2")
      .bind(userId, sourceId),
    db.prepare("DELETE FROM tokens WHERE source_id = ?1").bind(sourceId),
    db
      .prepare("DELETE FROM sources WHERE id = ?1 AND user_id = ?2")
      .bind(sourceId, userId),
    ...recountStatements(db, userId),
  ];
}

export function deletionStatements(db: D1Database, userId: number) {
  return [
    db.prepare("DELETE FROM plays WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM track_totals WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM daily_totals WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM artist_totals WHERE user_id = ?1").bind(userId),
    db
      .prepare(
        `DELETE FROM tokens WHERE source_id IN
         (SELECT id FROM sources WHERE user_id = ?1)`,
      )
      .bind(userId),
    db.prepare("DELETE FROM sources WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?1").bind(userId),
  ];
}

function newUploadToken() {
  return `msu_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

type SettingsContext = Context<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>;

async function pageData(context: SettingsContext) {
  const user = context.get("user");
  const [sources, tokens] = await context.env.DB.batch([
    context.env.DB.prepare(
      `SELECT id, kind, account, status, error, maybe_missing, last_ok_at
       FROM sources WHERE user_id = ?1 ORDER BY kind, id`,
    ).bind(user.id),
    context.env.DB.prepare(
      `SELECT tokens.id, tokens.hint, tokens.created_at, tokens.last_used_at
       FROM tokens
       JOIN sources ON sources.id = tokens.source_id
       WHERE sources.user_id = ?1 AND tokens.revoked_at IS NULL
       ORDER BY tokens.id`,
    ).bind(user.id),
  ]);
  return {
    user,
    sources: sources.results as unknown as SourceInfo[],
    tokens: tokens.results as unknown as TokenInfo[],
  };
}

function render(
  context: SettingsContext,
  data: Awaited<ReturnType<typeof pageData>>,
  options: PageOptions,
  status: 200 | 400 = 200,
) {
  return context.html(
    settingsPage(data.user, data.sources, data.tokens, {
      lastFmApproved: Boolean(context.env.LASTFM_APPROVAL),
      ...options,
    }),
    status,
  );
}

async function form(context: SettingsContext, name: string) {
  const body = await context.req.parseBody();
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

export const settingsApp = new Hono<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>();

settingsApp.use("*", csrf());

settingsApp.use("*", async (context, next) => {
  const user = await sessionUser(context);
  if (user === null) {
    return context.req.method === "POST"
      ? context.text("Forbidden", 403)
      : context.redirect("/", 303);
  }
  context.set("user", user);
  await next();
});

settingsApp.get("/", async (context) => {
  const data = await pageData(context);
  const issued = getCookie(context, "issued-token", "host");
  if (issued !== undefined) {
    deleteCookie(context, "issued-token", cookieClear);
  }
  return render(context, data, { issuedToken: issued });
});

settingsApp.post("/sign-out", async (context) => {
  await endSession(context);
  deleteCookie(context, "session", cookieClear);
  return context.redirect("/", 303);
});

settingsApp.post("/profile", async (context) => {
  const user = context.get("user");
  const name = await form(context, "name");
  const isPublic = (await context.req.parseBody()).is_public === "on" ? 1 : 0;
  const data = await pageData(context);
  if (!validName(name))
    return render(
      context,
      data,
      {
        error:
          "The name needs 1 to 39 lowercase letters, digits or hyphens, with no hyphen at either end.",
        field: "name",
      },
      400,
    );
  try {
    await context.env.DB.prepare(
      "UPDATE users SET name = ?1, is_public = ?2 WHERE id = ?3",
    )
      .bind(name, isPublic, user.id)
      .run();
  } catch {
    return render(
      context,
      data,
      { error: `The name ${name} is taken.`, field: "name" },
      400,
    );
  }
  return context.redirect("/settings", 303);
});

settingsApp.post("/sources", async (context) => {
  const user = context.get("user");
  const kind = await form(context, "kind");
  const account = await form(context, "account");
  const data = await pageData(context);
  if (
    !sourceKinds.includes(kind as (typeof sourceKinds)[number]) ||
    !/^\S{1,100}$/.test(account)
  )
    return render(
      context,
      data,
      {
        error: "Pick a service and enter the account name.",
        field: "source",
      },
      400,
    );
  const now = Math.floor(Date.now() / 1000);
  try {
    await context.env.DB.prepare(
      `INSERT INTO sources (user_id, kind, account, next_pull_at)
       VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(user.id, kind, account, now)
      .run();
  } catch {
    return render(
      context,
      data,
      {
        error: `A ${kindNames[kind]} source is already connected.`,
        field: "source",
      },
      400,
    );
  }
  return context.redirect("/settings", 303);
});

settingsApp.post("/sources/remove", async (context) => {
  const user = context.get("user");
  const id = Number(await form(context, "id"));
  const data = await pageData(context);
  const source = data.sources.find((item) => item.id === id);
  if (source === undefined)
    return render(
      context,
      data,
      { error: "That source is not connected." },
      400,
    );
  const db = context.env.DB;
  await db.batch(sourceRemovalStatements(db, user.id, id));
  return context.redirect("/settings", 303);
});

const ytmusicSourceSql = `SELECT id FROM sources
  WHERE user_id = ?1 AND kind = 'ytmusic'`;

settingsApp.post("/tokens", async (context) => {
  const user = context.get("user");
  const now = Math.floor(Date.now() / 1000);
  const db = context.env.DB;
  await db
    .prepare(
      `INSERT INTO sources (user_id, kind) VALUES (?1, 'ytmusic')
       ON CONFLICT (user_id, kind) DO NOTHING`,
    )
    .bind(user.id)
    .run();
  const source = await db
    .prepare(ytmusicSourceSql)
    .bind(user.id)
    .first<{ id: number }>();
  if (source === null) throw new Error("could not create the ytmusic source");
  const token = newUploadToken();
  await db
    .prepare(
      "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(source.id, await sha256Bytes(token), token.slice(-4), now)
    .run();
  setCookie(context, "issued-token", token, {
    prefix: "host",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    maxAge: 120,
  });
  return context.redirect("/settings", 303);
});

const tooLarge = (context: SettingsContext) =>
  context.json({ error: "the body is over the 64 KiB limit" }, 413);

settingsApp.post(
  "/import",
  bodyLimit({ maxSize: importBodyLimit, onError: tooLarge }),
  importPlays,
);

settingsApp.post(
  "/import/remove",
  bodyLimit({ maxSize: importBodyLimit, onError: tooLarge }),
  importRemove,
);

settingsApp.post("/tokens/revoke", async (context) => {
  const user = context.get("user");
  const id = Number(await form(context, "id"));
  const now = Math.floor(Date.now() / 1000);
  await context.env.DB.prepare(
    `UPDATE tokens SET revoked_at = ?1 WHERE id = ?2 AND source_id IN
     (SELECT id FROM sources WHERE user_id = ?3) AND revoked_at IS NULL`,
  )
    .bind(now, id, user.id)
    .run();
  return context.redirect("/settings", 303);
});

const exportSql = `
  SELECT plays.played_at, plays.source_id, sources.kind AS source,
         plays.ref, artists.name AS artist, tracks.title
  FROM plays
  JOIN sources ON sources.id = plays.source_id
  JOIN tracks ON tracks.id = plays.track_id
  JOIN artists ON artists.id = tracks.artist_id
  WHERE plays.user_id = ?1
    AND (plays.played_at, plays.source_id, plays.ref) > (?2, ?3, ?4)
  ORDER BY plays.played_at, plays.source_id, plays.ref
  LIMIT ${exportPageSize}
`;

settingsApp.get("/export", async (context) => {
  const user = context.get("user");
  const afterParam = context.req.query("after");
  const parts = afterParam?.split(",") ?? [];
  const after: [number, number, string] =
    parts.length >= 3
      ? [Number(parts[0]), Number(parts[1]), parts.slice(2).join(",")]
      : [0, 0, ""];
  if (
    parts.length >= 3 &&
    (!Number.isFinite(after[0]) || !Number.isFinite(after[1]))
  )
    return context.text("Bad after key", 400);
  const page = await context.env.DB.prepare(exportSql)
    .bind(user.id, ...after)
    .all<ExportRow>();
  const body = page.results
    .map((row) => {
      const { source_id: _sourceId, ...line } = row;
      return `${JSON.stringify(line)}\n`;
    })
    .join("");
  const last = page.results[page.results.length - 1];
  const headers: Record<string, string> = {
    "content-type": "application/x-ndjson; charset=utf-8",
    "content-disposition": `attachment; filename="${user.name}-plays.ndjson"`,
  };
  if (last !== undefined && page.results.length === exportPageSize) {
    const key = `${last.played_at},${last.source_id},${encodeURIComponent(last.ref)}`;
    headers.link = `</settings/export?after=${key}>; rel="next"`;
  }
  return new Response(body, { headers });
});

settingsApp.post("/delete", async (context) => {
  const user = context.get("user");
  const confirm = await form(context, "confirm");
  const data = await pageData(context);
  if (confirm !== user.name)
    return render(
      context,
      data,
      {
        error: `Type ${user.name} to delete the account.`,
        field: "confirm",
      },
      400,
    );
  await context.env.DB.batch(deletionStatements(context.env.DB, user.id));
  deleteCookie(context, "session", cookieClear);
  return context.redirect("/", 303);
});
