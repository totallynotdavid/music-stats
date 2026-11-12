const daySeconds = 86400;
const pairWindowSeconds = 600;

const sourceRank = new Map<string, number>([
  ["spotify", 0],
  ["listenbrainz", 1],
  ["lastfm", 2],
  ["ytmusic", 3],
]);

interface PlayRow {
  at: number;
  sourceId: number;
  ref: string;
  trackId: number;
  dup: number;
  kind: string;
}

const playsSql = `
  SELECT plays.played_at AS at,
    plays.source_id AS sourceId,
    plays.ref,
    plays.track_id AS trackId,
    plays.dup,
    sources.kind
  FROM plays
  JOIN sources ON sources.id = plays.source_id
  WHERE plays.user_id = ?1 AND plays.track_id = ?2
    AND plays.played_at BETWEEN ?3 AND ?4
  ORDER BY plays.played_at, plays.source_id, plays.ref
`;

const touchedSql = `
  SELECT track_id AS id, MIN(played_at) AS lo, MAX(played_at) AS hi
  FROM plays
  WHERE user_id = ?1 AND played_at BETWEEN ?2 AND ?3
  GROUP BY track_id
`;

const extendSql = `
  SELECT 'lo' AS k, MAX(played_at) AS v
  FROM plays
  WHERE user_id = ?1 AND track_id = ?2
    AND played_at >= ?3 AND played_at < ?4
  UNION ALL
  SELECT 'hi', MIN(played_at)
  FROM plays
  WHERE user_id = ?1 AND track_id = ?2
    AND played_at > ?5 AND played_at <= ?6
  UNION ALL
  SELECT 'ym', MIN(plays.played_at)
  FROM plays
  JOIN sources ON sources.id = plays.source_id
  WHERE plays.user_id = ?1 AND plays.track_id = ?2
    AND sources.kind = 'ytmusic' AND plays.played_at BETWEEN ?7 AND ?8
  UNION ALL
  SELECT 'yx', MAX(plays.played_at)
  FROM plays
  JOIN sources ON sources.id = plays.source_id
  WHERE plays.user_id = ?1 AND plays.track_id = ?2
    AND sources.kind = 'ytmusic' AND plays.played_at BETWEEN ?7 AND ?8
`;

async function batchAll(db: D1Database, stmts: D1PreparedStatement[]) {
  const out: D1Result[] = [];
  for (let index = 0; index < stmts.length; index += 40)
    out.push(...(await db.batch(stmts.slice(index, index + 40))));
  return out;
}

const markSql = `
  UPDATE plays SET dup = 1
  WHERE user_id = ?1 AND dup = 0
    AND (played_at, source_id, ref) IN (
      SELECT json_extract(item.value, '$.a'),
        json_extract(item.value, '$.s'),
        json_extract(item.value, '$.r')
      FROM json_each(?2) AS item
    )
`;

function pairPlays(
  anchors: PlayRow[],
  seekers: PlayRow[],
  dayRule: boolean,
): PlayRow[] {
  const candidatesOf = new Map<PlayRow, number[]>();
  const candidates = (seeker: PlayRow) => {
    let list = candidatesOf.get(seeker);
    if (list) return list;
    const day = Math.floor(seeker.at / daySeconds);
    list = [];
    for (const [index, anchor] of anchors.entries()) {
      const near = dayRule
        ? Math.floor(anchor.at / daySeconds) === day
        : Math.abs(anchor.at - seeker.at) <= pairWindowSeconds;
      if (near) list.push(index);
    }
    list.sort(
      (a, b) =>
        Math.abs(anchors[a].at - seeker.at) -
        Math.abs(anchors[b].at - seeker.at),
    );
    candidatesOf.set(seeker, list);
    return list;
  };
  const owner: (PlayRow | null)[] = anchors.map(() => null);
  const claim = (seeker: PlayRow, seen: Set<number>): boolean => {
    for (const index of candidates(seeker)) {
      if (seen.has(index)) continue;
      seen.add(index);
      const holder = owner[index];
      if (holder === null || claim(holder, seen)) {
        owner[index] = seeker;
        return true;
      }
    }
    return false;
  };
  const paired = seekers.filter((play) => play.dup === 1);
  const open = seekers.filter((play) => play.dup === 0);
  for (const seeker of [...paired, ...open]) claim(seeker, new Set());
  return owner.filter((seeker): seeker is PlayRow => seeker !== null);
}

export interface MarkResult {
  marked: number;
  rowsWritten: number;
}

export async function markDuplicates(
  db: D1Database,
  userId: number,
  from: number,
  to: number,
): Promise<MarkResult> {
  const touched = (
    await db
      .prepare(touchedSql)
      .bind(userId, from, to)
      .all<{ id: number; lo: number; hi: number }>()
  ).results;
  if (touched.length === 0) return { marked: 0, rowsWritten: 0 };
  const bounds = new Map(
    touched.map((row) => [row.id, { lo: row.lo, hi: row.hi }]),
  );
  const pending = new Map(bounds);
  while (pending.size > 0) {
    const work = [...pending.entries()];
    const out = await batchAll(
      db,
      work.map(([id, b]) =>
        db
          .prepare(extendSql)
          .bind(
            userId,
            id,
            b.lo - pairWindowSeconds,
            b.lo,
            b.hi,
            b.hi + pairWindowSeconds,
            Math.floor(b.lo / daySeconds) * daySeconds,
            (Math.floor(b.hi / daySeconds) + 1) * daySeconds - 1,
          ),
      ),
    );
    pending.clear();
    for (const [index, [id, b]] of work.entries()) {
      const rows = out[index].results as { k: string; v: number | null }[];
      const at = (key: string) => rows.find((row) => row.k === key)?.v;
      const lo = at("lo");
      const hi = at("hi");
      const ym = at("ym");
      const yx = at("yx");
      const oldLo = b.lo;
      const oldHi = b.hi;
      if (lo !== null && lo !== undefined) b.lo = lo;
      if (hi !== null && hi !== undefined) b.hi = hi;
      if (ym !== null && ym !== undefined && yx !== null && yx !== undefined) {
        b.lo = Math.min(b.lo, Math.floor(ym / daySeconds) * daySeconds);
        b.hi = Math.max(
          b.hi,
          (Math.floor(yx / daySeconds) + 1) * daySeconds - 1,
        );
      }
      if (b.lo !== oldLo || b.hi !== oldHi) pending.set(id, b);
    }
  }
  const plays: PlayRow[] = [];
  for (const result of await batchAll(
    db,
    [...bounds].map(([id, b]) =>
      db.prepare(playsSql).bind(userId, id, b.lo, b.hi),
    ),
  ))
    plays.push(...(result.results as unknown as PlayRow[]));
  const byTrack = new Map<number, PlayRow[]>();
  for (const play of plays) {
    const group = byTrack.get(play.trackId);
    if (group) group.push(play);
    else byTrack.set(play.trackId, [play]);
  }
  const losers = new Set<PlayRow>();
  for (const group of byTrack.values()) {
    const byKind = new Map<string, PlayRow[]>();
    for (const play of group) {
      const kind = byKind.get(play.kind);
      if (kind) kind.push(play);
      else byKind.set(play.kind, [play]);
    }
    const kinds = [...byKind.keys()].sort(
      (a, b) =>
        (sourceRank.get(a) ?? sourceRank.size) -
        (sourceRank.get(b) ?? sourceRank.size),
    );
    for (let worse = 1; worse < kinds.length; worse += 1) {
      const pool: PlayRow[] = [];
      for (let better = 0; better < worse; better += 1)
        for (const play of byKind.get(kinds[better])!)
          if (play.dup === 0 && !losers.has(play)) pool.push(play);
      const seekers = byKind
        .get(kinds[worse])!
        .filter((play) => !losers.has(play));
      if (pool.length === 0 || seekers.length === 0) continue;
      pool.sort((a, b) => a.at - b.at);
      seekers.sort((a, b) => a.at - b.at);
      const dayRule = kinds[worse] === "ytmusic";
      for (const loser of pairPlays(pool, seekers, dayRule)) losers.add(loser);
    }
  }
  const unmarked = [...losers].filter((play) => play.dup === 0);
  if (unmarked.length === 0) return { marked: 0, rowsWritten: 0 };
  const payload = JSON.stringify(
    unmarked.map((play) => ({ a: play.at, s: play.sourceId, r: play.ref })),
  );
  const result = await db.prepare(markSql).bind(userId, payload).run();
  return {
    marked: unmarked.length,
    rowsWritten: result.meta?.rows_written ?? 0,
  };
}
