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

One repository. The root `Cargo.toml` is a virtual Cargo workspace over
`crates/*`, and each directory under `apps/` is a deployed app. The published
crate is [`crates/music-stats/`](../crates/music-stats/Cargo.toml). Its
`include` list names `src/**` and `Cargo.toml`, and Cargo adds `readme.md` and
`LICENSE`, so `apps/web/` never enters the published crate.

```text
crates/music-stats/     the Rust crate: Cargo.toml, src/, tests/
apps/web/
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
need no client script, and the static files in `apps/web/public/` are served by
the Worker's `assets` binding. Cloudflare documents this route in its
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

All times are Unix seconds in UTC. The schema is three migrations. A table holds
only what a query reads.

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER NOT NULL UNIQUE,
  github_login TEXT,
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

CREATE TABLE daily_totals (
  user_id INTEGER NOT NULL REFERENCES users (id),
  day INTEGER NOT NULL,
  plays INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
) WITHOUT ROWID;

CREATE TABLE artist_totals (
  user_id INTEGER NOT NULL REFERENCES users (id),
  artist_id INTEGER NOT NULL REFERENCES artists (id),
  plays INTEGER NOT NULL,
  PRIMARY KEY (user_id, artist_id)
) WITHOUT ROWID;
CREATE INDEX artist_totals_top ON artist_totals (user_id, plays DESC);

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

CREATE TRIGGER plays_day_counted AFTER INSERT ON plays WHEN NEW.dup = 0
BEGIN
  INSERT INTO daily_totals (user_id, day, plays)
  VALUES (NEW.user_id, NEW.played_at / 86400, 1)
  ON CONFLICT (user_id, day) DO UPDATE SET plays = plays + 1;
END;

CREATE TRIGGER plays_day_uncounted AFTER UPDATE OF dup ON plays
WHEN OLD.dup = 0 AND NEW.dup = 1
BEGIN
  UPDATE daily_totals SET plays = plays - 1
  WHERE user_id = NEW.user_id AND day = NEW.played_at / 86400;
  DELETE FROM daily_totals
  WHERE user_id = NEW.user_id AND day = NEW.played_at / 86400 AND plays = 0;
END;

CREATE TRIGGER plays_artist_counted AFTER INSERT ON plays WHEN NEW.dup = 0
BEGIN
  INSERT INTO artist_totals (user_id, artist_id, plays)
  SELECT NEW.user_id, tracks.artist_id, 1
  FROM tracks WHERE tracks.id = NEW.track_id
  ON CONFLICT (user_id, artist_id) DO UPDATE SET plays = plays + 1;
END;

CREATE TRIGGER plays_artist_uncounted AFTER UPDATE OF dup ON plays
WHEN OLD.dup = 0 AND NEW.dup = 1
BEGIN
  UPDATE artist_totals SET plays = plays - 1
  WHERE user_id = NEW.user_id
    AND artist_id = (SELECT artist_id FROM tracks WHERE id = NEW.track_id);
  DELETE FROM artist_totals
  WHERE user_id = NEW.user_id
    AND artist_id = (SELECT artist_id FROM tracks WHERE id = NEW.track_id)
    AND plays = 0;
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
  oldest, until the history import ends. `gap_before` and `gap_floor` bound the
  stretch a full current page skipped, per [Pulled sources](#pulled-sources).
  `next_pull_at` is null for YouTube Music, which pushes. `idle_pulls` drives
  the back-off in [Pulled sources](#pulled-sources). Three columns serve YouTube
  Music only. `last_page` is the ordered list of `[day, video id]` pairs of the
  last accepted upload, as JSON, and `play_seq` counts the plays stored so far.
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
- **`track_totals`, `daily_totals`, `artist_totals`.** Per-user counts of each
  track, of each UTC day and of each artist, kept by the triggers on `plays`, so
  the database enforces the invariant `plays = count of rows with dup = 0`. The
  all-time view reads them instead of grouping `plays`: the first rows of
  `track_totals_top` and `artist_totals_top` for the top lists, and
  `daily_totals` for the plays per day. A function that recounts from `plays`
  repairs a table that drifts; the nightly cron checks a sample of users.

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
  query. A faster request gets `429` with `Retry-After`. A replayed page still
  updates `sources.last_ok_at` and `tokens.last_used_at`, so the limit applies
  to a re-run too. In the reply, `duplicate` is `received` minus `inserted`.
- **Atomic.** A body that fails validation gets `422` with the failing item
  indexes and nothing is stored. A valid body is written in one `db.batch()`,
  which D1 runs as a transaction, so a request lands whole or not at all.
  Duplicate marks run after the store in their own D1 calls, and a failed mark
  is redone by the next store or replay over the same span.
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
[`youtube_json.rs`](../crates/music-stats/src/providers/youtube_json.rs)
resolves "Today" and "Yesterday" in it. A wrong boundary also breaks the
alignment, because the same play would carry two days on two uploads. Milestone
5 measures the boundary: upload hourly for two days and check that no play lands
on two days and that no upload reports a gap. Until that passes, the design
treats a one-day error on YouTube Music plays as possible.

The crate sends only plays that sit under "Today", "Yesterday" or a `YYYY-MM-DD`
heading. The week and month headings cover several days, and the crate gives
those plays an invented date ([Providers](providers.md)). That is good enough
for a top-five list and wrong for a ledger, so they are left out of the upload.
A daily run sees every play under "Today" or "Yesterday" first, so only plays
older than the first upload are lost.

### File imports

Spotify's recently-played endpoint holds 50 plays and the YouTube history page
about 200. Two files reach further back: Spotify's extended streaming history
and the watch history of Google Takeout. Both carry a time per play and no
credential. A signed-in user selects them on the settings page. The browser
reads the files and posts small batches, so the file never leaves the browser.

```text
file ── browser: parse, keep, sort ── POST /settings/import, 100 plays ──▶ Worker ──▶ D1
```

#### The two files

**Spotify.** The user asks for "Extended streaming history" in the privacy
settings of their Spotify account, unzips the archive, and selects the
`Streaming_History_Audio_*.json` files. Each file is a JSON array with one
record per stream.
[Spotify's data page](https://support.spotify.com/us/article/understanding-my-data/)
describes the fields. The page reads six:

| Field                               | Use                                                              |
| ----------------------------------- | ---------------------------------------------------------------- |
| `ts`                                | When the stream ended, UTC, `YYYY-MM-DDTHH:MM:SSZ`.              |
| `ms_played`                         | Milliseconds played. `ts` minus this is the start of the play.   |
| `spotify_track_uri`                 | `spotify:track:` and a 22-character id. It is the alias key.     |
| `master_metadata_track_name`        | The title.                                                       |
| `master_metadata_album_artist_name` | The artist. The file holds the album artist and no track artist. |
| `incognito_mode`                    | True for a play in a private session.                            |

Every other field is ignored: `platform`, `conn_country`, `ip_addr`, the album
name, `episode_*`, `audiobook_*`, `spotify_episode_uri`, `reason_start`,
`reason_end`, `shuffle`, `skipped`, `offline` and `offline_timestamp`. The
`ip_addr` of a record never leaves the browser. A record is kept when all of
these hold:

1. `spotify_track_uri` matches `^spotify:track:[A-Za-z0-9]{22}$`. A podcast
   episode, an audiobook and a local file fail it.
2. The track name and the artist name are non-empty strings. Spotify leaves them
   null when it no longer holds the metadata.
3. `ms_played` is at least 30,000. Spotify counts a stream from 30 seconds
   ([how streams are counted](https://support.spotify.com/artists/article/how-we-count-streams/)).
   The Spotify importer of ListenBrainz drops a play under 30 seconds that the
   user skipped
   ([source](https://github.com/metabrainz/listenbrainz-server/blob/master/listenbrainz/background/listens_importer/spotify.py)).
4. `incognito_mode` is not true. A private session is a play the user asked
   Spotify not to show, and a public profile must not show it.

The stored time is `ts` minus `ms_played / 1000`, in whole seconds. Every other
source stores a start, and the pairing window of
[Cross-source duplicates](#cross-source-duplicates) is built for a start. A file
whose first record lacks `ms_played` or `spotify_track_uri` is refused, for
example a video history file.

**YouTube Music.** The user opens Google Takeout, selects "YouTube and YouTube
Music", chooses only "history", changes its format from HTML to JSON, unzips the
archive, and selects
`Takeout/YouTube and YouTube Music/history/watch-history.json`
([guide](https://rafaaseddik.github.io/youtube-wrap/guide.html)). The file is a
JSON array of "My Activity" records
([schema](https://developers.google.com/data-portability/schema-reference/my_activity)).
It holds YouTube and YouTube Music watches together. The page reads five fields:

| Field       | Use                                                                      |
| ----------- | ------------------------------------------------------------------------ |
| `header`    | The product. `YouTube Music` marks a music play.                         |
| `titleUrl`  | `https://music.youtube.com/watch?v=<video id>`. The id is the alias key. |
| `title`     | `Watched ` and the title.                                                |
| `subtitles` | The first item's `name` is the channel, which is the artist.             |
| `time`      | When the user did the activity, UTC, with milliseconds.                  |

Every other field is ignored: `description`, `products`, `activityControls`,
`details` and the channel `url`. A record is kept when all of these hold:

1. `header` is exactly `YouTube Music`.
2. `titleUrl` parses, with the platform URL parser, to the host
   `music.youtube.com`, the path `/watch` and a `v` value of 1 to 32 characters
   from `A-Za-z0-9_-`. A video that Google has since removed has no `titleUrl`.
3. `title` starts with `Watched ` and holds text after it, and
   `subtitles[0].name` is a non-empty string. A music record can carry its own
   URL as the title and have no `subtitles`. It fails here.
4. `time` is a date between 2005-01-01 and tomorrow in UTC, the bound of the
   upload API.

The artist goes through the same matching as a pushed play, so a channel named
`Amrinder Gill - Topic` loses its suffix ([Song matching](#4-song-matching)). A
music video's channel can be a label, as it is on the push path. Takeout holds
no play length, so the page keeps every record: a track skipped after a second
counts, as it does in the history page that the push path reads. The stored time
is `time` in whole seconds. The export is read in English: the `Watched ` verb
is not translated by this design, so a record without it is skipped, and the
page counts it as such. Whether Takeout translates the verb is unverified.

The page shows its counts before it uploads anything: plays kept, and plays
skipped with the rule that dropped each one.

#### From the file to D1

The Worker cannot read a file. A 100,000-play Spotify history is about 63 MB
(about 630 bytes a record in a public sample) and a Takeout history about 35 MB
(about 350 bytes a record), while section 6 measures 0 to 7 ms of CPU to parse
one 200-listen page, and the Free plan allows 10 ms. The cron cannot drain a
staged copy either: a pull tick already measures 16 to 24 ms of CPU. So the
browser does the parsing, and the Worker sees only the plays it keeps.

`apps/web/public/import-parse.js` holds the two keep rules as pure functions,
and `apps/web/public/import.js` holds the page: it reads one file at a time with
`File.text()` and `JSON.parse`, keeps the plays, sorts them newest first, and
posts them in order. The page takes `.json` files only. A ZIP needs a library,
and the user unzips once. The settings page serves both scripts as static
assets, which cost no Worker request.

```http
POST /settings/import
Content-Type: application/json

{
  "source": "spotify",
  "plays": [
    {"at": 1713636922, "id": "1U8rhryVYw9gWZ6zvw4Orc",
     "artist": "OAFF", "title": "Beqaaboo"}
  ]
}
```

```json
{
  "received": 100,
  "inserted": 97,
  "duplicate": 3,
  "used": 41210,
  "limit": 50000
}
```

- **Who.** The session cookie and the origin check of
  [section 5](#5-accounts-and-deletion). The route sits in `settingsApp`, which
  already makes both checks.
- **Body.** `source` is `spotify` or `ytmusic`. `plays` holds 1 to
  `importBatchSize` (100) items. `at` is an integer between 2005-01-01 and
  tomorrow. `id` is 22 characters from `A-Za-z0-9` for `spotify`, and 1 to 32
  from `A-Za-z0-9_-` for `ytmusic`. `artist` and `title` hold 1 to 512
  characters, and the page cuts a longer text. The body is at most 64 KiB, and
  the `Content-Type` must be `application/json`. A body that fails gets `422`
  with the item indexes and nothing is stored.
- **Batch size.** 100 plays. [Section 6](#6-limits-and-costs) records 9 ms of
  CPU for an upload of 200 plays on new tracks, and the Free limit is 10 ms. A
  batch of 100 leaves room for the source upsert and the marking. Milestone 8
  measures the batch on the deployed Worker and lowers the constant if it takes
  more than 8 ms.
- **Steps.** (1) Read the tally `backfill-rows`. At the limit the answer is
  `429` with `Retry-After` set to the seconds left to 00:00 UTC, and nothing is
  stored. (2) Upsert the user's import source, `spotify_import` or
  `ytmusic_import`, and read its id. (3) `storeListens` with matching kind
  `spotify` or `ytmusic`. (4) `markDuplicates` over the span of the batch. (5)
  Add the rows written by steps 3 and 4 to the tally. The check happens before
  the write, so a batch that starts under the limit can end up to one batch over
  it, about 1,200 rows.
- **Retry.** A failed batch is sent again. The plays are ignored the second time
  and the marking repeats over the same span, so a failure between steps 3 and 4
  leaves no unmarked play after the retry.

`storeListens` gains an optional `ref` per play, which `bulkPlaySql` writes in
place of `''`. Nothing else in the store path changes.

**Rows and the cap.** An imported play writes 8 rows on a known track and about
12 on a new one, measured through `POST /settings/import` on local D1 — about
one row more a play than the statements alone write for a stored play
([section 6](#6-limits-and-costs)). A stored play costs more than it did before
migration 0005, whose `plays_source` index adds a row to every play write. A
batch is about 800 rows, or 1,200 when every track is new. The imports share the
50,000-row `backfill-rows` tally with the history walks, so a day admits 41 to
62 batches. A history of 100,000 plays in which one play in five is on a new
track writes 100,000 × 8 + 20,000 × 4 = 880,000 rows. That is about 55 batches a
day for 18 days, 1,000 batches in all. All new tracks give 1,200,000 rows and 24
days, and all known tracks 800,000 rows and 16 days. The plays that
`markDuplicates` flags add the rows of its updates. While an import runs,
history walks wait for the same tally and pulls of new plays and uploads carry
on. The tally belongs to the account, not to a user, so on the Free plan all
users share roughly 6,000 imported plays a day. The Paid plan lets the operator
raise `maxBackfillRowsPerDay`.

When the page gets `429` it stops and says that the limit is reached and when it
resets. The user selects the same files on a later day. The page keeps in
`localStorage`, under the sorted list of file names and sizes, the number of
plays posted, and skips that many on the next run. The server needs none of it:
a lost note only repeats batches that insert nothing. A batch that is repeated
writes no `plays` row.

#### What an import stores

- **Source.** One `sources` row per user and kind, `spotify_import` or
  `ytmusic_import`. It has no account, secret, cursor or schedule:
  `next_pull_at` is null, so the cron never selects it. `last_ok_at` is the time
  of the last batch, and `status` stays `active`. It is a separate kind because
  the user can remove an import without touching a pulled source of the same
  service, and because a pull and an import cannot share the cursor.
- **Plays.** The key is `(user_id, played_at, source_id, ref)` with `ref` set to
  the track id or the video id. A file can hold two plays that start in the same
  second, for example when the app syncs offline plays, so the id keeps both and
  still rejects a repeat. The same file posted again, or an export that overlaps
  an earlier one, holds the same `ts`, `ms_played` and track, so every key
  exists and `INSERT OR IGNORE` stores nothing. The response says `inserted` 0.
- **Tracks.** The alias is `(spotify, <track id>)` or `(ytmusic, <video id>)`,
  the same alias the pulled Spotify source and the push path use, so a track
  that a pull already stored resolves to the same row. The import sends no ISRC
  or MBID. A Spotify record carries the album artist, so a compilation track
  creates an artist such as `Various Artists` when no pull has stored the track.
  The file offers no better artist.
- **Day.** The time is exact, so an imported play counts on the UTC day of its
  time in `daily_totals`, like a pulled play. `MUSIC_STATS_TZ` is not read.

**Overlap with other sources.** Both imports take part in `markDuplicates`. The
rank order of [Cross-source duplicates](#cross-source-duplicates) becomes
`spotify`, `spotify_import`, `listenbrainz`, `lastfm`, `ytmusic_import`,
`ytmusic`. An import ranks directly below the pulled source of its service, so a
user who has both keeps the live record. A Takeout play outranks a pushed one,
because its time is exact.

`ytmusic_import` pairs by window, not by day. Its time is exact, so it pairs
with a play of any other source that has an exact time by the window rule: the
same `track_id`, within `max(track length, 4 minutes) + 30 seconds`, or 10
minutes when the length is unknown. The day rule stays for a `ytmusic` push
play, which holds a day and no time. It applies when either side of a pair is a
push play, so a push play and a Takeout play of one video on one UTC day count
once. A day rule between two exact times would merge a morning play and an
evening replay of one song, and both happened. A change to `duplicates.ts` after
milestone 6 makes the day test depend on the source kind `ytmusic`, and adds the
two kinds to its rank list.

#### Removing an import

Section 5 removes a source in one batch, which deletes its plays and recounts
the user's three totals tables. For 100,000 plays that is more than the 100,000
rows a day of the Free plan. An import is removed in chunks instead:

```http
POST /settings/import/remove
```

```json
{ "source": "spotify", "removed": 2000, "remaining": 98000 }
```

The page repeats the request until `remaining` is 0. `remaining` comes from
`sources.play_count` minus the chunk's size: an import batch raises the count by
the plays it inserted, and each removal chunk lowers it again, so a request
reads one chunk and never counts the source's plays. Each request takes the
`removeChunkSize` (2,000) oldest plays of the source, in these steps:

1. Read the tally. At the limit the answer is `429`, as for a batch of plays.
2. One `db.batch()` does the following. It lowers `track_totals`,
   `artist_totals` and `daily_totals` by the counts of the chunk's plays with
   `dup = 0`, grouped by track, artist and day, and deletes a totals row that
   reaches 0. It sets `dup = 0` on the other sources' plays that lie in the
   chunk's span widened by the pairing window and the YouTube Music day rule,
   and the `plays_recounted` trigger adds each reopened play back to the three
   totals. It lowers `sources.play_count` by the chunk's size and deletes the
   chunk's plays. When the chunk is the last, it deletes the `sources` row too.
3. `markDuplicates` over the span of the reopened plays, from the earliest to
   the latest `played_at` the reopening returned, so a play that another source
   still shadows is marked again, and a play that only the import shadowed
   counts.
4. Add the rows written to the tally.

The batch changes the totals together with the plays, so after step 2 the
invariant `plays = count of rows with dup = 0` holds, and a user who stops
halfway holds a smaller import. A failure between steps 2 and 3 leaves the plays
of that span unmarked until a later `markDuplicates` over it, which can count a
play twice in the meantime. The statements of step 2 write at most 7 rows for
each play they touch, the chunk's and the reopened ones: 2 for the play row and
its `plays_source` entry, 2 for each of the track and artist totals rows, and 1
for the day. A chunk repeats tracks, artists and days, so the usual cost is
lower, but the reopening can touch more plays than the chunk holds. Measured on
local D1, a chunk of 2,000 plays read about 82,000 rows and wrote 2,012; a chunk
that reopened 2,000 marked plays of another source read about 176,000 and wrote
14,012, which is also the most the tally passed its limit in that run.
`track_totals.last_played_at` is not corrected by a removal, and no query reads
it.

Deleting the account stays the single batch of section 5. A user with a large
import removes it first, as above, and then deletes the account. The batch
removes the `sources` rows of both import kinds with the others, and the import
holds no token.

#### Schema change

The `kind` check of `sources` lists four values, so migration `0005_imports.sql`
rebuilds the table with `'spotify_import'` and `'ytmusic_import'` added. SQLite
cannot alter a check. A rename of the old table would rewrite the foreign keys
of `plays` and `tokens` to the renamed table, and a drop with child rows fails
the foreign key check at commit. A copy of the rows avoids both:

```sql
PRAGMA defer_foreign_keys = on;
CREATE TABLE sources_copy AS SELECT * FROM sources;
DROP TABLE sources;
CREATE TABLE sources (… the columns of migrations 0001 and 0002, with
  kind IN ('lastfm', 'listenbrainz', 'spotify', 'ytmusic',
           'spotify_import', 'ytmusic_import') …);
INSERT INTO sources SELECT * FROM sources_copy;
DROP TABLE sources_copy;
CREATE INDEX sources_due ON sources (next_pull_at)
  WHERE next_pull_at IS NOT NULL;
```

The new table lists its columns in the order the old table has them after
`ALTER TABLE`, so `SELECT *` lines up. Run with `wrangler d1 migrations apply`
against local D1 on a database holding plays and tokens, it kept every row and
`PRAGMA foreign_key_check` printed nothing.

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
[`recent_tracks.json`](../crates/music-stats/tests/fixtures/recent_tracks.json)
shows it empty. The YouTube history page gives a `videoId` in each play's
`watchEndpoint`, and a `musicVideoType`: `MUSIC_VIDEO_TYPE_ATV` for the audio
track and other values for music videos and user uploads. The crate does not
read `videoId` today. The upload change adds it.

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
cases. It reads the span once and groups the plays by track in the Worker. Each
track's span is then widened by the pairing window and the YouTube Music day
rule. While a widened span reaches past the covered range, the function reads
the missing range below it and the missing range above it, widens the spans
again, and repeats until every span is covered. Then it pairs.

**Known limit.** A mark is never undone, so a chain of plays that spans more
than 600 s can count differently by the order its sources arrive. Take a track
with a ListenBrainz play at noon+300, a Last.fm play at noon+900 and a Spotify
play at noon. If ListenBrainz and Last.fm are stored first, they are 600 s apart
and Last.fm is marked. Spotify then arrives, pairs with ListenBrainz and marks
it, and the marked Last.fm play stays marked: the track counts 1 play. One store
of all three pairs Spotify with ListenBrainz and leaves Last.fm counted: it
counts 2. Lifting the limit needs a trigger that recounts a play when `dup` goes
from 1 to 0. Migration 0005 adds that trigger, `plays_recounted`, which returns
a play's totals when `dup` goes from 1 to 0; the import removal fires it for the
plays it reopens. What is still missing is a pass that unmarks: `markDuplicates`
only ever sets `dup` to 1, so the mis-ordered chain above keeps its count of 1.

## Pulled sources

A Cron Trigger runs every minute and calls `scheduled()`. It selects the due
source whose `next_pull_at` has passed, oldest first, through `sources_due`, and
pulls it, one source a tick. [Limits and costs](#6-limits-and-costs) records
what a tick costs against the Free plan's
[limits](https://developers.cloudflare.com/workers/platform/limits/).

- **Last.fm.** `user.getrecenttracks` with `limit=200` and `from=cursor+1`
  ([method](https://www.last.fm/api/show/user.getRecentTracks)). The method
  needs no user authentication, only the service's API key. The first pull
  stores the newest page, sets `cursor` and `backfill_before`, and later pulls
  walk back with `to` until a page is empty. A pull skips the now-playing track,
  which has no date, as the crate does
  ([`lastfm.rs`](../crates/music-stats/src/providers/lastfm.rs)). The crate
  waits 200 ms between pages. The Worker does the same, because Last.fm sets its
  own rate limits and may change them (clause 4.4 of its terms). The cron pulls
  it only when `LASTFM_APPROVAL` is set.
- **ListenBrainz.** `GET /1/user/NAME/listens` with `min_ts=cursor` and
  `count=200`, and `max_ts` for the backfill, since one call takes only one of
  the two
  ([API](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html)).
  `listened_at` is the playback start. Milestone 1 confirms that a public user's
  listens need no token. One pull takes up to two calls: the current page, then
  a walk page for what is left of the 200-listen budget. A page that comes back
  full means more waits, so the source is due again at the next tick. The API
  returns the newest `count` listens at or after `min_ts`, so a full current
  page skips the listens between the old cursor and the page's oldest. That
  range is the gap: `gap_floor` holds the old cursor and `gap_before` the walk's
  upper bound, and the walk drains the gap first, stopping when a page's oldest
  listen reaches `gap_floor`, before `backfill_before` resumes. The pull reads
  `X-RateLimit-Remaining` and `X-RateLimit-Reset-In`; when the remaining count
  reaches 0, or a call answers `429`, the source waits out the reset instead of
  pulling again.
- **Spotify.** `GET /me/player/recently-played?limit=50&after=cursor` with a
  refresh token. It needs the `user-read-recently-played` scope. The endpoint
  returns at most 50 plays, so a source must be pulled before the user has
  played 50 more tracks. About 3 minutes a track means 2 hours, so the Spotify
  back-off never exceeds 1 hour.
- **Back-off.** A pull that finds plays sets `idle_pulls` to 0 and
  `next_pull_at` to 15 minutes ahead. An empty pull adds 1 to `idle_pulls` and
  sets the delay to `15 minutes × 2^idle_pulls`, with a ceiling of 6 hours (1
  hour for Spotify). A pull that has more work waiting overrides the back-off
  and comes due at the next tick; a pull the source rate-limits waits out the
  reset. Last.fm and ListenBrainz keep the whole history, so waiting loses
  nothing.
- **Failure.** A pull that fails sets `status = 'error'` with a short `error`
  and retries with the same back-off. The dashboard shows the message. A Last.fm
  user who hides recent listening gets an error that says so. An expired or
  revoked Spotify token also shows there.
- **Backfill write cap.** History walks across the account write at most 50,000
  D1 rows a day, so backfills cannot spend the account's whole 100,000-row daily
  write budget and starve new-play pulls and uploads. A walk adds its batch's
  `meta.rows_written` to the shared KV tally `backfill-rows`, which expires at
  the next 00:00 UTC; a routine pull of new plays or an upload writes no tally.
  Once the tally reaches the cap every pull skips its history walk — the gap
  drain counts too — and schedules its next pull by the usual rule, so the
  source keeps collecting new plays. At the measured 12 rows a play for new
  tracks the cap admits roughly 4,000 plays a day, so a 50,000-play history
  backfills in about twelve days.

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
  `tokens` and the `sources` row, then recounts `track_totals`, `daily_totals`
  and `artist_totals` for the user. The Spotify refresh token goes with the row.
  The user can also revoke the app in their Spotify account.
- **Delete the account.** The user types their name to confirm. One batch
  deletes `plays`, `track_totals`, `daily_totals`, `artist_totals`, `tokens`,
  `sources`, `sessions` and the `users` row, in that order, so no foreign key
  fails. No cascade is declared, so D1 never scans a table to find children.
  Cached snapshots in KV are keyed by the user id, which is never reused, and
  expire within a day.
- D1 Time Travel keeps restore points for 7 days on the Free plan and 30 days on
  Paid ([limits](https://developers.cloudflare.com/d1/platform/limits/)).
  Deleted rows leave the restore points with them. The privacy text says so.
- **Export.** `GET /settings/export` answers the user's plays as NDJSON, one
  play per line, in pages of 1,000 rows by key. A full page carries a
  `Link: rel="next"` header whose `?after=` query resumes at the next key, so
  the client downloads page after page and the 50 MB D1 result limit and the CPU
  budget are never near. The settings page's download control runs a small
  inline script that follows the next links and saves the joined pages as
  `music-stats-NAME.ndjson`; the plain link keeps working for curl, which reads
  the Link header itself.

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
  the totals tables instead: `track_totals_top` for the top tracks,
  `artist_totals_top` for the top artists, `daily_totals` for the plays per day,
  and `track_totals` and `artist_totals` row counts for the summary figures. The
  plan for the weekly query was checked in SQLite: it searches `plays` by the
  key and groups with one temporary b-tree.
- **JSON.**
  `{"schema": 1, "user": …, "period": …, "from": …, "to": …, "plays": …, "unique_tracks": …, "unique_artists": …, "top_tracks": […], "top_artists": […], "daily": […], "updated_at": …}`.
  A user with a Last.fm source also gets
  `"credit": {"name": "Last.fm", "url": "https://www.last.fm"}`. It sends
  `Access-Control-Allow-Origin: *`, because it is public data.
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
  For a user with a Last.fm source all three addresses send
  `Cache-Control: public, max-age=60` instead ([gate](#the-lastfm-launch-gate)).
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

- A new play on a known track writes 7 rows, measured locally: the play row and
  its `plays_source` index entry, the `daily_totals` upsert, and the
  `track_totals` and `artist_totals` upserts, which D1 bills as two rows each
  because they change an indexed column
  ([pricing](https://developers.cloudflare.com/d1/platform/pricing/)). A play
  whose track is new costs more: a 100-play import batch of new tracks wrote
  about 1,200 rows locally, 12 a play, because a new track adds its `artists`,
  `tracks` and `track_aliases` rows and their index entries, shared by all
  users. A pull with no new plays writes two rows: the `sources` row and its
  `sources_due` index entry. A play row is an estimated 40 bytes, so 500 MB
  holds on the order of ten million plays.
- A profile, JSON or card request with a warm snapshot reads one `users` row and
  one KV key. A cold one reads the rows of the period: about 350 plays for a
  week of a heavy listener, and about 1,500 for a month. `all` reads the totals
  tables, so a cold `all` snapshot of a 50,000-play history measures about 3 ms
  locally.
- A pull costs one or two subrequests to the source and two or three D1 queries.
- The Worker bundle is 166 KiB, 42 KiB gzip, and evaluating it measures about
  9.7 ms in Node, locally.

**Where the Free plan runs out,** in the order a service of one-user-per-day
growth meets the limits. The local figures come from
`apps/web/test/bench.test.ts`, which runs a recorded 300-listen ListenBrainz
page (`apps/web/test/fixtures/listens-rob.json`) through the pull in the Vitest
workerd pool; `PULL_BENCH=1 npx vitest run bench` runs it, and the default suite
skips it. The deployed figures are `wrangler tail` output from milestone 1 and
from the `apps/web/bench/` worker, which splits a pull into one route per stage.

1. **Cron CPU.** A first `wrangler tail` measured 10 to 23 ms CPU for six ticks
   that each pulled a 200-listen backfill page of mostly new tracks, with 1.1 to
   3.0 s of wall time. The work that grew with new tracks was the per-listen
   normalisation and the matching batch. Normalisation now runs once per unique
   artist or title on the page (a 200-listen page holds about 40 artists and 130
   titles, not 400 strings), the two clause patterns are skipped when the text
   holds none of their keywords, and the batch's JSON payloads are deduplicated
   and carry only the fields each statement reads. A second `wrangler tail` on
   2026-11-12 measured a pull tick at 16 to 24 ms `cpuTime` for a 200-listen
   page (16, 17, 20, 23, 24 ms over five ticks), at 12 to 19 ms with the page
   cut to 50 listens (12, 13, 18, 19 ms over four ticks), and an idle tick with
   no source due at 1 to 2 ms. Every pull tick is over the 10 ms limit, and the
   cost barely moves with page size, so most of it is fixed per invocation, not
   per listen: the local bench measures about 1.2 ms of JavaScript for the same
   200-listen page. A 200-track Last.fm page measures the same locally: about 1
   ms of JavaScript for new and for stored plays, and 8 to 12 ms through local
   D1 against 7 to 8 ms for the ListenBrainz page
   (`apps/web/test/bench.test.ts`). The bench's own tail on 2026-11-12 measured
   the stages, in `cpuTime`: the empty handler 0 ms, `JSON.parse` of the page 0
   to 7 ms, the valibot parse 3 to 6 ms, `resolvePageTracks` 6 to 12 ms, the
   store step with its D1 batch 6 to 17 ms, a pull with a fixture fetcher 5 to
   17 ms, and a pull with a real fetch 4 to 28 ms, with a warm isolate repeating
   the real pull at 4 to 11 ms. Deployed cost runs 5 to 10 times the local
   figures. The fetch and the JSON parse are not the cost; track resolution, the
   D1 batch and its result decoding are, and a cold isolate adds more. A warm
   pull lands at 4 to 13 ms, at or over the 10 ms limit. The upload path shares
   the matching code: `wrangler tail` measured 9 ms CPU for an upload of 200
   plays on new tracks and 1 to 3 ms for 3-play uploads, and the same local
   measure is about 0.95 ms. How many pulls a day the Free plan sustains, and so
   how many users the plan holds, stays unknown. The duplicate mark runs after
   every store on the span the page touched. The `apps/web/bench/` worker
   measured it on 2026-11-13 over the 200 newest plays of the worse-ranked
   source: each run marked 200 plays, read about 620 rows for the span statement
   and wrote 1,200 rows, at 7, 12 and 7 ms `cpuTime` and 816 to 955 ms of wall
   time. The 12 ms run is over the 10 ms Free limit. The `ytmusic` case, which
   pairs plays by day rather than by the ten-minute window, is not yet measured.
2. **KV writes.** 1,000 snapshot writes a day cap the number of distinct
   profiles that can refresh in a day. A cold snapshot is still served, so the
   cap costs D1 reads, not availability.
3. **D1 writes.** 100,000 rows a day is about 8,000 new plays a day while tracks
   are new (measured at 12 rows a play), or 12,500 when the tracks are already
   stored (about 8 rows). A large backfill is heavier: 50,000 plays and their
   new tracks need an estimated 600,000 rows, which the 50,000-row backfill cap
   of [Pulled sources](#pulled-sources) spreads over about twelve days so pulls
   of new plays and uploads keep working. If the account cap is still hit, D1
   refuses every query past it, including the pull's own write, so the pull
   records the cap in a KV key that expires at the next 00:00 UTC and ticks
   check it before touching D1.
4. **Requests.** 100,000 a day is about one a second on average. A cron tick is
   one request, so ticks use 1,440 of them. Public pages are cheap to serve, but
   every view of a profile or card is a Worker request.

The first upgrade is Workers Paid at $5 a month. It lifts items 1, 2 and 4 and
leaves D1 writes at 50 million rows a month, about 8 million plays.

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

| State                   | Pulls                                                             | `/u/NAME`, `.json`, `.svg`                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LASTFM_APPROVAL` empty | The cron skips Last.fm sources, so none of their plays is stored. | `404` for every user who has a Last.fm source, even with other sources.                                                                                            |
| `LASTFM_APPROVAL` set   | Pulls as in [Pulled sources](#pulled-sources).                    | Served. Each carries the credit clause 4.2.2 asks for: a footer link on the page, a "powered by AudioScrobbler" line on the card and a `credit` field in the JSON. |

While the variable is empty, the settings page shows a Last.fm source as waiting
for approval. Development does not wait: `.dev.vars`, which `wrangler dev` reads
and which is not committed, sets `LASTFM_APPROVAL=local`, and a page that only
the developer's machine serves is not public access. If Last.fm withdraws
approval, the operator empties the variable and deploys. The pages answer `404`
at once. All three addresses send `Cache-Control: public, max-age=60`, so a copy
a browser or an image proxy cached is served for at most one more minute. The
operator then deletes the Last.fm sources' plays with the `Remove a source`
batch of [section 5](#5-accounts-and-deletion) to meet clause 9.3.

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

1. **ListenBrainz, profile, JSON.** `apps/web/` with `wrangler.jsonc`, the
   migration, the custom domain `music.rising.sh` and a deploy workflow. Users
   are rows added with `wrangler d1 execute`, with no sign-in. The cron pulls
   ListenBrainz with backfill. `/u/NAME` and `/u/NAME.json` work for the three
   periods. The milestone writes `docs/web-deploy.md` with every account step,
   secret name and command, and measures CPU per pull and rows written per play
   on real D1. _Done when_ the history of a public ListenBrainz account renders
   and a second pull inserts nothing.
2. **Last.fm behind the gate.** The Last.fm pull and the credit, with
   `LASTFM_APPROVAL` empty by default ([gate](#the-lastfm-launch-gate)). _Done
   when_ a seeded Last.fm user passes both states in an automated test: with
   `LASTFM_APPROVAL` empty, the three addresses answer `404` and the database
   holds no play of that source; with it set, they are served, carry the credit
   and bound cached copies to one minute.
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
   Google Takeout watch history, read in the browser and posted in batches
   ([File imports](#file-imports)). Both carry timestamps and no credential, and
   both reach back beyond what an API holds. The milestone adds migration
   `0005_imports.sql`, `POST /settings/import`, `POST /settings/import/remove`,
   the import panel on the settings page, `apps/web/public/import-parse.js` and
   `apps/web/public/import.js`, a `ref` per play in `storeListens`, and the two
   kinds in the rank list and day test of `markDuplicates`. It measures, on the
   deployed Worker and real D1, the CPU of a 100-play batch on new tracks (the
   batch size drops if it is over 8 ms), the rows written per play for known and
   new tracks, and the rows written per play of a removal chunk. _Done when_
   these hold, each in an automated test unless it says live:
   1. A Spotify file of eight records is posted: a track played 29,999 ms; the
      same track at 30,000 ms (kept); a 200,000 ms play with `incognito_mode`
      true; a podcast episode with a null track URI; a track with a null track
      name; a `spotify:local:` URI; a second track at 240,000 ms (kept); and the
      first track again at 180,000 ms at a later time (kept). Three plays are
      stored on the user's `spotify_import` source, each at `ts` minus
      `ms_played / 1000`, and the total reads 3. Posting the file again returns
      `inserted` 0 for every batch and the total stays 3.
   2. A Takeout file of six records is posted: a `YouTube Music` record with a
      music.youtube.com URL (kept); the same video ten minutes later (kept); a
      record with header `YouTube`; a `YouTube Music` record with no `titleUrl`;
      one with a `titleUrl` and no `subtitles`; and one whose title lacks
      `Watched `. Two plays are stored on `ytmusic_import` with `ref` equal to
      the video id, and the total reads 2. Posting it again stores none.
   3. A ListenBrainz play of a track at time T and a `spotify_import` play of
      the same track that starts at T + 20 s count once: the ListenBrainz row
      has `dup = 1`. A `ytmusic` push play of a video on a UTC day and a
      `ytmusic_import` play of the same video at 18:00 UTC on that day count
      once, and the push row has `dup = 1`. A ListenBrainz play and a
      `ytmusic_import` play of the same track 3 hours apart both count.
   4. With the tally `backfill-rows` at 50,000, a batch gets `429` with
      `Retry-After` equal to the seconds to 00:00 UTC and stores nothing. At
      49,999 the batch is stored and the tally grows by the rows it wrote.
   5. A source of 2,001 plays is removed in two requests: the first answers
      `removed` 2000 and `remaining` 1, the second `remaining` 0 and deletes the
      source. The three totals tables then equal a recount from the remaining
      plays. After removing the import of case 3, the ListenBrainz play counts
      again.
   6. A batch of 101 plays gets `422` and nothing is stored.
   7. Live: on an account with no other source, the operator imports one real
      extended history of at least 1,000 plays on the deployed Worker. The
      all-time total on `/u/NAME` equals the count of kept plays that the page
      showed. Selecting the same files again stores none.

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
`UPLOAD_TOKEN`, `MUSIC_STATS_TZ` and `UPLOAD_URL`. When `UPLOAD_TOKEN` is unset
the workflow skips the upload job, so the template repository itself and
Gist-only users see no failing run. It keeps the `keepalive` job, because GitHub
disables a scheduled workflow after 60 days without activity
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
