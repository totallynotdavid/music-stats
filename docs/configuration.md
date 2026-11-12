# Configuration

`music-stats` reads its settings from environment variables. It also loads a
`.env` file from the current directory or a parent directory, if one exists. A
variable already set in the environment wins over the same variable in `.env`.
[`.env.example`](../.env.example) lists every variable.

## Variables

| Variable          | Required               | Default                   | Meaning                                                                                             |
| ----------------- | ---------------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| `GIST_ID`         | with `GH_TOKEN`        |                           | ID of the Gist to update.                                                                           |
| `GH_TOKEN`        | with `GIST_ID`         |                           | GitHub token with the Gists permission.                                                             |
| `UPLOAD_TOKEN`    | no                     |                           | Token that lets the upload write your YouTube Music plays to the service.                           |
| `UPLOAD_URL`      | no                     | `https://music.rising.sh` | Address of the service that receives the upload.                                                    |
| `LASTFM_API_KEY`  | with `LASTFM_USERNAME` |                           | Last.fm API key.                                                                                    |
| `LASTFM_USERNAME` | with `LASTFM_API_KEY`  |                           | Last.fm username.                                                                                   |
| `YOUTUBE_COOKIE`  | see below              |                           | Cookie header of a signed-in YouTube Music tab.                                                     |
| `MUSIC_STATS_TZ`  | no                     | `UTC`                     | IANA time zone name, such as `America/Lima`, that YouTube Music's "Today" and "Yesterday" refer to. |
| `DAYS`            | no                     | `7`                       | How many days of history the Gist counts. At least 1.                                               |
| `TOP_N`           | no                     | `5`                       | How many tracks to list. At least 1.                                                                |
| `RUST_LOG`        | no                     | `info`                    | Log level, in the `tracing` filter syntax.                                                          |

At least one output must be configured: the Gist (`GIST_ID` with `GH_TOKEN`), or
the upload (`UPLOAD_TOKEN`). Both can run in one run. The Gist and the upload
are independent: if one fails, the other still runs, and the run exits 1.

At least one provider must be configured: both Last.fm variables, or
`YOUTUBE_COOKIE`. A Last.fm provider needs both its variables. If only one is
set, `music-stats` ignores it.

`UPLOAD_TOKEN` needs `YOUTUBE_COOKIE`, because the upload sends only YouTube
Music plays. Last.fm feeds the Gist, so without a Gist `music-stats` does not
fetch it.

A variable that is empty or only whitespace counts as not set. Whitespace around
a value, such as the newline a pasted token often carries, is removed. `DAYS`
and `TOP_N` must be unset or a whole number of at least 1. A `DAYS` larger than
the history that exists reads all of it.

[Output](output.md#upload) says what the upload sends.

## Logging

`music-stats` logs to standard output. At the default level it reports how many
plays each provider returned, the total (`<N> plays, <M> unique tracks`) before
the Gist update, whether the Gist was updated, and the outcome of the upload. A
provider that fails is logged at `error` with the reason. No log line holds a
cookie or a token. The upload errors never repeat the service's reply, so a
service that echoes the request cannot put your token in a log.

## Errors

`music-stats` prints `Error: <message>` to standard error and exits with status
1 when it cannot finish, or when it wrote the outputs without a provider that
failed. It exits with status 0 after writing every configured output with every
configured provider.

| Message starts with                     | Cause                                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Missing required environment variable` | Only one of `GIST_ID` and `GH_TOKEN` is set.                                                                                                                    |
| `No output configured`                  | Neither the Gist nor `UPLOAD_TOKEN` is set.                                                                                                                     |
| `No music providers configured`         | No complete provider is set.                                                                                                                                    |
| `Invalid DAYS` / `Invalid TOP_N`        | The value is not a whole number, or is 0.                                                                                                                       |
| `Invalid MUSIC_STATS_TZ`                | The value is not an IANA time zone name.                                                                                                                        |
| `Invalid UPLOAD_TOKEN`                  | `UPLOAD_TOKEN` is set without `YOUTUBE_COOKIE`.                                                                                                                 |
| `All configured music providers failed` | Every provider that was fetched failed. The `error` log says why. No output was written.                                                                        |
| `Finished without`                      | The named provider failed. The Gist, if configured, holds only the other's plays, and the upload did not run if YouTube Music failed. The `error` log says why. |
| `Failed to update gist`                 | GitHub rejected the update. The message includes the reply.                                                                                                     |
| `Upload to`                             | The service refused the upload. See below.                                                                                                                      |
| `Network error accessing`               | A request did not complete, or a reply could not be read.                                                                                                       |

An `Upload to` message ends with its cause:

| Status | Cause                                                                                      |
| ------ | ------------------------------------------------------------------------------------------ |
| 401    | `UPLOAD_TOKEN` is unknown or revoked. Create a new token.                                  |
| 409    | Two uploads raced. Run again.                                                              |
| 413    | The body is over the service's 256 KiB limit.                                              |
| 415    | The service accepts only `application/json` without `Content-Encoding`.                    |
| 422    | The service refused the plays and stored none. The message lists the failing item numbers. |
| 429    | One upload per source every 30 seconds. The message gives `Retry-After`.                   |
| Other  | The service sent an unexpected reply. The message does not repeat it.                      |

A YouTube log of `YouTube authentication failed` means the cookie no longer
works. [Providers](providers.md#keep-the-cookie-working) says how to export one
that lasts.

Each request times out after 30 seconds. Messages about Last.fm name the base
URL of the API, never the request URL, so they do not contain your API key.
