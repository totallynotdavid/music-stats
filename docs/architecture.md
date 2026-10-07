# Architecture

`music-stats` fetches plays from one or two providers, counts them and writes
the top tracks to a Gist. It is a library crate with a thin binary, so the tests
in `tests/` can call every module.

```text
main → config::load → app::run
                        │
        ┌───────────────┴───────────────┐
  providers::lastfm             providers::youtube
        │                        youtube_http → youtube_parse → youtube_json
        └───────────────┬───────────────┘
                 Vec<Scrobble>
                        │
                aggregate::compute_statistics
                        │
                output::format → output::github
```

## Code map

| Path                             | Responsibility                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/main.rs`                    | Loads `.env`, starts logging, builds the HTTP client, calls `app::run`. Prints `Error: <message>` and exits 1 on failure.  |
| `src/lib.rs`                     | Exports the modules for the integration tests.                                                                             |
| `src/config.rs`                  | Reads and validates the environment into `Config`. `load_from` takes a map, so tests do not touch the process environment. |
| `src/app.rs`                     | The pipeline. `fetch_scrobbles` calls each configured provider and decides what a partial failure means.                   |
| `src/providers/types.rs`         | `Scrobble` (one play) and `Track` (artist and title).                                                                      |
| `src/providers/lastfm.rs`        | Fetches and pages through `user.getrecenttracks`.                                                                          |
| `src/providers/youtube.rs`       | Runs the YouTube steps in order, fails when the page has no plays, and drops plays older than `DAYS`.                      |
| `src/providers/youtube_http.rs`  | Builds the cookie and `SAPISIDHASH` header, and requests the history page.                                                 |
| `src/providers/youtube_parse.rs` | Extracts the embedded JSON string from the page and decodes its `\xNN` escapes to UTF-8.                                   |
| `src/providers/youtube_json.rs`  | Turns that JSON into `Scrobble`s. `parse_scrobbles_on` takes the current day, so tests do not depend on the clock.         |
| `src/aggregate.rs`               | Counts plays per `Track`, sorts by count, then artist, then title, and keeps the top `TOP_N`.                              |
| `src/output/format.rs`           | Renders `Statistics` as the text of the Gist file.                                                                         |
| `src/output/github.rs`           | Sends the text to the Gist.                                                                                                |
| `src/errors.rs`                  | The single `Error` type. Its `Display` text is the message the user sees.                                                  |

[Providers](providers.md), [Output](output.md) and
[Configuration](configuration.md) describe the behavior of these modules.

## Boundaries

- A provider returns `Vec<Scrobble>` and knows nothing about the others.
  `app.rs` is the only place that combines them.
- Every function that makes a request takes the base URL as an argument. The
  `DEFAULT_BASE_URL` constants hold the real addresses. Tests pass the address
  of a `wiremock` server instead.
- `app::fetch_scrobbles` counts a provider's failure and goes on. It returns
  `Error::AllProvidersFailed` only when every configured provider failed.

## Tests

The tests in `tests/` cover one module each and run without network access. The
ones that call a provider or the Gist use a local `wiremock` server.

`tests/fixtures/` holds a Last.fm response and a YouTube Music history page that
`scripts/fetch-fixtures.sh` downloaded. `tests/lastfm.rs`,
`tests/youtube_parse.rs` and `tests/youtube_json.rs` read them, and fail if a
fixture is missing. [Contributing](../.github/contributing.md) shows how to
refresh them.
