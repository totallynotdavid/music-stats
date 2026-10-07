# Contributing

Thank you for considering a change. For anything beyond a small fix, open an
issue first so we can agree on the approach.

[Architecture](../docs/architecture.md) maps the code.

## Set up

You need a C compiler on your `PATH`, because the TLS library (`aws-lc-sys`)
builds C code. On Debian and Ubuntu, including WSL:

```sh
sudo apt update
sudo apt install gcc
```

[`mise.toml`](../mise.toml) pins the Rust toolchain, with `rustfmt` and
`clippy`. With [mise](https://mise.jdx.dev) installed:

```sh
git clone https://github.com/totallynotdavid/music-stats
cd music-stats
mise install
mise run build
```

Without mise, install the toolchain version in `mise.toml` and run
`cargo build`.

## Run it

Copy `.env.example` to `.env`, and fill in `GIST_ID`, `GH_TOKEN` and a provider.
`.env` is ignored by git. Then:

```sh
cargo run
```

`cargo build --release` builds the optimized binary at
`target/release/music-stats`. [Configuration](../docs/configuration.md) lists
every variable.

## Check your change

| Task            | mise             | cargo                                                    |
| --------------- | ---------------- | -------------------------------------------------------- |
| Format and lint | `mise run check` | `cargo fmt -- --check` and `cargo clippy -- -D warnings` |
| Test            | `mise run test`  | `cargo test`                                             |

To format, run `cargo fmt`. Pull requests run both tasks in
[CI](workflows/ci.yml).

The tests need no credentials and no network. To measure coverage, as
[`coverage.yml`](workflows/coverage.yml) does:

```sh
cargo llvm-cov --all-features --workspace --lcov --output-path lcov.info
```

This needs [`cargo-llvm-cov`](https://github.com/taiki-e/cargo-llvm-cov). The
workflow uploads the report to Codecov, with the `CODECOV_TOKEN` secret.

## Refresh the test fixtures

`tests/fixtures/` holds a real Last.fm response and a YouTube Music history
page. To download new ones, export the provider variables you have and run:

```sh
mise run fetch-fixtures
```

The script [`scripts/fetch-fixtures.sh`](../scripts/fetch-fixtures.sh) runs on
Linux and macOS and needs `curl` and `sha1sum` or `shasum`. It reads
`YOUTUBE_COOKIE`, and `LASTFM_API_KEY` with `LASTFM_USERNAME`. It overwrites
`history.html` and `recent_tracks.json` for the providers you set, and leaves
the other file alone.

## Release

[Releasing](../docs/releasing.md) describes how a tag publishes a version.
