export const daySeconds = 86400;
export const pairWindowSeconds = 600;

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

const sourcesSql = `
  SELECT id, kind FROM sources WHERE user_id = ?1
`;

const spanSql = `
  SELECT played_at AS at, source_id AS sourceId, ref,
    track_id AS trackId, dup
  FROM plays
  WHERE user_id = ?1 AND played_at BETWEEN ?2 AND ?3
  ORDER BY played_at, source_id, ref
`;

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

const dayFloor = (at: number) => Math.floor(at / daySeconds) * daySeconds;
const dayEnd = (at: number) =>
  (Math.floor(at / daySeconds) + 1) * daySeconds - 1;

function firstWhere<T>(list: T[], pred: (item: T) => boolean) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(list[mid])) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface TrackSpan {
  plays: PlayRow[];
  earlier: PlayRow[];
  ym: number[];
  ymEarlier: number[];
  lo: number;
  hi: number;
  left: number;
  right: number;
  settled: boolean;
}

function ytBounds(span: TrackSpan) {
  const lo = dayFloor(span.lo);
  const hi = dayEnd(span.hi);
  let min: number | undefined;
  let max: number | undefined;
  const i0 = firstWhere(span.ym, (a) => a >= lo);
  const i1 = firstWhere(span.ym, (a) => a > hi);
  if (i0 < i1) {
    min = span.ym[i0];
    max = span.ym[i1 - 1];
  }
  const j0 = firstWhere(span.ymEarlier, (a) => a <= hi);
  const j1 = firstWhere(span.ymEarlier, (a) => a < lo);
  if (j0 < j1) {
    const y0 = span.ymEarlier[j1 - 1];
    const y1 = span.ymEarlier[j0];
    if (min === undefined || y0 < min) min = y0;
    if (max === undefined || y1 > max) max = y1;
  }
  if (min === undefined || max === undefined) return undefined;
  return [min, max] as const;
}

function extendSpan(span: TrackSpan) {
  let moved = true;
  while (moved) {
    moved = false;
    while (span.left < span.earlier.length) {
      const at = span.earlier[span.left].at;
      if (at < span.lo - pairWindowSeconds) break;
      if (at < span.lo) {
        span.lo = at;
        moved = true;
      }
      span.left += 1;
    }
    while (span.right < span.plays.length) {
      const at = span.plays[span.right].at;
      if (at > span.hi + pairWindowSeconds) break;
      if (at > span.hi) {
        span.hi = at;
        moved = true;
      }
      span.right += 1;
    }
    const days = ytBounds(span);
    if (days !== undefined) {
      const lo = Math.min(span.lo, dayFloor(days[0]));
      const hi = Math.max(span.hi, dayEnd(days[1]));
      if (lo !== span.lo || hi !== span.hi) {
        span.lo = lo;
        span.hi = hi;
        moved = true;
      }
    }
  }
}

function pairPlays(anchors: PlayRow[], seekers: PlayRow[]): PlayRow[] {
  const candidatesOf = new Map<PlayRow, number[]>();
  const candidates = (seeker: PlayRow) => {
    let list = candidatesOf.get(seeker);
    if (list) return list;
    const day = Math.floor(seeker.at / daySeconds);
    list = [];
    for (const [index, anchor] of anchors.entries()) {
      const dayRule = anchor.kind === "ytmusic" || seeker.kind === "ytmusic";
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
  const sourceKinds = new Map<number, string>();
  for (const row of (
    await db
      .prepare(sourcesSql)
      .bind(userId)
      .all<{ id: number; kind: string }>()
  ).results)
    sourceKinds.set(row.id, row.kind);
  const read = async (lo: number, hi: number) => {
    const rows = (await db.prepare(spanSql).bind(userId, lo, hi).all<PlayRow>())
      .results;
    const plays: PlayRow[] = [];
    for (const row of rows) {
      const kind = sourceKinds.get(row.sourceId);
      if (kind !== undefined) plays.push({ ...row, kind });
    }
    return plays;
  };
  const grouped = new Map<number, PlayRow[]>();
  for (const play of await read(from, to)) {
    const group = grouped.get(play.trackId);
    if (group) group.push(play);
    else grouped.set(play.trackId, [play]);
  }
  if (grouped.size === 0) return { marked: 0, rowsWritten: 0 };
  const spans = new Map<number, TrackSpan>();
  for (const [id, plays] of grouped)
    spans.set(id, {
      plays,
      earlier: [],
      ym: plays
        .filter((play) => play.kind === "ytmusic")
        .map((play) => play.at),
      ymEarlier: [],
      lo: plays[0].at,
      hi: plays[plays.length - 1].at,
      left: 0,
      right: plays.length,
      settled: false,
    });
  const covered = { lo: from, hi: to };
  const merge = (list: PlayRow[], before: boolean) => {
    if (before)
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const play = list[index];
        const span = spans.get(play.trackId);
        if (span === undefined || span.settled) continue;
        span.earlier.push(play);
        if (play.kind === "ytmusic") span.ymEarlier.push(play.at);
      }
    else
      for (const play of list) {
        const span = spans.get(play.trackId);
        if (span === undefined || span.settled) continue;
        span.plays.push(play);
        if (play.kind === "ytmusic") span.ym.push(play.at);
      }
  };
  for (;;) {
    let needLo = covered.lo;
    let needHi = covered.hi;
    for (const span of spans.values()) {
      if (span.settled) continue;
      extendSpan(span);
      const lo = Math.min(span.lo - pairWindowSeconds, dayFloor(span.lo));
      const hi = Math.max(span.hi + pairWindowSeconds, dayEnd(span.hi));
      if (lo >= covered.lo && hi <= covered.hi) {
        span.settled = true;
        continue;
      }
      needLo = Math.min(needLo, lo);
      needHi = Math.max(needHi, hi);
    }
    if (needLo >= covered.lo && needHi <= covered.hi) break;
    if (needLo < covered.lo) {
      merge(await read(needLo, covered.lo - 1), true);
      covered.lo = needLo;
    }
    if (needHi > covered.hi) {
      merge(await read(covered.hi + 1, needHi), false);
      covered.hi = needHi;
    }
  }
  const byTrack = new Map<number, PlayRow[]>();
  for (const [id, span] of spans) {
    const plays =
      span.earlier.length === 0
        ? span.plays
        : span.earlier.reverse().concat(span.plays);
    const group = plays.filter(
      (play) => play.at >= span.lo && play.at <= span.hi,
    );
    if (group.length > 0) byTrack.set(id, group);
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
      for (const loser of pairPlays(pool, seekers)) losers.add(loser);
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
