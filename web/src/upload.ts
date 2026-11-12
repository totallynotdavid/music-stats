import type { Context } from "hono";
import * as v from "valibot";
import { alignPage, type Alignment, type PagePair } from "./align";
import { markDuplicates } from "./duplicates";
import {
  aliasInsertRows,
  artistInsertRows,
  bulkAliasSql,
  bulkArtistSql,
  bulkTrackSql,
  resolveStoredPage,
  type PageResolution,
} from "./matching";
import type { Env } from "./types";

const maxPlays = 1000;
const uploadIntervalSeconds = 30;

interface UploadSource {
  token_id: number;
  id: number;
  user_id: number;
  status: string;
  last_page: string | null;
  play_seq: number;
  gap_at: number | null;
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

const writePlaySql = `
  INSERT OR IGNORE INTO plays (user_id, played_at, source_id, ref, track_id)
  SELECT
    json_extract(item.value, '$.userId'),
    json_extract(item.value, '$.listenedAt'),
    json_extract(item.value, '$.sourceId'),
    json_extract(item.value, '$.ref'),
    (SELECT id FROM tracks WHERE key = json_extract(item.value, '$.trackKey'))
  FROM json_each(?1) AS item
  WHERE (SELECT play_seq FROM sources WHERE id = ?2) = ?3
`;

const writeSourceSql = `
  UPDATE sources SET
    last_page = ?1,
    play_seq = play_seq + ?2,
    maybe_missing = maybe_missing + ?3,
    status = ?4,
    gap_at = ?5,
    last_ok_at = ?6
  WHERE id = ?7 AND play_seq = ?8
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

function reply(
  received: number,
  inserted: number,
  gap: boolean,
  ambiguous: number,
) {
  return {
    received,
    inserted,
    duplicate: received - inserted,
    gap,
    ambiguous,
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

async function touchReplay(db: D1Database, source: UploadSource, now: number) {
  await db.batch([
    db
      .prepare("UPDATE sources SET last_ok_at = ?1 WHERE id = ?2")
      .bind(now, source.id),
    db.prepare(writeTokenSql).bind(now, source.token_id),
  ]);
}

function uploadListenedAt(play: UploadPlay) {
  return Date.parse(`${play.day}T12:00:00.000Z`) / 1000;
}

function pageDayRange(plays: UploadPlay[]): [number, number] {
  const times = plays.map(uploadListenedAt);
  return [Math.min(...times), Math.max(...times)];
}

async function resolveUpload(
  db: D1Database,
  source: UploadSource,
  added: UploadPlay[],
): Promise<PageResolution> {
  const inputs = added
    .map((play) => ({
      kind: "ytmusic",
      sourceKey: play.video_id,
      artist: play.artist,
      title: play.title,
      listenedAt: uploadListenedAt(play),
      userId: source.user_id,
      sourceId: source.id,
    }))
    .reverse();
  const empty: PageResolution = { listens: [], newTracks: [] };
  if (inputs.length === 0) return empty;
  return resolveStoredPage(db, inputs, "ytmusic");
}

async function storeUpload(
  db: D1Database,
  source: UploadSource,
  added: UploadPlay[],
  alignment: Alignment,
  pageJson: string,
  now: number,
) {
  const { listens, newTracks } = await resolveUpload(db, source, added);

  const statements: D1PreparedStatement[] = [];
  if (newTracks.length > 0) {
    statements.push(
      db.prepare(bulkArtistSql).bind(artistInsertRows(newTracks)),
      db.prepare(bulkTrackSql).bind(JSON.stringify(newTracks)),
    );
  }
  let playsIndex = -1;
  if (listens.length > 0) {
    statements.push(
      db.prepare(bulkAliasSql).bind(aliasInsertRows(listens), "ytmusic"),
      db.prepare(writePlaySql).bind(
        JSON.stringify(
          listens.map((listen, index) => ({
            ...listen,
            ref: `${listen.sourceKey}#${source.play_seq + index + 1}`,
          })),
        ),
        source.id,
        source.play_seq,
      ),
    );
    playsIndex = statements.length - 1;
  }
  const updateIndex = statements.length;
  statements.push(
    db
      .prepare(writeSourceSql)
      .bind(
        pageJson,
        listens.length,
        alignment.ambiguous,
        alignment.gap ? "gap" : "active",
        alignment.gap ? now : source.gap_at,
        now,
        source.id,
        source.play_seq,
      ),
    db.prepare(writeTokenSql).bind(now, source.token_id),
  );

  const results = await db.batch(statements);
  if ((results[updateIndex]?.meta?.changes ?? 0) === 0) return null;
  return { inserted: playsIndex >= 0 ? listens.length : 0, listens };
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

  if (plays.length === 0) return context.json(reply(0, 0, false, 0), 200);

  const pairs: PagePair[] = plays.map((play) => [play.day, play.video_id]);
  const pageJson = JSON.stringify(pairs);
  if (source.last_page === pageJson) {
    await markDuplicates(
      context.env.DB,
      source.user_id,
      ...pageDayRange(plays),
    );
    await touchReplay(context.env.DB, source, now);
    return context.json(
      reply(plays.length, 0, source.status === "gap", 0),
      200,
    );
  }
  const previous =
    source.last_page === null
      ? null
      : (JSON.parse(source.last_page) as PagePair[]);
  const alignment = alignPage(previous, pairs);
  const added = plays.slice(0, alignment.newCount);
  const stored = await storeUpload(
    context.env.DB,
    source,
    added,
    alignment,
    pageJson,
    now,
  );
  if (stored === null)
    return context.json({ error: "two uploads raced; send again" }, 409);
  const times =
    stored.listens.length > 0
      ? stored.listens.map((listen) => listen.listenedAt)
      : pageDayRange(plays);
  await markDuplicates(
    context.env.DB,
    source.user_id,
    Math.min(...times),
    Math.max(...times),
  );
  return context.json(
    reply(plays.length, stored.inserted, alignment.gap, alignment.ambiguous),
    200,
  );
}
