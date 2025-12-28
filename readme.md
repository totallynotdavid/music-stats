# [pkg]: last.fm to gist

A tool that saves your last.fm listening history to a GitHub Gist. It is written
in Rust and can run either as a GitHub Action or as a manual script.

Before you start, you will need:

- A last.fm API key from https://www.last.fm/api
- A public GitHub Gist created at https://gist.github.com (copy the Gist ID from
  the URL)
- A GitHub personal access token from
  https://github.com/settings/personal-access-tokens/new with the Gists
  permission

To run this as a GitHub Action, create a repository from the template at  
https://github.com/new?template_name=music-stats&template_owner=totallynotdavid.

Open the repository’s Actions secrets settings at  
https://github.com/[username]/[repo]/settings/secrets/actions and add:

- `GIST_ID`
- `GH_TOKEN`
- `LASTFM_API_KEY`
- `LASTFM_USER`

The action runs on the schedule defined in `.github/workflows/gist.yml`. Edit
the cron expression to change the update frequency, or trigger it manually from
the Actions tab.

To run the tool manually, install the binary with cargo:

```bash
cargo install --git https://github.com/totallynotdavid/music-stats
```

Set the required environment variables and run:

```bash
export GIST_ID=
export GH_TOKEN=
export LASTFM_API_KEY=
export LASTFM_USER=
music-stats
```

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
