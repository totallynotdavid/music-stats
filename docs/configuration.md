# Configuration

`music-stats` reads its settings from environment variables. It also loads a
`.env` file from the current directory or a parent directory, if one exists. A
variable already set in the environment wins over the same variable in `.env`.
[`.env.example`](../.env.example) lists every variable.

## Variables

| Variable          | Required      | Default | Meaning                                         |
| ----------------- | ------------- | ------- | ----------------------------------------------- |
| `GIST_ID`         | yes           |         | ID of the Gist to update.                       |
| `GH_TOKEN`        | yes           |         | GitHub token with the Gists permission.         |
| `LASTFM_API_KEY`  | with `LASTFM_USERNAME` |         | Last.fm API key.                                |
| `LASTFM_USERNAME` | with `LASTFM_API_KEY`  |         | Last.fm username.                               |
| `YOUTUBE_COOKIE`  | see below     |         | Cookie header of a signed-in YouTube Music tab. |
| `DAYS`            | no            | `7`     | How many days of history to read. At least 1.   |
| `TOP_N`           | no            | `5`     | How many tracks to list. At least 1.            |
| `RUST_LOG`        | no            | `info`  | Log level, in the `tracing` filter syntax.      |

At least one provider must be configured: both Last.fm variables, or
`YOUTUBE_COOKIE`. A Last.fm provider needs both its variables. If only one is
set, `music-stats` ignores it.

A variable that is empty or only whitespace counts as not set. `DAYS` and
`TOP_N` must then be unset or a whole number of at least 1. Whitespace around
the number is allowed.

## Logging

`music-stats` logs to standard output. At the default level it reports how many
plays each provider returned, the total (`<N> plays, <M> unique tracks`) before
the upload, and whether the Gist was updated. A provider that fails is logged at
`warn`.

## Errors

`music-stats` prints `Error: <message>` to standard error and exits with status
1 when it cannot finish. It exits with status 0 after updating the Gist.

| Message starts with                     | Cause                                                         |
| --------------------------------------- | ------------------------------------------------------------- |
| `Missing required environment variable` | `GIST_ID` or `GH_TOKEN` is not set.                           |
| `No music providers configured`         | No complete provider is set.                                  |
| `Invalid DAYS` / `Invalid TOP_N`        | The value is not a whole number, or is 0.                     |
| `All configured music providers failed` | Every configured provider failed. The `warn` log says why.    |
| `Failed to update gist`                 | GitHub rejected the update. The message includes the reply.   |
| `Network error accessing`               | A request did not complete, or a reply could not be read.     |
| `YouTube history failed`                | The history page has no plays. See [Providers](providers.md). |

Each request times out after 30 seconds. Messages about Last.fm name the base
URL of the API, never the request URL, so they do not contain your API key.
