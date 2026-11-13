# music-stats-bench

A Worker that splits one ListenBrainz pull into its stages, one route per stage,
so `wrangler tail` shows the `cpuTime` of a single stage on the deployed
platform. It deploys to workers.dev only and binds the same D1 database and KV
namespace as `web/wrangler.jsonc`.

## Deploy

```sh
cd web/bench
npx wrangler deploy
```

The deploy prints the workers.dev URL, used below as `$BENCH`.

## Run

Start a tail in a second terminal, then run each route at `?repeat=1`,
`?repeat=2` and `?repeat=5`. `repeat` runs the stage that many times inside one
request, so repeat=2 minus repeat=1 is the per-run cost with repeat=1 holding
the first-call cost (lazy compilation, first D1 round trip of the isolate).

Runs of `/store`, `/pull` and `/pull-live` shift `listened_at` back by a day per
run index, so every repeat stores 200 new plays instead of hitting the duplicate
path; repeat=2 minus repeat=1 measures the same insert work, plus the first-call
cost on run 0. The catalogue is shared, so the first run after a fresh deploy
also creates the page's tracks and aliases while later runs resolve them;
`/reset` clears the bench's plays but not the catalogue.

```sh
npx wrangler tail --format json
```

```sh
curl "$BENCH/reset"
for route in "" json parse resolve store pull pull-live; do
  for n in 1 2 5; do
    curl -s "$BENCH/$route?repeat=$n"
  done
done
```

In the tail output each event carries `event.request.url`, `cpuTimeMs` and
`wallTimeMs`. `cpuTimeMs` is the billed CPU; match it to a request by the URL.
Run `/reset` again after the sweep to remove the bench rows.

The `ms` array each route returns is a helper, not the measure. A deployed
Worker advances timers across I/O, not during synchronous execution, so the
per-run `ms` undercounts the purely synchronous stages. `cpuTimeMs` from the
tail is the figure to compare across routes.

| Route             | Stage measured                                     | Local    | Deployed `cpuTime` |
| ----------------- | -------------------------------------------------- | -------- | ------------------ |
| `/`               | Empty handler                                      | 8 ms     | 0 ms               |
| `/json`           | `JSON.parse` of the 200-listen body                | 0.2 ms   | 0-7 ms             |
| `/parse`          | `v.safeParse` with the ListenBrainz schema         | 0.3 ms   | 3-6 ms             |
| `/parse-lastfm`   | `v.safeParse` with the Last.fm schema              | ~1 ms    | -                  |
| `/resolve`        | `resolvePageTracks` on the page                    | 0.6 ms   | 6-12 ms            |
| `/resolve-lastfm` | `resolvePageTracks` on the Last.fm page            | ~1 ms    | -                  |
| `/store`          | `storeListensPage`, including the D1 batch         | 5-15 ms  | 6-17 ms            |
| `/lastfm-store`   | `storeTracksPage`, including the D1 batch          | 8-12 ms  | -                  |
| `/pull`           | `pullListenBrainz` with a fixture fetcher          | 10-30 ms | 5-17 ms            |
| `/pull-live`      | `pullListenBrainz` with real `fetch` of user `rob` | 1.9 s    | 4-28 ms            |
| `/lastfm`         | `pullLastFm` with a fixture fetcher                | 8-12 ms  | -                  |
| `/dups-seed`      | Seeds the `_dups` user, two sources and 400 plays  | -        | -                  |
| `/dups-reset`     | Clears `dup` on the last 200 loser plays           | -        | -                  |
| `/dups`           | `markDuplicates` over the last 200 loser plays     | -        | 7-12 ms            |
| `/dups-delete`    | Deletes the `_dups` user's rows                    | -        | -                  |
| `/reset`          | Deletes the bench user's rows                      | -        | -                  |

The page is the first 200 listens of `web/test/fixtures/listens-rob.json`, the
same recording `web/test/bench.test.ts` uses. The Last.fm local figures come
from the same bench (`PULL_BENCH=1 npx vitest run bench`): about 1 ms of
JavaScript per stage and 8 to 12 ms through local D1 for the pull and store.
Local figures are medians on this host: `/json`, `/parse` and `/resolve`
measured in Bun; `/store`, `/pull` and `/pull-live` measured through
`wrangler dev`, so they hold local D1 and network wall time the deployed
`cpuTime` counts differently. `/` is the whole request's local wall time.

The deployed column is the `cpuTimeMs` range tailed on 2026-11-12 across
repeat=1, 2 and 5, plus a warm-isolate pass at repeat=1 (`/pull` 7-13,
`/pull-live` 4-11, `/json` 0-1). It runs 5 to 10 times the local figure on the
same stage. The fetch and the JSON parse are not the cost: track resolution, the
D1 batch and its result decoding are, and a cold isolate adds more on top.

The `/dups` routes measure `markDuplicates`, the mark a pull runs over the span
its page touches. `/dups-seed?kind=lastfm` or `?kind=ytmusic` creates a `_dups`
user (id -3) with a ListenBrainz anchor source (id -3) and a loser source of the
named kind (id -4), then writes 200 plays to each: a `lastfm` seed puts each
loser play five seconds after its anchor pair, a `ytmusic` seed puts it at noon
of the anchor's day. 200 is the depth the mark reads: the range lookup takes the
last 200 loser plays and the span extension reaches only the window around them,
so a larger seed adds writes without changing the span, the pairs or the 200
marks. `/dups-reset` clears `dup` on the last 200 loser plays so `/dups` can run
again, and `/dups-delete` removes the user's rows, which a seed does not:
deleting them is what lets a second kind run inside the day's write limit. A run
is `/dups-seed`, then `/dups` (with `/dups-reset` before each repeat), then
`/dups-delete`.

Deployed on 2026-11-13, three `/dups` runs at `kind=lastfm` each marked 200
plays and wrote 1,200 rows, at 7, 12 and 7 ms `cpuTime` and 816 to 955 ms of
wall time; D1's per-query analytics counted about 620 rows read a run for the
span statement. That run's seed, 5,000 plays a source, wrote about 55,000 rows,
over half the Free plan's 100,000 rows a day. The resized seed writes an
estimated 2,800 rows: 400 plays at the 7 rows a play of
[docs/web-app.md](../../docs/web-app.md) for a known track, plus the shared
`dartist` and `dtrack` catalogue rows on the first seed. The `ytmusic` case is
not yet measured.

## What the bench writes

The bench runs as its own user (`id` -1, name `_bench`, which no GitHub login
can take) with a ListenBrainz source (`id` -1, account `rob`) and a Last.fm
source (`id` -2, account `fixture`). The Last.fm page is the 200 dated tracks of
`web/test/fixtures/recenttracks.ts`; its pull routes pass a placeholder API key
because the fixture fetcher never reaches Last.fm. The store and pull routes
create those rows when missing (one `INSERT OR IGNORE` batch), and the pull
routes then park the source (`UPDATE sources SET next_pull_at = NULL`) once the
runs finish: a pull writes `next_pull_at`, and a due bench source would be
pulled live by the production cron until the next `/reset`. Each is one constant
D1 statement inside those routes' `cpuTime`. `/reset` deletes its `plays`, the
totals-table rows, `tokens`, `sessions`, `sources` and `users` rows, and nothing
else. The shared catalogue (`artists`, `tracks`, `track_aliases`) is not reset:
the pull fills it with `INSERT OR IGNORE`, the same rows a real pull of the same
listens writes. The bench never reads or writes any other user's rows.
