import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env } from "./types";

const sessionSeconds = 30 * 86400;
const stateSeconds = 600;

const cookieBase = {
  prefix: "host",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
} as const;

export const cookieClear = {
  prefix: "host",
  secure: true,
  path: "/",
} as const;

export interface SignedInUser {
  id: number;
  name: string;
  is_public: number;
}

interface GithubUser {
  id: number;
  login: string;
}

const reservedNames = new Set(["api", "auth", "settings", "u"]);
const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export function validName(name: string) {
  return namePattern.test(name) && !reservedNames.has(name);
}

export function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function sha256Bytes(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

type AuthContext = Context<{ Bindings: Env }>;

export async function sessionUser<E extends { Bindings: Env }>(
  context: Context<E>,
) {
  const value = getCookie(context, "session", "host");
  if (value === undefined) return null;
  const env = context.env;
  const now = Math.floor(Date.now() / 1000);
  const hash = await sha256Bytes(value);
  return env.DB.prepare(
    `SELECT users.id, users.name, users.is_public
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.hash = ?1 AND sessions.expires_at > ?2`,
  )
    .bind(hash, now)
    .first<SignedInUser>();
}

export async function newSession(db: D1Database, userId: number, now: number) {
  const value = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Bytes(value);
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(now),
    db
      .prepare(
        "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
      )
      .bind(hash, userId, now + sessionSeconds),
  ]);
  return value;
}

export async function endSession<E extends { Bindings: Env }>(
  context: Context<E>,
) {
  const value = getCookie(context, "session", "host");
  if (value === undefined) return;
  const hash = await sha256Bytes(value);
  await context.env.DB.prepare("DELETE FROM sessions WHERE hash = ?1")
    .bind(hash)
    .run();
}

function githubCredentials(context: AuthContext) {
  const id = context.env.GITHUB_CLIENT_ID;
  const secret = context.env.GITHUB_CLIENT_SECRET;
  if (!id || !secret)
    return context.text("GitHub sign-in is not configured", 503);
  return { id, secret };
}

export function beginGithub(context: AuthContext) {
  const credentials = githubCredentials(context);
  if (credentials instanceof Response) return credentials;
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", credentials.id);
  target.searchParams.set(
    "redirect_uri",
    `${new URL(context.req.url).origin}/auth/github/callback`,
  );
  target.searchParams.set("state", state);
  setCookie(context, "oauth-state", state, {
    ...cookieBase,
    maxAge: stateSeconds,
  });
  return context.redirect(target.toString(), 302);
}

async function availableName(db: D1Database, login: string) {
  const base =
    login
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 39) || "user";
  for (let n = 0; n < 100; n += 1) {
    const suffix = n === 0 ? "" : `-${n + 1}`;
    const name = `${base.slice(0, 39 - suffix.length)}${suffix}`;
    if (!validName(name)) continue;
    const taken = await db
      .prepare("SELECT 1 AS taken FROM users WHERE name = ?1 COLLATE NOCASE")
      .bind(name)
      .first();
    if (taken === null) return name;
  }
  return `gh-${base64url(crypto.getRandomValues(new Uint8Array(6)))}`;
}

async function findOrCreateUser(
  db: D1Database,
  github: GithubUser,
  now: number,
) {
  const existing = await db
    .prepare("SELECT id, name FROM users WHERE github_id = ?1")
    .bind(github.id)
    .first<{ id: number; name: string }>();
  if (existing !== null) {
    await db
      .prepare("UPDATE users SET github_login = ?1 WHERE id = ?2")
      .bind(github.login, existing.id)
      .run();
    return existing;
  }
  const name = await availableName(db, github.login);
  try {
    const created = await db
      .prepare(
        `INSERT INTO users (github_id, github_login, name, created_at)
         VALUES (?1, ?2, ?3, ?4) RETURNING id, name`,
      )
      .bind(github.id, github.login, name, now)
      .first<{ id: number; name: string }>();
    if (created !== null) return created;
  } catch {
    // Two sign-ins raced on the same GitHub account.
  }
  const raced = await db
    .prepare("SELECT id, name FROM users WHERE github_id = ?1")
    .bind(github.id)
    .first<{ id: number; name: string }>();
  if (raced === null) throw new Error("could not create the user");
  return raced;
}

export async function githubCallback(context: AuthContext) {
  const credentials = githubCredentials(context);
  if (credentials instanceof Response) return credentials;
  const origin = new URL(context.req.url).origin;
  const code = context.req.query("code");
  const state = context.req.query("state");
  const expected = getCookie(context, "oauth-state", "host");
  deleteCookie(context, "oauth-state", cookieClear);
  if (!code || !state || expected === undefined || state !== expected)
    return context.text("The sign-in state does not match. Start again.", 400);

  const failed = () => context.text("GitHub sign-in failed. Start again.", 502);
  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: credentials.id,
      client_secret: credentials.secret,
      code,
      redirect_uri: `${origin}/auth/github/callback`,
    }).toString(),
  });
  if (!exchange.ok) return failed();
  const token = (await exchange.json()) as {
    access_token?: string;
    error?: string;
  };
  if (typeof token.access_token !== "string") return failed();

  const githubResponse = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "music-stats-web",
    },
  });
  if (!githubResponse.ok) return failed();
  const github = (await githubResponse.json()) as GithubUser;
  if (typeof github.id !== "number" || typeof github.login !== "string")
    return failed();

  const now = Math.floor(Date.now() / 1000);
  const user = await findOrCreateUser(context.env.DB, github, now);
  const session = await newSession(context.env.DB, user.id, now);
  setCookie(context, "session", session, {
    ...cookieBase,
    maxAge: sessionSeconds,
  });
  return context.redirect("/settings", 303);
}
