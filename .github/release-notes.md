music-stats 0.4.0 is out.

This release comes three weeks after 0.3.0. Its headline is a second output, and
it carries the YouTube fixes of #45. The library API changed again, so it is a
minor bump while the version is below 1.0.

The big change is the upload output. With `UPLOAD_TOKEN` set, `music-stats`
posts the plays of the YouTube Music history page to the upload endpoint of the
service at `UPLOAD_URL`. The default is the hosted service at
https://music.rising.sh, which keeps every play it receives and serves a public
listening profile, a JSON endpoint and an SVG card. The history page holds only
about 200 plays, so the template's new `upload.yml` workflow runs every three
hours, before plays fall off the page, and downloads this release's binary
instead of building from source. The service is not open yet, so there is no way
to create an `UPLOAD_TOKEN` today. A run without `UPLOAD_TOKEN` behaves as
before and touches only the Gist.

`GIST_ID` and `GH_TOKEN` are no longer required. A run now needs at least one
output: the Gist, or the upload. Each output runs on its own, so one can fail
while the other succeeds. No configuration that worked on 0.3.0 changes what it
fetches or writes. Two things change around the edges: a configuration with
neither output fails with `No output configured` instead of naming a missing
Gist variable, and a run where a provider fails now exits 1 after writing the
outputs it could. The exit code used to stay 0 with only a warning in the log,
which kept failing scheduled runs green; in GitHub Actions a failed run now
shows up and sends mail.

The YouTube provider misread the history page, which is what #45 was about. Its
worst case looked like a cookie that dies within days: the parser read only the
day headings, so a page whose plays sit under "This week" or a month heading
came back nearly empty, and the empty result was reported as an expired cookie.
The parser now reads the week and month headings too, in English, Spanish,
Portuguese, Italian and French, and reports a dead cookie only when the page's
own `LOGGED_IN` flag says the session is gone. A signed-in page with no plays is
no longer an error. Items with a blank column are kept instead of dropped, and a
play with several artists is credited to the first one instead of the last. On a
recorded page of 197 plays the old code read 0; the new code reads all of them.

Two smaller fixes. Whitespace around a configuration value is trimmed, so a
token pasted with a trailing newline works instead of failing quietly. And a
`DAYS` window too large for the date arithmetic used to panic or land in the
future; a window longer than the history that exists now reads all of it.

`MUSIC_STATS_TZ` is a new optional variable: the time zone that the history
page's "Today" and "Yesterday" headings resolve in. The default is UTC, which is
what 0.3.0 already used. Both scheduled workflows gained a `keepalive` job,
because GitHub disables a schedule after 60 days without repository activity.
The rest is tests, docs, CI and dependency updates.

## Breaking changes

These affect only code that depends on the `music-stats` library crate. The
binary's configuration gains variables; every variable that worked still works.

`config::Config` no longer holds `gist_id` and `github_token`. The Gist settings
moved into `gist: Option<GistConfig>`, and the struct grew
`upload: Option<UploadConfig>` and `timezone: chrono_tz::Tz`.

```rust
// 0.3.0
println!("updating gist {}", config.gist_id);

// 0.4.0
if let Some(gist) = &config.gist {
    println!("updating gist {}", gist.id);
}
```

`providers::youtube::fetch_scrobbles` is now `fetch_plays`. It takes the time
zone instead of a day count, returns `Vec<YouTubePlay>`, and covers the whole
history page. A `YouTubePlay` carries its `scrobble`, its `video_id` and the
`day` its heading named. Callers that want the old window filter the result
against `providers::types::cutoff(days)`.

```rust
// 0.3.0
let scrobbles = music_stats::providers::youtube::fetch_scrobbles(
    &client,
    music_stats::providers::youtube_http::DEFAULT_BASE_URL,
    &cookie,
    7,
)
.await?;

// 0.4.0
let plays = music_stats::providers::youtube::fetch_plays(
    &client,
    music_stats::providers::youtube_http::DEFAULT_BASE_URL,
    &cookie,
    chrono_tz::Tz::UTC,
)
.await?;
```

`app::fetch_scrobbles` is now `app::fetch_plays` and returns `Fetched`, a struct
with the `scrobbles`, the `youtube_plays` and the names of the providers that
`failed`.

`errors::Error` has three new variants: `NoOutputs`,
`SomeProvidersFailed { providers }` and `Upload { url, status, cause }`. A
`match` on `Error` with no wildcard arm needs one arm per variant.

Additive, not breaking: the `output::upload` module (`DEFAULT_BASE_URL`,
`UploadRequest`, `UploadReply`, `build_request`, `upload_plays`),
`providers::types::{YouTubePlay, cutoff}` and
`providers::youtube_parse::ensure_signed_in`.

## Known problems

- The upload output has no service to talk to until https://music.rising.sh
  opens. Setting `UPLOAD_TOKEN` today only fails the upload step; leave it
  unset.
- Last.fm history is read for at most 10 pages of 200 plays. With more than 2000
  plays in `DAYS` days the older plays are missing, and the run says so in a
  warning. Lower `DAYS` to avoid it.
- Upgrading straight from 0.2.x: the Gist keeps its old `lastfm-recent-tracks`
  file next to the `music-stats` file. Delete the old file in the Gist by hand.

## What to do

Upgrade with `cargo install music-stats --force`, or update the version in your
`Cargo.toml` if you use the library. A run that only updates a Gist needs no
configuration change. When the service opens, create an `UPLOAD_TOKEN` on its
settings page and add it with `YOUTUBE_COOKIE` to your repository's secrets;
`upload.yml` does the rest. Report problems at
https://github.com/totallynotdavid/music-stats/issues.
