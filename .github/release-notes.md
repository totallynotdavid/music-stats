music-stats 0.3.0 is out.

This is the first release since 0.2.1 in January. The command and its
configuration work as before, but the library API changed, so it is a minor bump
while the version is below 1.0. If you only run the binary or the GitHub Actions
workflow, upgrade now.

The change you will notice most: a failing provider no longer stops the run.
Before, an expired YouTube cookie discarded the Last.fm plays already fetched
and left the Gist untouched. Now the failure is logged as a warning and the
other providers still publish. The run fails only when every configured provider
fails. A YouTube history page with no plays at all now counts as a failure too,
because an expired cookie still returns a page and the empty list used to
overwrite the Gist.

Three more fixes:

- YouTube titles with non-ASCII characters decode correctly. Each byte of a
  multi-byte character used to be read as a Latin-1 character, so such titles
  came out garbled.
- The Last.fm API key no longer appears in error messages or logs. Errors now
  carry only the base URL, and the query values are URL-encoded.
- The Gist is stable between runs. Tracks with equal play counts used to come
  out in random order, so a Gist rewritten daily reshuffled. Ties now sort by
  artist, then title. YouTube headings such as "Today" and "Yesterday" now
  resolve in UTC, like the stored play times, and a section with an unknown
  heading is logged instead of dropped silently.

Smaller changes: `DAYS` and `TOP_N` set to an empty string now mean unset, which
is what an unset repository variable in GitHub Actions gives you. The Gist file
is now named `music-stats` instead of `lastfm-recent-tracks`. The Last.fm fetch
logs a warning when it stops at 10 pages (2000 plays). The configuration is
loaded from an injected map, and provider and Gist base URLs are parameters, so
the tests run against local mock servers. The rest is docs, tests, CI and
dependency updates.

## Breaking changes

These affect only code that depends on the `music-stats` library crate. The
binary and its environment variables are unchanged.

The functions that call a network service take a base URL as their second
argument. `providers::lastfm::DEFAULT_BASE_URL`,
`providers::youtube_http::DEFAULT_BASE_URL` and
`output::github::DEFAULT_BASE_URL` hold the previous addresses. This applies to
`providers::lastfm::fetch_scrobbles`, `providers::youtube::fetch_scrobbles`,
`providers::youtube_http::fetch_history_page` and `output::github::upload_gist`.

```rust
// 0.2.1
let plays = music_stats::providers::lastfm::fetch_scrobbles(
    &client, &api_key, &username, 7,
).await?;

// 0.3.0
let plays = music_stats::providers::lastfm::fetch_scrobbles(
    &client,
    music_stats::providers::lastfm::DEFAULT_BASE_URL,
    &api_key,
    &username,
    7,
).await?;
```

`errors::Error` has a new variant, `AllProvidersFailed`. A `match` on `Error`
with no wildcard arm needs a new arm.

## Known problems

- The Gist keeps its old `lastfm-recent-tracks` file next to the new
  `music-stats` file. Delete the old file in the Gist by hand.
- Last.fm history is read for at most 10 pages of 200 plays. With more than 2000
  plays in `DAYS` days the older plays are missing. The run now says so in a
  warning. Lower `DAYS` to avoid it.

## What to do

Upgrade with `cargo install music-stats --force`, or update the version in your
`Cargo.toml` if you use the library. Your configuration needs no change. After
the first run, delete the old file from your Gist. Report problems at
https://github.com/totallynotdavid/music-stats/issues.
