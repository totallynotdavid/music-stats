import type { Context } from "hono";
import * as v from "valibot";
import { ingestPage, type PageSource } from "./ingest";
import type { Env } from "./types";

const maxPlays = 1000;
const uploadIntervalSeconds = 30;

interface UploadSource extends PageSource {
  token_id: number;
  last_ok_at: number | null;
}

interface UploadPlay {
  day: string;
  artist: string;
  title: string;
  video_id: string;
}

const textField = v.pipe(
  v.string(),
  v.check((value) => {
    const length = [...value].length;
    return length >= 1 && length <= 512;
  }),
);

const playSchema = (tomorrow: string) =>
  v.strictObject({
    day: v.pipe(
      v.string(),
      v.regex(/^\d{4}-\d{2}-\d{2}$/),
      v.check(
        (day) => day >= "2005-01-01" && day <= tomorrow && isRealDay(day),
      ),
    ),
    artist: textField,
    title: textField,
    video_id: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,32}$/)),
  });

const bodySchema = v.strictObject({
  client: v.optional(v.string()),
  plays: v.array(v.unknown()),
});

const tokenPattern = /^msu_[A-Za-z0-9_-]{43}$/;

const tokenSql = `
  SELECT tokens.id AS token_id,
    sources.id,
    sources.user_id,
    sources.status,
    sources.last_page,
    sources.play_seq,
    sources.gap_at,
    sources.last_ok_at
  FROM tokens
  JOIN sources ON sources.id = tokens.source_id
  WHERE tokens.hash = ?1 AND tokens.revoked_at IS NULL
    AND sources.kind = 'ytmusic'
`;

const writeTokenSql = "UPDATE tokens SET last_used_at = ?1 WHERE id = ?2";

function isRealDay(day: string) {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  return (
    !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === day
  );
}

function isoDay(timestamp: number) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function readToken(header: string | undefined) {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (match === null || !tokenPattern.test(match[1])) return null;
  return match[1];
}

function refuse(context: Context, error: string, indexes: number[] = []) {
  return context.json(
    { error, errors: indexes.map((index) => ({ index })) },
    422,
  );
}

function reply(result: {
  received: number;
  inserted: number;
  gap: boolean;
  ambiguous: number;
}) {
  return {
    received: result.received,
    inserted: result.inserted,
    duplicate: result.received - result.inserted,
    gap: result.gap,
    ambiguous: result.ambiguous,
  };
}

function checkHeaders(context: Context) {
  const mediaType = context.req
    .header("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json")
    return context.json(
      { error: "Content-Type must be application/json" },
      415,
    );
  const encoding = context.req.header("content-encoding");
  if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity")
    return context.json({ error: "Content-Encoding is not accepted" }, 415);
  return null;
}

async function authenticate(context: Context<{ Bindings: Env }>) {
  const token = readToken(context.req.header("authorization"));
  if (token === null)
    return context.json({ error: "unknown or revoked token" }, 401);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const source = await context.env.DB.prepare(tokenSql)
    .bind(new Uint8Array(digest))
    .first<UploadSource>();
  return source ?? context.json({ error: "unknown or revoked token" }, 401);
}

function rateLimit(context: Context, source: UploadSource, now: number) {
  if (
    source.last_ok_at === null ||
    now - source.last_ok_at >= uploadIntervalSeconds
  )
    return null;
  context.header(
    "Retry-After",
    String(uploadIntervalSeconds - (now - source.last_ok_at)),
  );
  return context.json({ error: "one upload per source every 30 seconds" }, 429);
}

async function readPlays(context: Context, now: number) {
  const body = await context.req.raw.text();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return refuse(context, "the body is not JSON");
  }
  const parsed = v.safeParse(bodySchema, json);
  if (!parsed.success)
    return refuse(context, "the body must hold only client and plays");
  if (parsed.output.plays.length > maxPlays)
    return refuse(context, "plays holds at most 1000 items");
  const itemSchema = playSchema(isoDay(now + 86400));
  const plays: UploadPlay[] = [];
  const failing: number[] = [];
  parsed.output.plays.forEach((item, index) => {
    const result = v.safeParse(itemSchema, item);
    if (result.success) plays.push(result.output);
    else failing.push(index);
  });
  return failing.length > 0 ? refuse(context, "invalid plays", failing) : plays;
}

export async function uploadPlays(context: Context<{ Bindings: Env }>) {
  const badHeaders = checkHeaders(context);
  if (badHeaders) return badHeaders;
  const source = await authenticate(context);
  if (source instanceof Response) return source;
  const now = Math.floor(Date.now() / 1000);
  const limited = rateLimit(context, source, now);
  if (limited) return limited;
  const plays = await readPlays(context, now);
  if (plays instanceof Response) return plays;

  if (plays.length === 0)
    return context.json(
      reply({ received: 0, inserted: 0, gap: false, ambiguous: 0 }),
      200,
    );

  const db = context.env.DB;
  const result = await ingestPage(db, source, plays, {
    now,
    extra: [db.prepare(writeTokenSql).bind(now, source.token_id)],
  });
  if (result.raced)
    return context.json({ error: "two uploads raced; send again" }, 409);
  return context.json(reply(result), 200);
}
