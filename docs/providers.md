# Providers

A provider is a source of listening history. `music-stats` reads Last.fm,
YouTube Music, or both. Set the variables of the providers you want, as
[Configuration](configuration.md) describes.

With both set, `music-stats` merges the plays and counts them together. A track
is the pair of artist and title, compared exactly. If one provider fails, the
program logs the reason, publishes the other's plays, and then exits with an
error that names the failed provider, so a scheduled run shows as failed. When
every configured provider fails, it leaves the Gist unchanged.

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

A cookie that is no longer signed in still gets a page back, with no history.
The page carries a `"LOGGED_IN":false` flag, and the provider then fails with
`YouTube authentication failed: YouTube Music answered as signed out; copy a fresh YOUTUBE_COOKIE`.
A page with no `LOGGED_IN` flag at all fails the same way, because YouTube Music
may have changed its page. A signed-in page with an empty history, or with only
plays older than `DAYS` days, is not an error.

### Keep the cookie working

Google ends a session when the browser that owns it keeps using it, because the
browser rotates the session cookies and the copy you exported falls behind.
Export the cookie from a session that no browser uses afterwards:

1. Open a private window and sign in to <https://music.youtube.com>.
2. Open the developer tools, select the Network tab and reload the page.
3. Select the request to `music.youtube.com`, and copy the value of its `Cookie`
   request header into `YOUTUBE_COOKIE`.
4. Close the private window without signing out. Signing out ends the session.

A cookie exported this way keeps working for months, until Google ends the
session. Google can also tie the session to the network it was created on, so a
cookie may stop working sooner when it is used from somewhere else, such as a
GitHub Actions runner.

YouTube Music has no other way in for a program like this. Google's OAuth device
flow for YouTube Music has refused new tokens since August 2025.

[`src/providers/youtube_parse.rs`](../src/providers/youtube_parse.rs) takes the
history data out of the page, and decodes its `\xNN` escapes as UTF-8, so titles
and artists keep their non-ASCII characters.
[`src/providers/youtube_json.rs`](../src/providers/youtube_json.rs) reads the
data. The history groups plays under date headings, and the page gives no time
of day, so each play takes the date of its heading, at 12:00 UTC:

| Heading                                                   | Date used                     |
| --------------------------------------------------------- | ----------------------------- |
| Today (English, Spanish, Portuguese, Italian, French)     | Today, in UTC.                |
| Yesterday (same languages)                                | Yesterday, in UTC.            |
| This week (same languages)                                | Three days before today, UTC. |
| Last week (same languages)                                | Four days before today, UTC.  |
| A month and year, such as `October 2026` (same languages) | The 15th of that month.       |
| A `YYYY-MM-DD` date                                       | That date.                    |
| Anything else                                             | Dropped.                      |

The week and month headings span several days, so their plays share one date. A
month heading holds plays older than Last week, so for the current month the
date moves back to 14 days before today, but never before the 1st. For a dropped
heading, a `warn` log names the heading and how many plays it held.

The headings follow the language of your Google account, not of the page
request.

A play counts if its timestamp is no more than `DAYS` times 24 hours old.
Because the timestamp is noon UTC, a play from yesterday is dropped with
`DAYS=1` once it is past noon UTC today. A play with no artist link is listed as
`Unknown Artist`. A play with several artist links is listed under the first
one. A play with no title link is skipped.
