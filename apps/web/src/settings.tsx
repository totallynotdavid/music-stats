import { Hono } from "hono";
import type { Context } from "hono";
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
import { page } from "./layout";
import { sourceNames } from "./names";
import type { Env } from "./types";

const exportPageSize = 1000;

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
  kind: string;
}

interface ExportRow {
  played_at: number;
  source_id: number;
  source: string;
  ref: string;
  artist: string;
  title: string;
}

function dayText(timestamp: number | null) {
  if (timestamp === null) return "never";
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function sourceStatus(source: SourceInfo) {
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

export function signInPage() {
  return page({
    title: "Sign in",
    children: (
      <>
        <div class="page-head">
          <h1>Sign in</h1>
          <p>
            Music stats stores the plays you connect from Spotify and YouTube
            Music. It shows your top tracks, top artists and plays per day on a
            public page at <code>/u/name</code>.
          </p>
        </div>
        <div class="stack">
          <div>
            <a class="button primary" href="/auth/github">
              Sign in with GitHub
            </a>
          </div>
          <p class="hint">
            Profiles are public until you hide them in settings.
          </p>
        </div>
      </>
    ),
  });
}

interface PageOptions {
  notice?: string;
  error?: string;
  field?: string;
  issuedToken?: string;
  issuedKind?: string;
}

function settingsPage(
  user: SignedInUser,
  sources: SourceInfo[],
  tokens: TokenInfo[],
  options: PageOptions,
  origin: string,
) {
  const { notice, error, field, issuedToken, issuedKind } = options;
  const uploadTokens = tokens.filter((token) => token.kind === "ytmusic");
  const scrobblerTokens = tokens.filter(
    (token) => token.kind === "listenbrainz",
  );
  const tokenList = (items: TokenInfo[]) => (
    <ul class="rows">
      {items.map((token) => (
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
  );
  const fieldError = (name: string) =>
    field === name && error ? (
      <p class="form-error" id={`${name}-error`} role="alert">
        <b>Error:</b> {error}
      </p>
    ) : null;
  const invalid = (name: string) =>
    field === name && error
      ? { "aria-invalid": "true", "aria-describedby": `${name}-error` }
      : {};
  const topError = field === undefined && error !== undefined && (
    <p class="form-error" role="alert">
      <b>Error:</b> {error}
    </p>
  );
  return page({
    title: "Settings",
    account: (
      <>
        <a href={`/u/${encodeURIComponent(user.name)}`}>View profile</a>
        <form method="post" action="/settings/sign-out">
          <button class="link" type="submit">
            Sign out
          </button>
        </form>
      </>
    ),
    children: (
      <>
        <div class="page-head">
          <h1>Settings</h1>
          <p class="meta">
            Signed in as <b>{user.name}</b>.
          </p>
        </div>
        {notice !== undefined && <p class="notice">{notice}</p>}
        {topError}
        {issuedToken !== undefined && (
          <section class="notice" aria-label="New token">
            <p>
              Your new {issuedKind === "listenbrainz" ? "scrobbler" : "upload"}{" "}
              token. It is shown once. Store it now.
            </p>
            <code class="token">{issuedToken}</code>
          </section>
        )}
        <section class="section">
          <div class="section-head">
            <h2>Profile</h2>
          </div>
          <form class="section-body" method="post" action="/settings/profile">
            <div class="field">
              <label for="name">Profile name</label>
              <small>
                Lowercase letters, digits and hyphens, no hyphen at either end.
                Your page is at /u/&lt;name&gt;.
              </small>
              {fieldError("name")}
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
                {...invalid("name")}
              />
            </div>
            <div>
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
                A hidden profile returns 404 for the page, the JSON and the
                card.
              </small>
            </div>
            <div>
              <button class="primary" type="submit">
                Save profile
              </button>
            </div>
          </form>
        </section>
        <section class="section">
          <div class="section-head">
            <h2>Sources</h2>
          </div>
          <div class="section-body">
            {sources.length === 0 ? (
              <p class="muted">No sources connected.</p>
            ) : (
              <ul class="rows">
                {sources.map((source) => (
                  <li key={source.id}>
                    <span class="track">
                      <b>{sourceNames[source.kind] ?? source.kind}</b>
                      <small>
                        {source.account ??
                          (source.kind === "ytmusic"
                            ? "upload token"
                            : "scrobbler token")}{" "}
                        · {sourceStatus(source)}
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
            <div>
              <a class="button" href="/auth/spotify">
                Connect Spotify
              </a>
            </div>
            <small class="hint">
              Spotify asks you to approve read access to your recently played
              tracks, then the service pulls them every few minutes.
            </small>
          </div>
        </section>
        <section class="section">
          <div class="section-head">
            <h2>YouTube Music uploads</h2>
          </div>
          <div class="section-body">
            {uploadTokens.length === 0 ? (
              <p class="muted">
                No upload token. Issue one and store it as UPLOAD_TOKEN in your
                GitHub Action's secrets.
              </p>
            ) : (
              tokenList(uploadTokens)
            )}
            <form method="post" action="/settings/tokens">
              <input type="hidden" name="kind" value="ytmusic" />
              <button type="submit">Issue a new token</button>
            </form>
          </div>
        </section>
        <section class="section">
          <div class="section-head">
            <h2>Phone scrobbler</h2>
          </div>
          <div class="section-body">
            <p class="muted">
              Install Pano Scrobbler on your Android phone.
              <br />
              Add a ListenBrainz account with server {origin} and this token.
              <br />
              Every play your phone reports appears on your profile.
            </p>
            {scrobblerTokens.length === 0 ? (
              <p class="muted">No scrobbler token.</p>
            ) : (
              tokenList(scrobblerTokens)
            )}
            <form method="post" action="/settings/tokens">
              <input type="hidden" name="kind" value="listenbrainz" />
              <button type="submit">Issue a new token</button>
            </form>
          </div>
        </section>
        <section class="section">
          <div class="section-head">
            <h2>Export</h2>
          </div>
          <div class="section-body">
            <p class="muted">
              Download your plays as NDJSON, one play per line. Without
              JavaScript the link returns the first 1,000 plays. The Link header
              of each page points at the next.
            </p>
            <div>
              <a
                class="button"
                id="export-all"
                href="/settings/export"
                data-name={user.name}
              >
                Download your plays
              </a>
            </div>
            <script
              type="module"
              dangerouslySetInnerHTML={{ __html: exportScript }}
            />
          </div>
        </section>
        <section class="section">
          <div class="section-head">
            <h2>Delete account</h2>
          </div>
          <form class="section-body" method="post" action="/settings/delete">
            <p class="muted">
              Deletes every play, source, token and session of this account.
              There is no undo.
            </p>
            <div class="field">
              <label for="confirm">Type {user.name} to confirm</label>
              {fieldError("confirm")}
              <input
                id="confirm"
                name="confirm"
                type="text"
                required
                spellcheck={false}
                autocomplete="off"
                {...invalid("confirm")}
              />
            </div>
            <div>
              <button class="danger" type="submit">
                Delete account
              </button>
            </div>
          </form>
        </section>
      </>
    ),
  });
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
      `SELECT tokens.id, tokens.hint, tokens.created_at, tokens.last_used_at,
              sources.kind
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
    settingsPage(
      data.user,
      data.sources,
      data.tokens,
      options,
      new URL(context.req.url).origin,
    ),
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
  const issuedKind = getCookie(context, "issued-token-kind", "host");
  if (issued !== undefined) {
    deleteCookie(context, "issued-token", cookieClear);
    deleteCookie(context, "issued-token-kind", cookieClear);
  }
  return render(context, data, {
    issuedToken: issued,
    issuedKind,
  });
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

const tokenKinds = new Set(["ytmusic", "listenbrainz"]);

const sourceByKindSql = `SELECT id FROM sources
  WHERE user_id = ?1 AND kind = ?2`;

settingsApp.post("/tokens", async (context) => {
  const user = context.get("user");
  const now = Math.floor(Date.now() / 1000);
  const db = context.env.DB;
  const kind = await form(context, "kind");
  if (!tokenKinds.has(kind))
    return render(
      context,
      await pageData(context),
      { error: "Unknown token kind." },
      400,
    );
  await db
    .prepare(
      `INSERT INTO sources (user_id, kind) VALUES (?1, ?2)
       ON CONFLICT (user_id, kind) DO NOTHING`,
    )
    .bind(user.id, kind)
    .run();
  const source = await db
    .prepare(sourceByKindSql)
    .bind(user.id, kind)
    .first<{ id: number }>();
  if (source === null) throw new Error("could not create the source");
  const token = newUploadToken();
  await db
    .prepare(
      "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(source.id, await sha256Bytes(token), token.slice(-4), now)
    .run();
  setCookie(context, "issued-token-kind", kind, {
    prefix: "host",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    maxAge: 120,
  });
  setCookie(context, "issued-token", token, {
    prefix: "host",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    maxAge: 120,
  });
  return context.redirect("/settings", 303);
});

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
