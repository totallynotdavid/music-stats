# [pkg]: music stats archive

[![Crates.io](https://img.shields.io/crates/v/music-stats?label=crates.io&logo=rust&color=orange)](https://crates.io/crates/music-stats)
[![docs.rs](https://docs.rs/music-stats/badge.svg)](https://docs.rs/music-stats)
[![codecov](https://codecov.io/gh/totallynotdavid/music-stats/graph/badge.svg)](https://codecov.io/gh/totallynotdavid/music-stats)

Saves your music listening history to a GitHub Gist. Supports Last.fm (which
aggregates plays from Spotify, Tidal, Deezer, and other services) and YouTube
Music directly.

Before you start, you will need:

- A public GitHub Gist created at https://gist.github.com (copy the Gist ID from
  the URL)
- A GitHub personal access token from
  https://github.com/settings/personal-access-tokens/new with the Gists
  permission
- At least one provider:
  - Last.fm API key from https://www.last.fm/api and your username
  - YouTube Music cookie from your browser

## Setup

Create a repository from the template at
https://github.com/new?template_name=music-stats&template_owner=totallynotdavid.

Open the repository's Actions secrets settings at
https://github.com/[username]/[repo]/settings/secrets/actions and add:

- `GIST_ID`
- `GITHUB_TOKEN`
- `CODECOV_TOKEN` (optional — required for private repos to upload coverage)
- At least one provider:
  - `LASTFM_API_KEY` and `LASTFM_USERNAME`
  - `YOUTUBE_COOKIE`

The action runs on the schedule defined in `.github/workflows/gist.yml`. Edit
the cron expression to change the update frequency, or trigger it manually from
the Actions tab.

Optional configuration:

- `DAYS`: number of days to fetch (default: 7)
- `TOP_N`: number of top tracks to show (default: 5)

## Manual usage

Install the binary with cargo:

```bash
cargo install --git https://github.com/totallynotdavid/music-stats
```

Set the required environment variables and run:

```bash
export GIST_ID=
export GITHUB_TOKEN=
export LASTFM_API_KEY=       # optional if using YouTube
export LASTFM_USERNAME=      # optional if using YouTube
export YOUTUBE_COOKIE=       # optional if using Last.fm
music-stats
```

Optional configuration:

```bash
export DAYS=7                # number of days to fetch (default: 7)
export TOP_N=5               # number of top tracks to show (default: 5)
```

## Publishing

This crate supports Trusted Publishing to crates.io using GitHub Actions (OIDC).
The repository includes a release workflow that publishes tagged releases (e.g.,
`v1.0.0`) to crates.io — see `.github/workflows/release.yml`.

**Note:** the _initial_ publish requires a crates.io API token (use
`cargo publish --token` or set `CARGO_REGISTRY_TOKEN` as a secret); after
configuring Trusted Publishing in your crate's settings, subsequent publishes
can use the OIDC-based workflow.

## Local development

On WSL, install the required system dependencies:

```bash
sudo apt update
sudo apt install gcc pkg-config libssl-dev # gcc (around 200 mb) / openssl (around 20 mb)
```

Clone the repository and build:

```bash
git clone https://github.com/totallynotdavid/music-stats
cd music-stats
cargo build
```

Copy `.env.example` to `.env` and fill in your credentials.

Run the development build with `cargo run`, or build a release binary with
`cargo build --release`.
