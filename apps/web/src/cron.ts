import {
  dailyLimitPattern,
  maxSourcesPerPull,
  nextPullDelay,
  nextUtcMidnight,
} from "./pull";
import { pullSpotify } from "./spotify";
import type { Env, SourceRow } from "./types";

const d1CapKey = "d1-capped";

const pulls: Record<
  string,
  (env: Env, source: SourceRow, now: number) => Promise<unknown>
> = {
  spotify: (env, source, now) => pullSpotify(env, source, undefined, now),
};

export async function pullDueSources(
  env: Env,
  now = Math.floor(Date.now() / 1000),
) {
  if (await env.CACHE?.get(d1CapKey)) return;
  let result;
  try {
    result = await env.DB.prepare(
      `SELECT id, user_id, kind, account, secret, cursor, backfill_before,
       gap_before, gap_floor, next_pull_at, idle_pulls
       FROM sources WHERE next_pull_at IS NOT NULL AND next_pull_at <= ?1
       AND kind = 'spotify'
       ORDER BY next_pull_at, id LIMIT ${maxSourcesPerPull}`,
    )
      .bind(now)
      .all<SourceRow>();
  } catch (error) {
    if (error instanceof Error && dailyLimitPattern.test(error.message)) {
      if (env.CACHE)
        await env.CACHE.put(d1CapKey, "1", {
          expiration: nextUtcMidnight(now),
        });
      return;
    }
    throw error;
  }
  for (const source of result.results) {
    const pull = pulls[source.kind];
    if (!pull) continue;
    try {
      await pull(env, source, now);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 200)
          : "Source pull failed";
      if (dailyLimitPattern.test(message)) {
        if (env.CACHE)
          await env.CACHE.put(d1CapKey, "1", {
            expiration: nextUtcMidnight(now),
          });
        return;
      }
      await env.DB.prepare(
        "UPDATE sources SET status = 'error', error = ?1, idle_pulls = idle_pulls + 1, next_pull_at = ?2 WHERE id = ?3",
      )
        .bind(message, now + nextPullDelay(0, source.idle_pulls + 1), source.id)
        .run();
    }
  }
}
