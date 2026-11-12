import type { Env, SourceRow } from "./types";

export const maxSourcesPerPull = 1;
export const maxBackfillRowsPerDay = 50_000;
export const nextTickDelay = 60;
const backfillRowsKey = "backfill-rows";

export const idlePullDelay = (idlePulls: number) =>
  Math.min(6 * 60 * 60, 15 * 60 * 2 ** idlePulls);

export function nextPullDelay(inserted: number, idlePulls: number) {
  return inserted > 0 ? 15 * 60 : idlePullDelay(idlePulls);
}

export const nextUtcMidnight = (now: number) =>
  Math.floor(now / 86400) * 86400 + 86400;

export const dailyLimitPattern = /daily row (?:read|write) limit/i;

export async function backfillRowsUsed(env: Env) {
  if (!env.CACHE) return 0;
  const raw = await env.CACHE.get(backfillRowsKey);
  const used = raw === null ? 0 : Number(raw);
  return Number.isFinite(used) ? used : 0;
}

export async function recordBackfillRows(env: Env, used: number, now: number) {
  if (!env.CACHE || used === 0) return;
  try {
    await env.CACHE.put(backfillRowsKey, String(used), {
      expiration: nextUtcMidnight(now),
    });
  } catch {
    // A failed tally write loses the count, not the pull.
  }
}

export interface FetchedPage<T> {
  rawCount: number;
  plays: T[] | null;
  wait?: number;
}

export interface PullHooks<T> {
  pageSize: number;
  current(cursor: number | null, limit: number): Promise<FetchedPage<T>>;
  walk(bound: number, limit: number): Promise<FetchedPage<T>>;
  at(play: T): number;
  store(plays: T[]): Promise<{ inserted: number; rowsWritten: number }>;
  walkCapped?(): Promise<boolean>;
  waitBetweenPages?: number;
}

export async function pullPages<T>(
  env: Env,
  source: SourceRow,
  hooks: PullHooks<T>,
  now: number,
) {
  const { pageSize } = hooks;
  let waitUntil = 0;
  const current = await hooks.current(source.cursor, pageSize);
  const currentRaw = current.rawCount;
  const currentPage = current.plays ?? [];
  waitUntil = current.wait ?? 0;

  let inserted = (await hooks.store(currentPage)).inserted;

  let cursor = source.cursor;
  let backfillBefore = source.backfill_before;
  let gapBefore = source.gap_before;
  let gapFloor = source.gap_floor;
  if (currentPage.length > 0) {
    cursor = Math.max(cursor ?? 0, ...currentPage.map(hooks.at));
    const pageMin = Math.min(...currentPage.map(hooks.at));
    if (source.cursor === null) {
      backfillBefore = pageMin;
    } else if (currentRaw === pageSize) {
      gapFloor = Math.min(gapFloor ?? source.cursor, source.cursor);
      gapBefore = Math.max(gapBefore ?? pageMin, pageMin);
    }
  }

  const gapActive =
    gapBefore !== null && gapFloor !== null && gapBefore > gapFloor;
  const budget = pageSize - currentPage.length;
  const walkBound = gapActive
    ? gapBefore
    : backfillBefore !== null && backfillBefore >= 0
      ? backfillBefore
      : null;
  const backfillRows = walkBound !== null ? await backfillRowsUsed(env) : 0;
  const walkCapped =
    walkBound !== null &&
    (backfillRows >= maxBackfillRowsPerDay ||
      (hooks.walkCapped !== undefined && (await hooks.walkCapped())));
  let walkPage: T[] | null = null;
  let walkRaw = 0;
  if (waitUntil === 0 && budget > 0 && walkBound !== null && !walkCapped) {
    if (hooks.waitBetweenPages)
      await new Promise((resolve) =>
        setTimeout(resolve, hooks.waitBetweenPages),
      );
    const walk = await hooks.walk(walkBound, budget);
    walkRaw = walk.rawCount;
    walkPage = walk.plays;
    waitUntil = walk.wait ?? 0;
  }

  let walkRows = 0;
  if (walkPage !== null) {
    if (walkPage.length > 0) {
      const walkResult = await hooks.store(walkPage);
      inserted += walkResult.inserted;
      walkRows = walkResult.rowsWritten;
    }
    const pageMin =
      walkPage.length === 0 ? null : Math.min(...walkPage.map(hooks.at));
    const walkFull = walkRaw === budget;
    if (gapActive) {
      if (!walkFull || (pageMin !== null && pageMin <= (gapFloor ?? 0))) {
        gapBefore = null;
        gapFloor = null;
      } else if (pageMin !== null) {
        gapBefore = pageMin;
      }
    } else {
      backfillBefore = walkFull ? (pageMin ?? backfillBefore) : null;
    }
  }

  if (gapBefore !== null && gapFloor !== null && gapBefore <= gapFloor) {
    gapBefore = null;
    gapFloor = null;
  }
  const frontierLeft = gapBefore !== null || backfillBefore !== null;
  const moreToPull =
    currentRaw === pageSize ||
    (!walkCapped && walkPage !== null && walkRaw === budget && frontierLeft);
  const idlePulls =
    inserted > 0
      ? 0
      : waitUntil > 0 || moreToPull
        ? source.idle_pulls
        : source.idle_pulls + 1;
  const delay =
    waitUntil > 0
      ? waitUntil
      : moreToPull
        ? nextTickDelay
        : nextPullDelay(inserted, idlePulls);
  if (walkRows > 0) await recordBackfillRows(env, backfillRows + walkRows, now);
  await env.DB.prepare(
    `UPDATE sources SET cursor = ?1, backfill_before = ?2, gap_before = ?8,
       gap_floor = ?9, idle_pulls = ?3,
       next_pull_at = ?4, status = 'active', error = NULL, last_ok_at = ?5,
       play_count = play_count + ?6 WHERE id = ?7`,
  )
    .bind(
      cursor,
      backfillBefore,
      idlePulls,
      now + delay,
      now,
      inserted,
      source.id,
      gapBefore,
      gapFloor,
    )
    .run();
  return { inserted, cursor, backfillBefore };
}
