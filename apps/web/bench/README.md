# Bench worker

A Worker that splits one Spotify pull into its stages, one route per stage, and
times each run. It shares the main Worker's D1 database and KV namespace but
keeps its own name (`music-stats-bench`) so `wrangler dev` and deploys stay
separate. Every seeded row belongs to a `_bench` or `_dups` user, and `/pull`
parks its source (`next_pull_at = NULL`) so the cron never picks it up.

Run it locally:

```sh
cd apps/web/bench
npx wrangler dev
```

It needs `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and
`SOURCE_ENCRYPTION_KEY` from `apps/web/.dev.vars` (wrangler reads `../.dev.vars`
or the local `.dev.vars`).

The routes:

| Route          | What it measures                                   |
| -------------- | -------------------------------------------------- |
| `/`            | Empty handler, the floor for a request             |
| `/json`        | `JSON.parse` of the recorded page                  |
| `/parse`       | `v.safeParse` with the recently-played schema      |
| `/resolve`     | `resolvePageTracks` on the page's inputs           |
| `/store`       | `storeListens`, each repeat on plays shifted a day |
| `/pull`        | `pullSpotify` with a fixture fetcher               |
| `/reset`       | Delete every `_bench` row                          |
| `/dups-seed`   | Seed 200 plays × 2 sources for the duplicate bench |
| `/dups-reset`  | Set `dup = 0` on the 200 newest plays              |
| `/dups`        | `markDuplicates` over the 200 newest plays         |
| `/dups-delete` | Delete every `_dups` row                           |

All routes take `?repeat=N` (1-20, default 1) and answer JSON
`{"route": …, "repeat": …, "ms": […]}` with one timing per repeat. `/resolve`,
`/store` and `/pull` also take `?n=` for the page size (1-1000, default the
fixture's 150; sizes over 150 repeat the fixture shifted into the past).

The pull routes use the fixture fetcher in `index.ts`, so no request reaches
Spotify. `/pull` covers the token refresh path, the page fetch, the store and
the duplicate mark in one call; the stage routes isolate the JSON parse, the
schema parse, the track resolution and the store.

`/dups-seed?kind=` seeds the losing source as `ytmusic` (pairs by day) or
`lastfm` (pairs by the ten-minute window). `/dups` re-runs the mark on the same
span, so a second call shows the cost of a no-op mark.

The duplicate mark runs inside `/store` and `/pull` too, so their timings
include it.
