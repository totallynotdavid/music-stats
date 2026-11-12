import type { Context } from "hono";
import * as v from "valibot";
import type { SignedInUser } from "./auth";
import { daySeconds, markDuplicates, pairWindowSeconds } from "./duplicates";
import { storeListens } from "./matching";
import {
  backfillRowsUsed,
  maxBackfillRowsPerDay,
  nextUtcMidnight,
  recordBackfillRows,
} from "./pull";
import type { Env } from "./types";

export const importBatchSize = 100;
export const removeChunkSize = 2000;

const earliestPlay = Date.parse("2005-01-01T00:00:00.000Z") / 1000;

type SettingsContext = Context<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>;

const importKinds = ["spotify", "ytmusic"] as const;
type ImportKind = (typeof importKinds)[number];

const idPatterns: Record<ImportKind, RegExp> = {
  spotify: /^[A-Za-z0-9]{22}$/,
  ytmusic: /^[A-Za-z0-9_-]{1,32}$/,
};

const textField = v.pipe(
  v.string(),
  v.check((value) => {
    const length = [...value].length;
    return length >= 1 && length <= 512;
  }),
);

const bodySchema = v.strictObject({
  source: v.picklist(importKinds),
  plays: v.array(v.unknown()),
});

const removeSchema = v.strictObject({ source: v.picklist(importKinds) });

interface ImportPlay {
  at: number;
  id: string;
  artist: string;
  title: string;
}

function playSchema(source: ImportKind, maxAt: number) {
  return v.strictObject({
    at: v.pipe(
      v.number(),
      v.integer(),
      v.check((at) => at >= earliestPlay && at < maxAt),
    ),
    id: v.pipe(v.string(), v.regex(idPatterns[source])),
    artist: textField,
    title: textField,
  });
}

function checkMediaType(context: SettingsContext) {
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
  return null;
}

function refuse(
  context: SettingsContext,
  error: string,
  indexes: number[] = [],
) {
  return context.json(
    { error, errors: indexes.map((index) => ({ index })) },
    422,
  );
}

function capped(context: SettingsContext, used: number, now: number) {
  if (used < maxBackfillRowsPerDay) return null;
  context.header("Retry-After", String(nextUtcMidnight(now) - now));
  return context.json(
    {
      error: "the daily write limit is reached",
      used,
      limit: maxBackfillRowsPerDay,
    },
    429,
  );
}

async function readJson(
  context: SettingsContext,
  schema: v.GenericSchema,
  shape: string,
) {
  const body = await context.req.raw.text();
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return refuse(context, "the body is not JSON");
  }
  const parsed = v.safeParse(schema, json);
  if (!parsed.success)
    return refuse(context, `the body must hold only ${shape}`);
  return parsed.output;
}

async function importSource(
  db: D1Database,
  userId: number,
  kind: string,
  now: number,
) {
  return db
    .prepare(
      `INSERT INTO sources (user_id, kind, last_ok_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id, kind) DO UPDATE SET last_ok_at = ?3
       RETURNING id`,
    )
    .bind(userId, kind, now)
    .first<{ id: number }>();
}

export async function importPlays(context: SettingsContext) {
  const badType = checkMediaType(context);
  if (badType) return badType;
  const parsed = await readJson(context, bodySchema, "source and plays");
  if (parsed instanceof Response) return parsed;
  const { source, plays: items } = parsed as {
    source: ImportKind;
    plays: unknown[];
  };
  if (items.length < 1 || items.length > importBatchSize)
    return refuse(context, `plays holds 1 to ${importBatchSize} items`);
  const user = context.get("user");
  const now = Math.floor(Date.now() / 1000);
  const schema = playSchema(
    source,
    (Math.floor(now / daySeconds) + 2) * daySeconds,
  );
  const plays: ImportPlay[] = [];
  const failing: number[] = [];
  items.forEach((item, index) => {
    const result = v.safeParse(schema, item);
    if (result.success) plays.push(result.output);
    else failing.push(index);
  });
  if (failing.length > 0) return refuse(context, "invalid plays", failing);

  const db = context.env.DB;
  const used = await backfillRowsUsed(context.env);
  const limited = capped(context, used, now);
  if (limited) return limited;

  const kind = `${source}_import`;
  const sourceRow = await importSource(db, user.id, kind, now);
  if (sourceRow === null) throw new Error("could not create the import source");
  const stored = await storeListens(
    db,
    plays.map((play) => ({
      kind: source,
      sourceKey: play.id,
      artist: play.artist,
      title: play.title,
      listenedAt: play.at,
      userId: user.id,
      sourceId: sourceRow.id,
      ref: play.id,
    })),
    source,
  );
  const counted = await db
    .prepare("UPDATE sources SET play_count = play_count + ?1 WHERE id = ?2")
    .bind(stored.inserted, sourceRow.id)
    .run();
  const marked = await markDuplicates(
    db,
    user.id,
    Math.min(...plays.map((play) => play.at)),
    Math.max(...plays.map((play) => play.at)),
  );
  const rowsWritten =
    stored.rowsWritten + marked.rowsWritten + (counted.meta?.rows_written ?? 0);
  await recordBackfillRows(context.env, used + rowsWritten, now);
  return context.json({
    received: plays.length,
    inserted: stored.inserted,
    duplicate: plays.length - stored.inserted,
    used: used + rowsWritten,
    limit: maxBackfillRowsPerDay,
  });
}

interface ChunkPlay {
  at: number;
  ref: string;
  trackId: number;
}

const chunkSql = `
  SELECT played_at AS at, ref, track_id AS trackId
  FROM plays WHERE user_id = ?1 AND source_id = ?2
  ORDER BY played_at, ref LIMIT ${removeChunkSize}
`;

const reopenKeys = `
  SELECT p.user_id AS u, p.played_at AS a, p.source_id AS s, p.ref AS r,
    p.track_id AS t
  FROM json_each(?3) AS c
  CROSS JOIN plays AS p ON
    p.user_id = ?1 AND p.source_id != ?2 AND p.dup = 1
    AND p.track_id = json_extract(c.value, '$.t')
    AND p.played_at BETWEEN json_extract(c.value, '$.a') - ${pairWindowSeconds}
                        AND json_extract(c.value, '$.a') + ${pairWindowSeconds}
  UNION
  SELECT p.user_id, p.played_at, p.source_id, p.ref, p.track_id
  FROM sources AS s
  CROSS JOIN (
    SELECT DISTINCT json_extract(c.value, '$.a') / ${daySeconds} AS d
    FROM json_each(?3) AS c
  ) AS days
  CROSS JOIN plays AS p ON
    p.user_id = ?1 AND p.source_id != ?2 AND p.dup = 1
    AND p.source_id = s.id
    AND p.played_at BETWEEN days.d * ${daySeconds}
                        AND days.d * ${daySeconds} + ${daySeconds - 1}
  WHERE s.user_id = ?1 AND s.kind = 'ytmusic'
    AND (p.played_at / ${daySeconds}, p.track_id) IN (
      SELECT json_extract(c.value, '$.a') / ${daySeconds},
             json_extract(c.value, '$.t')
      FROM json_each(?3) AS c)
`;

function totalsDown(table: string, column: string, group: string, join = "") {
  const lastPlayed = table === "track_totals" ? ", last_played_at" : "";
  const lastPlayedValue = table === "track_totals" ? ", 0" : "";
  return `
    INSERT INTO ${table} (user_id, ${column}, plays${lastPlayed})
    SELECT ?1, d.k, -d.n${lastPlayedValue}
    FROM (
      SELECT ${group} AS k, COUNT(*) AS n
      FROM json_each(?3) AS j
      CROSS JOIN plays ON
        plays.user_id = ?1 AND plays.source_id = ?2
        AND plays.played_at = json_extract(j.value, '$.a')
        AND plays.ref = json_extract(j.value, '$.r')
      ${join}
      WHERE plays.dup = 0
      GROUP BY k
    ) AS d
    WHERE true
    ON CONFLICT (user_id, ${column})
    DO UPDATE SET plays = ${table}.plays + excluded.plays
  `;
}

const reopenSql = `
  UPDATE plays SET dup = 0
  FROM (${reopenKeys}) AS r
  WHERE plays.user_id = r.u AND plays.played_at = r.a
    AND plays.source_id = r.s AND plays.ref = r.r
  RETURNING played_at
`;

const playCountDownSql = `
  UPDATE sources SET play_count = play_count - (
    SELECT COUNT(*) FROM json_each(?3) AS j
    CROSS JOIN plays ON
      plays.user_id = ?1 AND plays.source_id = ?2
      AND plays.played_at = json_extract(j.value, '$.a')
      AND plays.ref = json_extract(j.value, '$.r')
  ) WHERE id = ?2
`;

const chunkDeleteSql = `
  DELETE FROM plays WHERE (user_id, played_at, source_id, ref) IN (
    SELECT ?1, json_extract(item.value, '$.a'), ?2,
      json_extract(item.value, '$.r')
    FROM json_each(?3) AS item)
`;

const totalsDeletes = [
  "DELETE FROM track_totals WHERE user_id = ?1 AND plays <= 0",
  "DELETE FROM daily_totals WHERE user_id = ?1 AND plays <= 0",
  "DELETE FROM artist_totals WHERE user_id = ?1 AND plays <= 0",
];

async function readRemoval(
  db: D1Database,
  userId: number,
  sourceId: number,
): Promise<{ chunk: ChunkPlay[] } | null> {
  const chunk = (
    await db.prepare(chunkSql).bind(userId, sourceId).all<ChunkPlay>()
  ).results;
  if (chunk.length === 0) return null;
  return { chunk };
}

function planRemoval(
  db: D1Database,
  userId: number,
  sourceId: number,
  keys: string,
  remaining: number,
): { stmts: D1PreparedStatement[]; reopenIndex: number } {
  const bind = (sql: string) => db.prepare(sql).bind(userId, sourceId, keys);
  const stmts: D1PreparedStatement[] = [
    bind(totalsDown("track_totals", "track_id", "plays.track_id")),
    db.prepare(totalsDeletes[0]!).bind(userId),
    bind(totalsDown("daily_totals", "day", "plays.played_at / 86400")),
    db.prepare(totalsDeletes[1]!).bind(userId),
    bind(
      totalsDown(
        "artist_totals",
        "artist_id",
        "tracks.artist_id",
        "JOIN tracks ON tracks.id = plays.track_id",
      ),
    ),
    db.prepare(totalsDeletes[2]!).bind(userId),
    bind(reopenSql),
    bind(playCountDownSql),
    bind(chunkDeleteSql),
  ];
  const reopenIndex = stmts.length - 3;
  if (remaining === 0)
    stmts.push(
      db
        .prepare("DELETE FROM sources WHERE id = ?1 AND user_id = ?2")
        .bind(sourceId, userId),
    );
  return { stmts, reopenIndex };
}

export async function importRemove(context: SettingsContext) {
  const badType = checkMediaType(context);
  if (badType) return badType;
  const parsed = await readJson(context, removeSchema, "source");
  if (parsed instanceof Response) return parsed;
  const { source } = parsed as { source: ImportKind };

  const user = context.get("user");
  const db = context.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const used = await backfillRowsUsed(context.env);
  const limited = capped(context, used, now);
  if (limited) return limited;

  const sourceRow = await db
    .prepare(
      "SELECT id, play_count FROM sources WHERE user_id = ?1 AND kind = ?2",
    )
    .bind(user.id, `${source}_import`)
    .first<{ id: number; play_count: number }>();
  if (sourceRow === null)
    return context.json({ source, removed: 0, remaining: 0 });

  const read = await readRemoval(db, user.id, sourceRow.id);
  if (read === null) {
    await db
      .prepare("DELETE FROM sources WHERE id = ?1 AND user_id = ?2")
      .bind(sourceRow.id, user.id)
      .run();
    return context.json({ source, removed: 0, remaining: 0 });
  }

  const keys = JSON.stringify(
    read.chunk.map((play) => ({ a: play.at, r: play.ref, t: play.trackId })),
  );
  const remaining = sourceRow.play_count - read.chunk.length;
  const { stmts, reopenIndex } = planRemoval(
    db,
    user.id,
    sourceRow.id,
    keys,
    remaining,
  );
  const results = await db.batch(stmts);
  let rowsWritten = results.reduce(
    (sum, result) => sum + (result.meta?.rows_written ?? 0),
    0,
  );
  const ats = (results[reopenIndex]?.results ?? []).map(
    (row) => (row as { played_at: number }).played_at,
  );
  if (ats.length > 0) {
    const marked = await markDuplicates(
      db,
      user.id,
      Math.min(...ats),
      Math.max(...ats),
    );
    rowsWritten += marked.rowsWritten;
  }
  await recordBackfillRows(context.env, used + rowsWritten, now);
  return context.json({
    source,
    removed: read.chunk.length,
    remaining,
  });
}
