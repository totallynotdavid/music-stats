import * as v from "valibot";
import type { Listen, ListenFetcher } from "../src/listenbrainz";
import {
  listenBrainzFetcher,
  listenInputs,
  pullListenBrainz,
  ResponseSchema,
  storeListensPage,
} from "../src/listenbrainz";
import { resolvePageTracks } from "../src/matching";
import type { Env, SourceRow } from "../src/types";
import fixture from "../test/fixtures/listens-rob.json";

const page = { payload: { listens: fixture.payload.listens.slice(0, 200) } };
const pageText = JSON.stringify(page);
const pageListens = page.payload.listens as Listen[];

const benchUserId = -1;
const benchSourceId = -1;

const benchSource: SourceRow = {
  id: benchSourceId,
  user_id: benchUserId,
  kind: "listenbrainz",
  account: "rob",
  cursor: null,
  backfill_before: null,
  gap_before: null,
  gap_floor: null,
  next_pull_at: null,
  idle_pulls: 0,
};

async function ensureBench(db: D1Database) {
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO users (id, github_id, name, created_at)
         VALUES (?1, ?2, '_bench', ?3)`,
      )
      .bind(benchUserId, benchUserId, Math.floor(Date.now() / 1000)),
    db
      .prepare(
        `INSERT OR IGNORE INTO sources (id, user_id, kind, account)
         VALUES (?1, ?2, 'listenbrainz', 'rob')`,
      )
      .bind(benchSourceId, benchUserId),
  ]);
}

async function parkBenchSource(db: D1Database) {
  await db
    .prepare("UPDATE sources SET next_pull_at = NULL WHERE id = ?1")
    .bind(benchSourceId)
    .run();
}

async function reset(db: D1Database) {
  await db.batch([
    db.prepare("DELETE FROM plays WHERE user_id = ?1").bind(benchUserId),
    db.prepare("DELETE FROM track_totals WHERE user_id = ?1").bind(benchUserId),
    db.prepare("DELETE FROM daily_totals WHERE user_id = ?1").bind(benchUserId),
    db
      .prepare("DELETE FROM artist_totals WHERE user_id = ?1")
      .bind(benchUserId),
    db.prepare("DELETE FROM tokens WHERE source_id = ?1").bind(benchSourceId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(benchUserId),
    db.prepare("DELETE FROM sources WHERE user_id = ?1").bind(benchUserId),
    db.prepare("DELETE FROM users WHERE id = ?1").bind(benchUserId),
  ]);
}

const shiftListens = (listens: Listen[], run: number): Listen[] =>
  listens.map((listen) => ({
    ...listen,
    listened_at: listen.listened_at - run * 86_400,
  }));

const shiftedFetcher =
  (base: ListenFetcher, run: number): ListenFetcher =>
  async (url) => {
    const result = await base(url);
    if (run === 0) return result;
    const body = result.body as
      | { payload?: { listens?: Listen[] } }
      | undefined;
    if (body?.payload?.listens) {
      body.payload.listens = shiftListens(body.payload.listens, run);
    }
    return result;
  };

const fixtureFetcher =
  (run: number): ListenFetcher =>
  async (url) => {
    const params = new URL(url).searchParams;
    if (params.has("max_ts")) {
      return { status: 200, body: { payload: { listens: [] } } };
    }
    const count = Number(params.get("count")) || pageListens.length;
    return {
      status: 200,
      body: {
        payload: { listens: shiftListens(pageListens.slice(0, count), run) },
      },
      remaining: 29,
      resetIn: 30,
    };
  };

async function run(
  stage: (run: number) => unknown | Promise<unknown>,
  repeat: number,
) {
  const runs: number[] = [];
  for (let i = 0; i < repeat; i += 1) {
    const start = performance.now();
    await stage(i);
    runs.push(Math.round((performance.now() - start) * 100) / 100);
  }
  return runs;
}

function repeatOf(url: URL) {
  const n = Number(url.searchParams.get("repeat") ?? "1");
  return Math.min(Math.max(Math.floor(n) || 1, 1), 20);
}

function report(route: string, runs: number[]) {
  return Response.json({ route, repeat: runs.length, ms: runs });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const repeat = repeatOf(url);
    switch (url.pathname) {
      case "/":
        return new Response("ok\n");
      case "/json":
        return report("/json", await run(() => JSON.parse(pageText), repeat));
      case "/parse":
        return report(
          "/parse",
          await run(() => v.safeParse(ResponseSchema, page), repeat),
        );
      case "/resolve": {
        const inputs = listenInputs(pageListens, benchUserId, benchSourceId);
        return report(
          "/resolve",
          await run(() => resolvePageTracks(inputs, new Map(), []), repeat),
        );
      }
      case "/store":
        await ensureBench(env.DB);
        return report(
          "/store",
          await run(
            (run) =>
              storeListensPage(
                env.DB,
                benchSource,
                shiftListens(pageListens, run),
              ),
            repeat,
          ),
        );
      case "/pull":
        await ensureBench(env.DB);
        try {
          return report(
            "/pull",
            await run(
              (run) =>
                pullListenBrainz(env, { ...benchSource }, fixtureFetcher(run)),
              repeat,
            ),
          );
        } finally {
          await parkBenchSource(env.DB);
        }
      case "/pull-live":
        await ensureBench(env.DB);
        try {
          return report(
            "/pull-live",
            await run(
              (run) =>
                pullListenBrainz(
                  env,
                  { ...benchSource },
                  shiftedFetcher(listenBrainzFetcher, run),
                ),
              repeat,
            ),
          );
        } finally {
          await parkBenchSource(env.DB);
        }
      case "/reset":
        await reset(env.DB);
        return new Response("reset\n");
      default:
        return new Response("not found\n", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
