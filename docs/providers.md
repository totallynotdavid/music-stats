# Providers

A provider is a source of listening history. `music-stats` reads Last.fm,
YouTube Music, or both. Set the variables of the providers you want, as
[Configuration](configuration.md) describes.

With both set, `music-stats` merges the plays and counts them together. A track
is the pair of artist and title, compared exactly. If one provider fails, the
program logs a warning and publishes the other's plays. It fails only when every
configured provider fails.

## Last.fm

Last.fm collects plays from Spotify, Tidal, Deezer and other services, so it
covers most listeners.

Variables: `LASTFM_API_KEY` and `LASTFM_USERNAME`. Get a key at
<https://www.last.fm/api>.

[`src/providers/lastfm.rs`](../src/providers/lastfm.rs) calls the
`user.getrecenttracks` method for plays from the last `DAYS` days:

- It reads 200 tracks per page and waits 200 ms between pages.
- It stops after 10 pages, which is 2000 plays. If Last.fm has more, the program
  logs a warning and the older plays are missing from the count.
- It skips the track that is playing now, because Last.fm gives it no date.

## YouTube Music

Variable: `YOUTUBE_COOKIE`. Its value is the `Cookie` request header your
browser sends to `music.youtube.com` while you are signed in. It must contain
`__Secure-3PAPISID`.

[`src/providers/youtube_http.rs`](../src/providers/youtube_http.rs) requests
<https://music.youtube.com/history> with:

- A `Cookie` header made from your cookie. It removes the characters U+0100 to
  U+FFFF, collapses runs of whitespace, and appends `SOCS=CAI` if the cookie has
  no `SOCS` value.
- An `Authorization: SAPISIDHASH <timestamp>_<hash>` header. The hash is the
  SHA-1 of `<timestamp> <__Secure-3PAPISID> https://music.youtube.com`.

A reply with an error status fails the provider with
`YouTube authentication failed: HTTP <status>`.

An expired cookie can still get a page back, without any history. A page with no
plays at all fails the provider with
`YouTube history failed: No plays found on the history page; the cookie may have expired`,
so an expired cookie never empties the Gist. Copy a fresh cookie from your
browser. Plays that are all older than `DAYS` days are not an error.

[`src/providers/youtube_parse.rs`](../src/providers/youtube_parse.rs) takes the
history data out of the page, and decodes its `\xNN` escapes as UTF-8, so titles
and artists keep their non-ASCII characters.
[`src/providers/youtube_json.rs`](../src/providers/youtube_json.rs) reads the
data. The history groups plays under date headings, and the page gives no time
of day, so each play takes the date of its heading, at 12:00 UTC:

| Heading                                               | Date used                    |
| ----------------------------------------------------- | ---------------------------- |
| Today (English, Spanish, Portuguese, Italian, French) | Today, in UTC.               |
| Yesterday (same languages)                            | Yesterday, in UTC.           |
| Last week (English, Spanish, Portuguese)              | Four days before today, UTC. |
| A `YYYY-MM-DD` date                                   | That date.                   |
| Anything else                                         | Dropped.                     |

For a dropped heading, a `warn` log names the heading and how many plays it
held.

A play counts if its timestamp is no more than `DAYS` times 24 hours old.
Because the timestamp is noon UTC, a play from yesterday is dropped with
`DAYS=1` once it is past noon UTC today. A play with no artist link is listed as
`Unknown Artist`. A play with no title link is skipped.
