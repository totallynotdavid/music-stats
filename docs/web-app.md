# Web app

This document is the design of the hosted music-stats service. Nothing in it is
built yet. The command-line program that [Architecture](architecture.md)
describes stays as it is, except where [the crate section](#the-rust-crate) says
otherwise.

The service gives each person a public listening profile at `/u/NAME`, a JSON
API at `/u/NAME.json` and an SVG card at `/u/NAME.svg` for a README, each with a
weekly, a monthly and an all-time view. Its value is history. The YouTube Music
history page holds about 200 plays and Spotify's recently-played endpoint holds
50, so the service stores every play it sees and the history grows with time.

```text
Last.fm, ListenBrainz, Spotify ── Cron Trigger pulls ──┐
                                                        ▼
YouTube Music ── user's GitHub Action ── POST ──▶ Worker ──▶ D1 (plays)
                                                   │          KV (snapshots)
                                                   ▼
                         /u/NAME    /u/NAME.json    /u/NAME.svg
```

The site lives at `https://music.rising.sh`. A subdomain of the `rising.sh` zone
fits the other projects on that zone, and a Worker
[custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
creates the DNS record and the certificate itself. Nothing speaks against it:
the session cookie is a `__Host-` cookie, which browsers keep to one host, so no
sibling subdomain can read it. The user-made SVG and JSON share the origin with
the dashboard, so they carry the headers in [Public surface](#public-surface).

## 1. Layout and languages

One repository, no Cargo workspace. The crate stays at the root, because
`cargo install music-stats` and the `include` list in
[`Cargo.toml`](../Cargo.toml) expect it there. That list names `src/**`,
`Cargo.toml`, `readme.md` and `LICENSE`, so a new `web/` directory never enters
the published crate.

```text
Cargo.toml, src/        the Rust crate (unchanged location)
web/
  wrangler.jsonc        Worker, D1, KV, cron, custom domain, assets
  migrations/           D1 migrations, applied with wrangler
  public/               static files: CSS, favicon
  src/                  the Worker, in TypeScript
  test/                 vitest tests that run in workerd
```

The Worker is TypeScript, for these reasons:

- The Worker shares no code with the crate. The crate parses the YouTube page,
  and the Worker never sees that page or the cookie. The things the Worker owns,
  such as matching and aggregation, exist nowhere in the crate.
- workers-rs adds a wasm build step and a second toolchain to every Worker
  change. TypeScript runs on the platform's own runtime.
- The Worker renders the pages too, so one language covers routing, SQL and
  HTML.

The frontend is the Worker. The profile page is public and has to carry link
preview tags, so the Worker renders it as HTML on the server, with the charts as
inline SVG. The sign-in and settings pages are server-rendered forms. The pages
need no client script, and the static files in `web/public/` are served by the
Worker's `assets` binding. Cloudflare documents this route in its
[migration guide](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
and says Workers offer a broader set of features than Pages. It replaces a
separate Pages project. One deploy then covers the API and the pages, and no
request crosses an origin, so there is no CORS to configure for the dashboard.
The static asset requests are free on Workers, as on Pages.

Libraries: [Hono](https://hono.dev) for routing and its JSX for server HTML,
valibot to validate the upload body, vitest with
`@cloudflare/vitest-pool-workers` so the tests run against real workerd and D1.
Formatting and linting follow the repository: oxfmt and oxlint.

## 2. Data model

All times are Unix seconds in UTC. The schema is one migration. A table holds
only what a query reads.

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  hash BLOB PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL
    CHECK (kind IN ('lastfm', 'listenbrainz', 'spotify', 'ytmusic')),
  account TEXT,
  secret BLOB,
  cursor INTEGER,
  backfill_before INTEGER,
  next_pull_at INTEGER,
  idle_pulls INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'gap', 'error')),
  error TEXT,
  last_ok_at INTEGER,
  last_page TEXT,
  play_seq INTEGER NOT NULL DEFAULT 0,
  gap_at INTEGER,
  maybe_missing INTEGER NOT NULL DEFAULT 0,
  play_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, kind)
);
CREATE INDEX sources_due ON sources (next_pull_at)
  WHERE next_pull_at IS NOT NULL;

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources (id),
  hash BLOB NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX tokens_source ON tokens (source_id);

CREATE TABLE artists (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mbid TEXT
);

CREATE TABLE tracks (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  artist_id INTEGER NOT NULL REFERENCES artists (id),
  title TEXT NOT NULL,
  mbid TEXT,
  isrc TEXT
);
CREATE INDEX tracks_mbid ON tracks (mbid) WHERE mbid IS NOT NULL;
CREATE INDEX tracks_isrc ON tracks (isrc) WHERE isrc IS NOT NULL;

CREATE TABLE track_aliases (
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  track_id INTEGER NOT NULL REFERENCES tracks (id),
  PRIMARY KEY (kind, source_key)
) WITHOUT ROWID;

CREATE TABLE plays (
  user_id INTEGER NOT NULL REFERENCES users (id),
  played_at INTEGER NOT NULL,
  source_id INTEGER NOT NULL REFERENCES sources (id),
  ref TEXT NOT NULL DEFAULT '',
  track_id INTEGER NOT NULL REFERENCES tracks (id),
  dup INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, played_at, source_id, ref)
) WITHOUT ROWID;

CREATE TABLE track_totals (
  user_id INTEGER NOT NULL REFERENCES users (id),
  track_id INTEGER NOT NULL REFERENCES tracks (id),
  plays INTEGER NOT NULL,
  last_played_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
) WITHOUT ROWID;
CREATE INDEX track_totals_top ON track_totals (user_id, plays DESC);

CREATE TRIGGER plays_counted AFTER INSERT ON plays WHEN NEW.dup = 0
BEGIN
  INSERT INTO track_totals (user_id, track_id, plays, last_played_at)
  VALUES (NEW.user_id, NEW.track_id, 1, NEW.played_at)
  ON CONFLICT (user_id, track_id) DO UPDATE SET
    plays = plays + 1,
    last_played_at = max(last_played_at, NEW.played_at);
END;

CREATE TRIGGER plays_uncounted AFTER UPDATE OF dup ON plays
WHEN OLD.dup = 0 AND NEW.dup = 1
BEGIN
  UPDATE track_totals SET plays = plays - 1
  WHERE user_id = NEW.user_id AND track_id = NEW.track_id;
  DELETE FROM track_totals
  WHERE user_id = NEW.user_id AND track_id = NEW.track_id AND plays = 0;
END;
```

What each part decides:

- **`users`.** The key is GitHub's numeric id, because a login can change.
  `name` is the URL slug. It starts as the GitHub login, lowercase, and the user
  may change it. A name has 1 to 39 characters from `a-z`, `0-9` and `-`, with
  no hyphen at either end, and a reserved list (`api`, `auth`, `settings`, `u`)
  stays unavailable. A name has no dot, so `/u/NAME.json` and `/u/NAME.svg`
  parse at the last dot without doubt. `AUTOINCREMENT` stops an id from coming
  back after a deletion, so a cached snapshot never reaches a new account.
- **`sources`.** A user has at most one source of each kind. `account` is the
  Last.fm or ListenBrainz username, or the Spotify user id, and is null for
  YouTube Music. `secret` holds the Spotify refresh token, encrypted with
  AES-GCM under a Worker secret, so a leaked database dump holds no usable
  credential. `cursor` is the newest play ingested, and `backfill_before` the
  oldest, until the history import ends. `next_pull_at` is null for YouTube
  Music, which pushes. `idle_pulls` drives the back-off in
  [Pulled sources](#pulled-sources). Three columns serve YouTube Music only.
  `last_page` is the ordered list of `[day, video id]` pairs of the last
  accepted upload, as JSON, and `play_seq` counts the plays stored so far.
  `gap_at` is the time of the last upload that overlapped nothing, and
  `status = 'gap'` marks the source until an upload overlaps again.
  `maybe_missing` is the most plays that repeated songs may have hidden so far.
  Only an upload that changes the page adds to it, and a replay of the stored
  page never does ([Aligning a page](#aligning-a-page-with-the-last-one)).
- **`tokens`.** An upload token belongs to a YouTube Music source. The database
  keeps the SHA-256 of the token, never the token. A 256-bit random value needs
  no slow hash. `hint` is the last four characters, so the dashboard can tell
  two tokens apart.
- **`tracks` and `artists`.** One catalogue shared by all users. It holds no
  personal data, so deleting an account leaves it alone.
  [Song matching](#4-song-matching) says how a row is found.
- **`track_aliases`.** The first time a source's own identity of a track is
  resolved, the answer is pinned here. A later change to the matching rules
  never moves old plays.
- **`plays`.** One row per play and per source. Its primary key is the identity
  of the play, so a repeat is rejected by the database and no code has to
  remember. `WITHOUT ROWID` makes the key the table itself: the same b-tree
  serves the uniqueness check and the range scans by time, and a play costs one
  row written. `dup` is 1 when another source holds the same play
  ([Cross-source duplicates](#cross-source-duplicates)).
- **`track_totals`.** The all-time count of each track per user, kept by the two
  triggers, so the database enforces the invariant
  `plays = count of rows with dup = 0`. The all-time view reads the first rows
  of the `track_totals_top` index. A function that recounts from `plays` repairs
  the table if it drifts; the nightly cron checks a sample of users.

### How a play stays unique

The primary key is `(user_id, played_at, source_id, ref)`, written with
`INSERT OR IGNORE`.

- **Last.fm, ListenBrainz and Spotify** give each play a timestamp that is the
  same every time the API returns it. `ref` is empty. One source cannot record
  two plays in the same second. The track is not in the key on purpose: Last.fm
  corrects titles after the fact, and a corrected title on a later pull must not
  become a second play. The first title seen wins.
- **YouTube Music** gives a day and no time, and nothing that names one play.
  The crate sends `day` only for plays under a heading that names a day. The
  service stores the play at 12:00 UTC of that day, as the crate already does,
  and sets `ref` to `<video id>#<seq>`, where `seq` comes from
  `sources.play_seq`, a counter that only grows. The key is unique by
  construction, so it cannot reject a replay. The service decides which plays of
  an upload are new by aligning the page with the last accepted page
  ([Aligning a page](#aligning-a-page-with-the-last-one)), and a guard on
  `play_seq` makes a replayed request insert nothing.

The triggers fire only for a row that is really inserted. A conflict under
`INSERT OR IGNORE` fires nothing, so a replayed play changes no total. The
schema above was run against SQLite 3.53 and against wrangler 4.160.1's local D1
with this sequence: two inserts of one key, then a new key, and the total
read 2. D1 itself must be checked at the first milestone.

## 3. Upload API

Only YouTube Music uses it. The other sources are pulled.

```http
POST /api/v1/upload
Authorization: Bearer msu_<43 characters>
Content-Type: application/json

{
  "client": "music-stats/0.4.0",
  "plays": [
    {"day": "2026-11-11", "artist": "Radiohead",
     "title": "Weird Fishes/ Arpeggi", "video_id": "rSvTmvpx0JI"}
  ]
}
```

```json
{
  "received": 200,
  "inserted": 3,
  "duplicate": 197,
  "gap": false,
  "ambiguous": 0
}
```

- **Token.** `msu_` plus 32 random bytes in base64url. The dashboard shows it
  once, when the user creates it. The Worker hashes the header value and looks
  the hash up in `tokens`. A revoked or unknown token gets `401`. A token
  reaches one source of one user and nothing else. The user can create a new
  token and revoke the old one on the settings page. This is the same shape as
  ListenBrainz, where a user token goes in the `Authorization` header
  ([API](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html)).
- **Order.** `plays` lists the page as the crate read it, newest first, and the
  order is part of the contract: the Worker reads it to tell new plays from old
  ones. An empty `plays` changes nothing and gets `200`.
- **Fields.** `day` is a `YYYY-MM-DD` date between 2005-01-01 and tomorrow in
  UTC. `artist` and `title` hold 1 to 512 characters. `video_id` is 1 to 32
  characters from `A-Za-z0-9_-`. Unknown fields are rejected, so a typo does not
  pass silently.
- **Limits.** The body is at most 256 KiB, `plays` at most 1,000 items, and the
  `Content-Type` must be `application/json`. The Worker refuses
  `Content-Encoding`, because decompression costs CPU time that the Free plan
  does not have. ListenBrainz sets the same count (1,000 listens per request).
  The page holds about 200 plays, so a normal body is under 40 KiB. The crate
  sends the newest 1,000 plays of a longer page in one request. Several requests
  would read as several unrelated pages, and the older ones would count again.
- **Rate.** One upload per source every 30 seconds. The Worker reads
  `sources.last_ok_at` while it authenticates, so the check costs no extra
  query. A faster request gets `429` with `Retry-After`.
- **Atomic.** A body that fails validation gets `422` with the failing item
  indexes and nothing is stored. A valid body is written in one `db.batch()`,
  which D1 runs as a transaction, so a request lands whole or not at all.
- **Statuses.** `200` for success, even when `inserted` is 0. `401`, `409` (two
  uploads raced, send again), `413`, `415`, `422` and `429` as above. No other
  code is returned for client mistakes.

### Replaying the overlap

The crate keeps no state between runs, because a GitHub runner starts empty.
Each run sends the whole page it reads, and the window overlaps the previous
upload by design. The service owns the cure, and it cannot be a unique key: the
history page names no play, and two plays of one video on one day look the same.
A key built from day, video and a count from the oldest play fails when the
page's oldest plays fall off. Three plays of a song, then a page holding the
last two of them and a new one, would number the new play with a key that
exists. The service instead keeps the last page and aligns the next one with it.
ListenBrainz keeps a server-side cursor (`latest-import`) for its importers for
the same reason: the server, not the client, remembers where the last import
ended.

#### Aligning a page with the last one

`P` is `sources.last_page`, the `(day, video id)` pairs of the last accepted
upload, newest first. `N` is the new upload, with the same order. A page grows
at its head and loses plays at its tail, so `N` should begin with new plays and
continue with the head of `P`.

1. **Replay.** `N` equals `P` exactly, pair for pair. The upload is a replay of
   the last one, for example a re-run of the Action before a new play. The
   service stores nothing, answers `inserted` 0 and `ambiguous` 0, and leaves
   `maybe_missing`, `status`, `last_page` and `play_seq` as they are. The check
   compares the stored `last_page` text with the canonical JSON of `N`. It keeps
   no hash, because the page is already in the row the token check reads. Only
   an upload that changes the page goes on to the steps below.
2. **First upload.** `P` is null. Every play of `N` is new, and the status stays
   `active`.
3. **List the candidates.** A position `i` in `N` is a candidate when the rest
   of the page, `N[i..]`, equals the first `len(N) - i` pairs of `P` exactly,
   and `len(N) - i` is at most `len(P)` and at least
   `need = min(2, len(P), len(N))`. This is the shape a real change gives: new
   plays at the head, lost plays at the tail, nothing between. A candidate must
   explain the whole page, so a pair that does not fit rules a position out.
4. **Choose the smallest candidate.** The new plays are `N[0..i)`. When more
   than one position is a candidate, the page proves only the smallest count,
   and the others are possible. The service stores the proven plays, never an
   invented one, and writes the difference between the last and the first
   candidate to the response as `ambiguous` and adds it to
   `sources.maybe_missing`. The dashboard shows "up to N plays of repeated songs
   may be missing" while the sum is above 0. A count that is too low is marked,
   and a count that is too high would hide itself, so the rule leans low.
5. **No candidate.** The history was edited, for example a play deleted from the
   middle. For each `i`, let `m(i)` be the number of leading pairs of `P` that
   `N` repeats from `i`. The largest `m`, if it is at least `need`, gives the
   position, and the new plays are `N[0..i)`. Tied positions are treated like
   several candidates: the smallest `i` is chosen and the spread is `ambiguous`.
6. **No run.** The page shares nothing with `P`, or only one pair, which a
   coincidence can explain. The whole of `N` is new, `status` becomes `gap`, and
   `gap_at` records the time. The dashboard says that plays between the last
   upload and this one may be missing, and the next upload with a run sets the
   status back to `active`. A page stored twice in the worst case, when the true
   run was a single pair, is better than a silent hole.
7. **Store.** The new plays get `seq = play_seq + 1` for the oldest, up to
   `play_seq + i` for the newest, each as `<video id>#<seq>` at 12:00 UTC of its
   day. Then `last_page` becomes `N` and `play_seq` grows by the count.

An example, with letters for `(day, video id)` pairs:

| Upload | Page, newest first | Candidates `i` | New | Stored in total |
| ------ | ------------------ | -------------- | --- | --------------- |
| 1      | `c b a`            | first upload   | 3   | 3               |
| 2      | `x c b`            | 1              | 1   | 4               |
| 3      | `x c b`            | a replay       | 0   | 4               |
| 4      | `q r s`            | none, a `gap`  | 3   | 7               |
| 5      | `t q r`            | 1              | 1   | 8               |

Upload 2 is the case a day-and-count key gets wrong: the page lost its oldest
play, `a`, and gained `x`, and the service stores one play. Upload 3 is a replay
and stores none. Upload 4 is a gap.

Repeated plays are the hard case:

| Upload | Page, newest first | Candidates `i` | New | Stored in total | `ambiguous` | `maybe_missing` |
| ------ | ------------------ | -------------- | --- | --------------- | ----------- | --------------- |
| 1      | `A A B`            | first upload   | 3   | 3               | 0           | 0               |
| 2      | `A A A`            | 1              | 1   | 4               | 0           | 0               |
| 3      | `A A A`            | a replay       | 0   | 4               | 0           | 0               |
| 4      | `A A A A`          | 1 and 2        | 1   | 5               | 1           | 1               |

| Upload | Page, newest first | Candidates `i` | New | Stored in total | `ambiguous` |
| ------ | ------------------ | -------------- | --- | --------------- | ----------- |
| 1      | `A A`              | first upload   | 2   | 2               | 0           |
| 2      | `A A A`            | 1              | 1   | 3               | 0           |

Upload 2 has one candidate. Position 0 would need the third `A` to equal `B`,
and it does not, so the page is `A` plus the two newest of the old page. The
service stores the new `A`, and the count is exact. The second table shows a
previous page `A A` followed by `A A A`: one candidate, position 1, because
position 2 is shorter than `need`. Upload 3 equals the stored page, so it is a
replay: nothing is stored and nothing is marked. Upload 4 changes the page and
is the unresolvable one: a page that repeats one pair all the way down reads the
same with one or two new plays of that pair at its head. The service stores the
proven play and marks one play as possibly missing.

The replay step has a price. A page that repeats one pair all the way down looks
the same after a new play of that pair, and the service reads it as a replay, so
that play is missed without a mark. An upload that changes the page still marks
what it cannot settle.

Checked by a throwaway simulation of the rule: 620,164 uploads from random
histories of 2 to 4 distinct pairs and pages of 2 to 8 plays, where the new page
overlapped the old one by at least `need` pairs and no play was deleted. The
rule never stored more plays than were played. It stored fewer in 14,731 of
them. In 10,177 the shortfall was at most the `ambiguous` figure it reported. In
the other 4,554 the new page was identical to the old one, so the rule read a
replay and reported nothing. Every upload that changed the page stayed inside
its reported spread.

A replayed request cannot insert twice. The batch holds the inserts, guarded by
`play_seq = <value the Worker read>`, and then an update of the source with the
same guard. A second request that read the same `play_seq` finds it changed,
inserts nothing, and the Worker answers `409`. Rate limiting makes the race
rare, and the guard makes it harmless.

The cost per upload is one read of `sources` (which the token check already
makes) and one write of it, with `last_page` of about 6 KB for 200 plays. The
alignment is two nested loops over at most 1,000 pairs, a few thousand
comparisons for a normal page. Milestone 5 measures its CPU time at 1,000 pairs.

### What a day means

Google builds the headings in the history page ("Today", "Yesterday") for some
time zone, and the page does not say which. A crate that always used UTC would
show a user whose day ends at another hour a play counted on two days across two
runs: first under "Today", then under "Yesterday". The crate therefore takes a
time zone from the setting `MUSIC_STATS_TZ` (an IANA name, default `UTC`), and
[`youtube_json.rs`](../src/providers/youtube_json.rs) resolves "Today" and
"Yesterday" in it. A wrong boundary also breaks the alignment, because the same
play would carry two days on two uploads. Milestone 5 measures the boundary:
upload hourly for two days and check that no play lands on two days and that no
upload reports a gap. Until that passes, the design treats a one-day error on
YouTube Music plays as possible.

The crate sends only plays that sit under "Today", "Yesterday" or a `YYYY-MM-DD`
heading. The week and month headings cover several days, and the crate gives
those plays an invented date ([Providers](providers.md)). That is good enough
for a top-five list and wrong for a ledger, so they are left out of the upload.
A daily run sees every play under "Today" or "Yesterday" first, so only plays
older than the first upload are lost.

## 4. Song matching

The same song arrives as `Weird Fishes/ Arpeggi` from Last.fm,
`Weird Fishes/ Arpeggi - Remastered` from Spotify, and
`Radiohead - Weird Fishes (Official Video)` from a YouTube music video. The
service needs one `tracks` row for all three.

**Resolution order.** The first hit wins.

1. `track_aliases` for the source's own key: `lastfm:<artist>\t<title>` as the
   API returned it, `spotify:<track id>`, `ytmusic:<video id>`,
   `listenbrainz:<recording mbid, or artist and title>`.
2. A recording MBID, then an ISRC, against `tracks.mbid` and `tracks.isrc`. An
   id match counts only when the artist key or the title key also agrees. Labels
   reuse ISRCs wrongly, and a wrong id must not merge two songs.
3. The normalised key `artist key + U+001F + title key`.
4. Otherwise a new `tracks` row, whose title and artist are the display text of
   the first source that mentioned it. The new alias is stored.

The ids come from the sources that have them. Spotify gives `external_ids.isrc`
([recently played](https://developer.spotify.com/documentation/web-api/reference/get-recently-played)).
ListenBrainz carries `recording_mbid` and `isrc`
([listen format](https://listenbrainz.readthedocs.io/en/latest/users/json.html)).
Last.fm gives an `mbid` field that is empty in most plays; the fixture
[`recent_tracks.json`](../tests/fixtures/recent_tracks.json) shows it empty. The
YouTube history page gives a `videoId` in each play's `watchEndpoint`, and a
`musicVideoType`: `MUSIC_VIDEO_TYPE_ATV` for the audio track and other values
for music videos and user uploads. The crate does not read `videoId` today. The
upload change adds it.

**Normalisation.** Applied to the artist and to the title, to build the key and
never to the display text:

1. Unicode NFKC, then lowercase, then remove combining marks (`Beyoncé` becomes
   `beyonce`), and turn typographic quotes and dashes into ASCII.
2. Remove a trailing or bracketed clause that does not change which recording it
   is: `remaster`, `remastered` with or without a year, `mono`, `stereo`,
   `deluxe edition`, `explicit`, `official video`, `official audio`,
   `lyric video`, `visualizer`, and a `feat.`, `ft.` or `featuring` clause.
3. Remove a ` - Topic` suffix from a YouTube artist.
4. Remove everything that is not a Unicode letter or number, and collapse the
   rest. A result with no characters falls back to the trimmed lowercase text.

A clause that names a different recording stays: `live`, `remix`, `acoustic`,
`demo`, `instrumental`, `cover`, `version`. A live take and the studio take are
two songs for a listener.

**The artist is the first credited one,** as the source states it. A Spotify
credit is an array and the first element is used, as the crate already does for
YouTube Music. The service does not split a string on `&` or `,`, because
`Simon & Garfunkel` is one act.

**No fuzzy matching on text alone.** multi-scrobbler scores titles with
Levenshtein and Dice distances
([duplicates](https://docs.multi-scrobbler.app/configuration/duplicates/)), but
it compares a new play with plays that sit at nearly the same time, so time is a
second witness. Text with no second witness merges wrongly more often than it
fixes anything, and a wrong merge corrupts a count that a split only diffuses. A
user-driven "merge these two tracks" is a possible later feature. It rewrites
`track_aliases` and `plays.track_id` in one batch.

### Cross-source duplicates

A user who connects Last.fm and Spotify holds each Spotify play twice, because
Last.fm scrobbles Spotify. Two plays from different sources are one play when
they have the same `track_id` and their times are close enough. The window
follows multi-scrobbler's observation that some sources stamp the end of a play
and others the start. Here, the window is
`max(track length, 4 minutes) + 30 seconds`, or 10 minutes when the length is
unknown. The match is one to one: each play pairs with the nearest unpaired play
of the other source. A track on repeat therefore pairs play by play and not all
at once. A YouTube Music play, which has a day only, pairs with a play of
another source on the same UTC day.

The play from the source with the richer evidence stays counted: `spotify`, then
`listenbrainz`, then `lastfm`, then `ytmusic`. The loser gets `dup = 1`, and the
`plays_uncounted` trigger fixes the totals. When the better source arrives
later, as in a Last.fm backfill after a Spotify play, the same rule marks the
older row. The code is one function, `markDuplicates`, tested as a table of
cases.

## Pulled sources

A Cron Trigger runs every minute and calls `scheduled()`. It selects the sources
whose `next_pull_at` has passed, oldest first, through `sources_due`, and pulls
them. The batch is small because the Free plan allows 10 ms of CPU, 50
subrequests and 50 D1 queries per invocation
([limits](https://developers.cloudflare.com/workers/platform/limits/)).

- **Last.fm.** `user.getrecenttracks` with `limit=200` and `from=cursor+1`
  ([method](https://www.last.fm/api/show/user.getRecentTracks)). The method
  needs no user authentication, only the service's API key. The first pull
  stores the newest page, sets `cursor` and `backfill_before`, and later pulls
  walk back with `to` until a page is empty. A pull skips the now-playing track,
  which has no date, as the crate does
  ([`lastfm.rs`](../src/providers/lastfm.rs)). The crate waits 200 ms between
  pages. The Worker does the same, because Last.fm sets its own rate limits and
  may change them (clause 4.4 of its terms). The cron pulls it only when
  `LASTFM_APPROVAL` is set.
- **ListenBrainz.** `GET /1/user/NAME/listens` with `min_ts=cursor` and
  `count=1000`, and `max_ts` for the backfill, since one call takes only one of
  the two
  ([API](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html)).
  `listened_at` is the playback start. Milestone 1 confirms that a public user's
  listens need no token.
- **Spotify.** `GET /me/player/recently-played?limit=50&after=cursor` with a
  refresh token. It needs the `user-read-recently-played` scope. The endpoint
  returns at most 50 plays, so a source must be pulled before the user has
  played 50 more tracks. About 3 minutes a track means 2 hours, so the Spotify
  back-off never exceeds 1 hour.
- **Back-off.** A pull that finds plays sets `idle_pulls` to 0 and
  `next_pull_at` to 15 minutes ahead. An empty pull adds 1 to `idle_pulls` and
  sets the delay to `15 minutes × 2^idle_pulls`, with a ceiling of 6 hours (1
  hour for Spotify). Last.fm and ListenBrainz keep the whole history, so waiting
  loses nothing.
- **Failure.** A pull that fails sets `status = 'error'` with a short `error`
  and retries with the same back-off. The dashboard shows the message. A Last.fm
  user who hides recent listening gets an error that says so. An expired or
  revoked Spotify token also shows there.

stats.fm refreshes Spotify about every 100 minutes
([FAQ](https://support.spotistats.app/docs/import/spotify-import)), which is the
same trade of freshness for requests.

### Spotify and the user limit

A new Spotify app starts in development mode. Spotify's pages today say:

- A development-mode app serves at most **5** users, each added by hand in the
  app's dashboard, and the owner must have Premium. Spotify made the change on
  11 February 2026 for new apps and on 9 March for existing ones
  ([migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide),
  [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)).
  The figure of 25 users is the limit before that change. In July 2026 Spotify
  raised the number of client ids per developer account from 1 to 25 and counts
  the quota per developer account
  ([announcement](https://community.spotify.com/t5/Spotify-for-Developers/Web-API-quota-updates-for-Development-Mode/td-p/7508852)).
- Extended quota lifts the limit, but since 15 May 2025 only an organisation can
  ask for it, and the criteria include a registered business, a launched service
  and 250,000 monthly active users. This project meets none of them.

The design assumes extended quota never comes, and copes in three ways.

1. **Spotify is optional.** A person who plays Spotify can connect Last.fm,
   which scrobbles Spotify, or ListenBrainz. That path has no limit and is the
   one the dashboard offers first.
2. **A user brings their own Spotify app.** The user registers an app in their
   own developer account, sets the redirect URI to
   `https://music.rising.sh/auth/spotify/callback`, and pastes the client id
   into the dashboard. The service runs the authorisation code flow with PKCE,
   which needs no client secret, so it stores only the client id. Each user then
   sits in their own app and their own quota, the 5-user cap never applies, and
   the service can host any number of Spotify users. The cost is ten minutes of
   setup and the Premium subscription Spotify requires of app owners.
   multi-scrobbler works the same way: its Spotify source asks the user to
   [create their own app](https://docs.multi-scrobbler.app/configuration/sources/spotify/).
3. **Shared seats.** If the operator registers one shared app, the service uses
   it for up to 5 users, first come, first served, and each user is added in
   Spotify's dashboard by the operator. The service counts the seats and offers
   the bring-your-own route when none is left. The shared app stops working for
   everyone if its owner's Premium subscription lapses, so the dashboard never
   presents it as the default.

Every Spotify request that Spotify answers with `403` or `429` marks the source
`error` and backs off. A `429` with `reason: QUOTA_EXCEEDED` is shown as such.

## 5. Accounts and deletion

**Sign-in is GitHub OAuth,** with a GitHub OAuth App and no scopes. A token with
no scope reads public profile data, which is `id` and `login`
([scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)).
The users of this service are people who run GitHub Actions for YouTube Music,
or who put a card in a README, so they have an account. There is no password, no
email address and no other identity provider to run. GitHub recommends GitHub
Apps over OAuth Apps for integrations. This service only asks who the visitor is
and keeps no token, so the permissions model of a GitHub App buys nothing.

- `/auth/github` sets a random `state` in a cookie and redirects. The callback
  checks it, exchanges the code, reads `GET /user`, stores `github_id` and the
  login, and discards the GitHub token at once.
- The session is a random 32-byte value in a `__Host-session` cookie
  (`HttpOnly`, `Secure`, `SameSite=Lax`, path `/`, 30 days). D1 stores its
  SHA-256 in `sessions`, so the server can end a session. A signed cookie could
  not be revoked.
- A form that changes state is a `POST` and the Worker checks that `Origin`
  equals the site origin. `SameSite=Lax` does the rest. The upload endpoint uses
  a bearer token and no cookie, so it has no CSRF exposure.
- A public source is claimed by name, without proof: Last.fm and ListenBrainz
  data is public, and a squatter exposes only public data on their own page.
  Spotify is proven by the OAuth flow. If squatting turns into abuse, Last.fm's
  own authorisation flow can prove a username.

**Privacy.** A profile is public by default. The settings page has one switch,
`is_public`. A hidden profile answers `404` on all three addresses. The first
sign-in screen states that profiles are public.

**Deleting data.** The settings page has two actions.

- **Remove a source.** One `db.batch()` deletes that source's `plays`, its
  `tokens` and the `sources` row, then recounts `track_totals` for the user. The
  Spotify refresh token goes with the row. The user can also revoke the app in
  their Spotify account.
- **Delete the account.** The user types their name to confirm. One batch
  deletes `plays`, `track_totals`, `tokens`, `sources`, `sessions` and the
  `users` row, in that order, so no foreign key fails. No cascade is declared,
  so D1 never scans a table to find children. Cached snapshots in KV are keyed
  by the user id, which is never reused, and expire within a day.
- D1 Time Travel keeps restore points for 7 days on the Free plan and 30 days on
  Paid ([limits](https://developers.cloudflare.com/d1/platform/limits/)).
  Deleted rows leave the restore points with them. The privacy text says so.
- **Export.** `GET /settings/export` streams the user's plays as NDJSON, one
  play per line, in pages of 5,000 rows by key, so the 50 MB D1 result limit is
  never near.

## Public surface

| Address        | Content                                                     |
| -------------- | ----------------------------------------------------------- |
| `/u/NAME`      | HTML profile. `?period=week` (default), `month`, `all`.     |
| `/u/NAME.json` | The same figures as JSON.                                   |
| `/u/NAME.svg`  | The card. `?period=`, `?n=1..10`, `?theme=light` or `dark`. |

- **Periods.** `week` is the last 7 days, `month` the last 30 days, both
  rolling, and `all` is everything. A calendar week would be empty on Monday
  morning, and the Gist output already uses a rolling window.
- **Figures.** Plays, unique tracks, unique artists, the top tracks, the top
  artists and the plays per day. `week` and `month` read `plays` with the
  primary key prefix `(user_id, played_at >= …)` and group by track. `all` reads
  `track_totals_top` for the top tracks, and groups `track_totals` for artists.
  The plan for the weekly query was checked in SQLite: it searches `plays` by
  the key and groups with one temporary b-tree.
- **JSON.**
  `{"schema": 1, "user": …, "period": …, "from": …, "to": …, "plays": …, "unique_tracks": …, "unique_artists": …, "top_tracks": […], "top_artists": […], "daily": […], "updated_at": …}`.
  It sends `Access-Control-Allow-Origin: *`, because it is public data.
- **Snapshots.** The figures of one user and period are cached in KV under
  `snap:<user id>:<period>`, with a TTL of 15 minutes for `week` and `month` and
  6 hours for `all`. A request that finds no snapshot computes it from D1 and
  stores it. A failed KV write, which happens at the free tier's 1,000 writes a
  day, never fails the request: the page is rendered from the fresh figures. The
  profile, the JSON and the card read the same snapshot, so they agree.
- **Card.** The Worker builds the SVG from the snapshot by string templates. It
  loads no font and no image, since a README viewer would not fetch them: text
  uses the generic `sans-serif` family and the text is cut by display width,
  with East Asian wide characters counting 2, the same rule as
  [Output](output.md). The query values are validated to a fixed set, so the
  number of variants per user is bounded (3 periods × 10 sizes × 2 themes), and
  an unknown value is `400`. Every string from a source is XML-escaped.
- **Last.fm data.** A user with a Last.fm source gets `404` on all three
  addresses until `LASTFM_APPROVAL` is set ([gate](#the-lastfm-launch-gate)).
- **Headers.** The SVG and the JSON carry
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`,
  `X-Content-Type-Options: nosniff` and `Cache-Control: public, max-age=900`.
  The third-party text in them is never trusted.
- **Link preview.** The profile carries `og:title` and `og:image` that points at
  the card.

## 6. Limits and costs

Numbers are from the Cloudflare pages of November 2026. Every row cites its
page:
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[KV limits](https://developers.cloudflare.com/kv/platform/limits/) and
[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/).

| Resource                   | Free                | Paid ($5 a month)                           |
| -------------------------- | ------------------- | ------------------------------------------- |
| Worker requests            | 100,000 a day       | 10 million a month, then $0.30 per million  |
| CPU per HTTP request       | 10 ms               | 30 s default, up to 5 min                   |
| CPU per Cron Trigger       | 10 ms               | 30 s under 1 hour interval                  |
| Subrequests per invocation | 50                  | 10,000                                      |
| Cron Triggers per account  | 5                   | 250                                         |
| D1 queries per invocation  | 50                  | 1,000                                       |
| D1 rows read               | 5 million a day     | 25 billion a month, then $0.001 per million |
| D1 rows written            | 100,000 a day       | 50 million a month, then $1.00 per million  |
| D1 storage                 | 5 GB, 500 MB per DB | 5 GB, then $0.75 per GB-month               |
| KV reads                   | 100,000 a day       | 10 million a month, then $0.50 per million  |
| KV writes                  | 1,000 a day         | 1 million a month, then $5.00 per million   |
| Static asset requests      | free, unlimited     | free, unlimited                             |

A request that exceeds a Free daily limit fails until 00:00 UTC. The Free plan
suits a pilot of a few dozen people. The Paid plan lifts every limit that
follows.

**What a unit of work costs.**

- A new play writes about 3 rows: one in `plays`, and the `track_totals` upsert,
  which D1 bills as two rows because it changes an indexed column
  ([pricing](https://developers.cloudflare.com/d1/platform/pricing/)). A new
  track adds its `tracks`, `track_aliases` and key-index rows, shared by all
  users. A pull with no new plays writes two rows: the `sources` row and its
  `sources_due` index entry. A play row is an estimated 40 bytes, so 500 MB
  holds on the order of ten million plays.
- A profile, JSON or card request with a warm snapshot reads one `users` row and
  one KV key. A cold one reads the rows of the period: about 350 plays for a
  week of a heavy listener, and about 1,500 for a month.
- A pull costs one subrequest to the source and one D1 batch.

**Where the Free plan runs out,** in the order a service of one-user-per-day
growth meets the limits. The figures are estimates for milestone 1 to measure
with `wrangler tail`, which reports CPU time per invocation.

1. **Cron CPU.** A pull that parses 200 plays takes an estimated 1 to 2 ms, so a
   10 ms tick pulls about 5 sources: 7,200 pulls a day. With the back-off, an
   average user needs about 22 pulls a day (a fifth of users active at 96, the
   rest at 4), so the Free plan sustains about **300 users**.
2. **KV writes.** 1,000 snapshot writes a day cap the number of distinct
   profiles that can refresh in a day. A cold snapshot is still served, so the
   cap costs D1 reads, not availability.
3. **D1 writes.** 100,000 rows a day is about 33,000 new plays a day, which is
   1,000 users at 30 plays each, before the pull overhead. A large backfill is
   heavier: 50,000 plays and their new tracks need about 200,000 rows, two days
   on Free. D1 refuses writes past the cap, and the pull sets `next_pull_at` to
   the next 00:00 UTC.
4. **Requests.** 100,000 a day is about one a second on average. A cron tick is
   one request, so ticks use 1,440 of them. Public pages are cheap to serve, but
   every view of a profile or card is a Worker request.

The first upgrade is Workers Paid at $5 a month. It lifts items 1, 2 and 4 and
leaves D1 writes at 50 million rows a month, about 16 million plays.

### The Last.fm launch gate

The [Last.fm API terms](https://www.last.fm/api/tos), read on 2026-11-12, bind
this service in five places:

- Clause 2.7 lets the service give public access only to pages that use
  Last.fm's web services and that Last.fm has approved in writing. Button and
  link placements need approval too.
- Clause 3.1 allows non-commercial use only.
- Clause 4.3.4 sets a "Reasonable Usage Cap" of 100 MB of Last.fm data, and a
  larger store needs prior written consent. 100 MB is about 2.5 million plays at
  40 bytes (estimate).
- Clause 4.2.2 requires credit to Last.fm, with the "powered by AudioScrobbler"
  button of clause 2.7.
- Clause 9.3 requires deletion of the Last.fm data when the licence ends.

The preamble asks for contact at `partners@last.fm` before use. The clause
numbers come from a reading of the page on that date. The operator checks them
against the live text when writing the request.

A public profile therefore shows Last.fm data only after written approval is
recorded. The record is the deploy-time variable `LASTFM_APPROVAL` in
`wrangler.jsonc`. It is empty until approval arrives. It then holds the date and
a short reference to the approval, with no personal data, and the commit that
sets it is the record of when the gate opened. The operator keeps the email.

| State                   | Pulls                                                             | `/u/NAME`, `.json`, `.svg`                                              |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `LASTFM_APPROVAL` empty | The cron skips Last.fm sources, so none of their plays is stored. | `404` for every user who has a Last.fm source, even with other sources. |
| `LASTFM_APPROVAL` set   | Pulls as in [Pulled sources](#pulled-sources).                    | Served. The page carries the button and the links clause 2.7 asks for.  |

While the variable is empty, the settings page shows a Last.fm source as waiting
for approval. Development does not wait: `.dev.vars`, which `wrangler dev` reads
and which is not committed, sets `LASTFM_APPROVAL=local`, and a page that only
the developer's machine serves is not public access. If Last.fm withdraws
approval, the operator empties the variable and deploys. The pages answer `404`
at once, and the operator deletes the Last.fm sources' plays with the
`Remove a source` batch of [section 5](#5-accounts-and-deletion) to meet clause
9.3.

The rest of the design keeps the other terms. The service stays free and
ad-free. `sources.play_count` lets the service stop new Last.fm backfills at 2
million Last.fm plays, until Last.fm agrees in writing to a larger store.
ListenBrainz needs none of this: MetaBrainz publishes ListenBrainz listens under
CC0
([data dumps](https://listenbrainz.readthedocs.io/en/latest/users/listenbrainz-dumps.html)),
and its API asks only for one call a second.

**Decision: the first public milestone launches on ListenBrainz.** The brief
starts with Last.fm. The approval is a third party's answer with no deadline,
and clause 2.7 puts it in front of the first public page. ListenBrainz has no
such step, returns up to 1,000 listens a call with exact timestamps and
MusicBrainz ids, and so needs fewer subrequests for a backfill. Milestone 1
therefore pulls ListenBrainz, and milestone 2 adds Last.fm behind the gate. The
cost is that the first launch reaches ListenBrainz users, a smaller group, and
that the done-check no longer uses a Last.fm history. The operator can send the
Last.fm request the day milestone 1 starts, so that the answer may arrive by
milestone 2.

## 7. Build order

Each milestone ships on its own and ends with a check a person can run.

1. **ListenBrainz, profile, JSON.** `web/` with `wrangler.jsonc`, the migration,
   the custom domain `music.rising.sh` and a deploy workflow. Users are rows
   added with `wrangler d1 execute`, with no sign-in. The cron pulls
   ListenBrainz with backfill. `/u/NAME` and `/u/NAME.json` work for the three
   periods. The milestone writes `docs/web-deploy.md` with every account step,
   secret name and command, and measures CPU per pull and rows written per play
   on real D1. _Done when_ the history of a public ListenBrainz account renders
   and a second pull inserts nothing.
2. **Last.fm behind the gate.** The Last.fm pull and the credit button, with
   `LASTFM_APPROVAL` empty by default ([gate](#the-lastfm-launch-gate)). _Done
   when_ a seeded Last.fm user passes both states in an automated test: with
   `LASTFM_APPROVAL` empty, the three addresses answer `404` and the database
   holds no play of that source; with it set, they are served and carry the
   credit.
3. **Card and cache.** `/u/NAME.svg`, the KV snapshots and the headers. _Done
   when_ a README embeds the card and the CPU of a warm request is under 10 ms.
4. **Sign-in and self-service.** GitHub OAuth, sessions, the settings page where
   a user adds a ListenBrainz or Last.fm source, the name and visibility
   settings, export, and deletion. _Done when_ a new person signs in, connects
   ListenBrainz, and deletes the account, and no row of theirs remains.
5. **YouTube Music push.** The upload endpoint, tokens, the alignment of
   [section 3](#aligning-a-page-with-the-last-one), the crate's upload output,
   and the template workflow ([below](#8-the-gist-action)). Measures the day
   boundary and the CPU of the alignment at 1,000 pairs. The dashboard shows a
   `gap` and warns that a YouTube play that is also scrobbled to ListenBrainz
   counts twice until milestone 6. _Done when_ an integration test and a live
   run both pass. The test posts a page of three plays (`c b a`), then a page of
   the two newest of them and one new play (`x c b`): four plays are stored and
   the total reads 4. It then posts `x c b` again (still 4), and a page that
   shares nothing (`q r s`: seven plays and the source status `gap`). A second
   case covers repeated plays: `A A B`, then `A A A` stores four plays in total
   with `ambiguous` 0. `A A A` again is a replay: it stores none, keeps the
   total at four, reports `inserted` 0 and `ambiguous` 0, and leaves
   `maybe_missing` unchanged. Then `A A A A` stores one play (five in total) and
   reports `ambiguous` 1, and `maybe_missing` becomes 1. A third source starts
   with `A A`, then posts `A A A`: three plays in total, `ambiguous` 0. The live
   run is two runs of the Action one hour apart with a play between them, and
   each play is stored once.
6. **Cross-source duplicates.** `markDuplicates`. _Done when_ a user with
   ListenBrainz and YouTube Music, or with ListenBrainz and Last.fm, on one
   listening app shows each play once. The Last.fm case runs with the local
   approval value.
7. **Spotify.** Bring-your-own app first, then shared seats if the operator
   registers an app. _Done when_ a user connects Spotify and a play of a track
   that ListenBrainz also holds counts once.
8. **Imports** (optional). Spotify's extended streaming history and a YouTube
   Google Takeout watch history, uploaded as files. Both carry timestamps and no
   credential, and both reach back beyond what an API holds.

## 8. The Gist Action

The Gist output and its workflow stay. They serve a person who wants a five-line
list in their GitHub profile and no account anywhere. The program gains a second
output, and the template repository's workflow gains an upload.

### The Rust crate

The change is small and sits behind new settings:

- `UPLOAD_URL` (default `https://music.rising.sh`) and `UPLOAD_TOKEN`. When
  `UPLOAD_TOKEN` is set, the program posts the YouTube plays to `/api/v1/upload`
  through a new `src/output/upload.rs`. `GIST_ID` and `GH_TOKEN` become
  optional, and at least one output is required. `UPLOAD_TOKEN` needs
  `YOUTUBE_COOKIE`, the only source it uploads. The
  [Configuration](configuration.md) page changes with the code.
- `MUSIC_STATS_TZ` sets the time zone for "Today" and "Yesterday".
- The YouTube provider returns all the plays of the page and marks which have a
  day. `DAYS` applies to the Gist only. The upload ignores it and sends every
  play with a day and a video id, up to the whole page.
- `youtube_json.rs` reads `videoId` from each play's `watchEndpoint`.
- Last.fm stays a Gist-only input in the program. The service pulls Last.fm
  itself, so a hosted user does not put a Last.fm key in a workflow.

The cookie never leaves the runner. The upload body has no field for it and the
Worker has no code that could store one. The only secret that reaches the
service is the upload token, which can write plays and read nothing.

### The template workflow

The template's `gist.yml` keeps its daily run. A new `upload.yml` runs every
three hours (`0 */3 * * *`). The page holds about 200 plays, which is ten hours
of continuous listening, so a three-hour gap leaves a threefold margin. It
downloads the binary that [`release.yml`](../.github/workflows/release.yml)
attaches to a release, with `gh release download`, instead of compiling. Today's
workflow compiles on every run, which takes minutes. It passes `YOUTUBE_COOKIE`,
`UPLOAD_TOKEN` and `MUSIC_STATS_TZ`. It keeps the `keepalive` job, because
GitHub disables a scheduled workflow after 60 days without activity
([GitHub Actions](github-actions.md#schedule)). Google may end a cookie that
moves to a runner's network, as
[Providers](providers.md#keep-the-cookie-working) explains. When the upload
fails, GitHub emails the user, and the dashboard shows the age of the last
upload.

## How comparable projects answer

| Question         | Project                                                                           | What it does                                                                                                                              | What this design takes                                         |
| ---------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Pulled sources   | [multi-scrobbler](https://github.com/FoxxMD/multi-scrobbler)                      | Polls Spotify and YouTube Music, keeps a queue, retries after failures, and sends to Last.fm, ListenBrainz and others.                    | The pull loop and the user's own Spotify app.                  |
| Duplicates       | multi-scrobbler                                                                   | Scores title, artist and album text with Levenshtein and Dice, and compares times in four states (exact, close, during, fuzzy).           | Time as the second witness, and a window for end-time sources. |
| Push and listens | [ListenBrainz](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html) | Per-user token in `Authorization`, 1,000 listens a request, `listen_type: import`, MBIDs and ISRC in `additional_info`.                   | The token header, the batch limit and the identifiers.         |
| Weekly output    | [music-box](https://github.com/jacc/music-box)                                    | A fork-and-secrets Action reads Last.fm and writes the week to a Gist.                                                                    | The Gist stays, as the no-account path.                        |
| Workers and D1   | [listentomore](https://github.com/rianvdm/listentomore)                           | Hono on Workers, D1 for data and KV for cache.                                                                                            | The platform pairing.                                          |
| Spotify upkeep   | [stats.fm](https://support.spotistats.app/docs/import/spotify-import)             | Refreshes Spotify history about every 100 minutes and needs an import of the full history for play counts, since the API gives no counts. | Polling with back-off, and the optional import in milestone 8. |

## Open questions

Only the operator can act on these two.

- **The Spotify developer app.** Does the operator register a shared app? It
  needs an owner with Spotify Premium, the redirect URI
  `https://music.rising.sh/auth/spotify/callback`, and a hand-added user in the
  app's dashboard for each of the 5 seats. Without it, Spotify users bring their
  own app, and milestone 7 ships that route alone. The answer decides only the
  second route in [Spotify and the user limit](#spotify-and-the-user-limit).
- **The Last.fm approval.** Last.fm must approve in writing every public page
  that uses its data (clause 2.7). The operator writes to the contact the terms
  give, `partners@last.fm`, with the planned profile page and the credit button
  placement, and asks for the larger store of clause 4.3.4 at the same time.
  When the answer is yes, the operator sets `LASTFM_APPROVAL` as the
  [gate](#the-lastfm-launch-gate) describes. Until then Last.fm users get no
  public page, and ListenBrainz users are unaffected.
