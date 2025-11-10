# [pkg]: gist (spotify)

Dependencies: If you're using WSL, install the required system packages the first time:

```bash
sudo apt update
sudo apt-get install gcc # gcc (around 200 mb)
sudo apt install pkg-config libssl-dev # openssl (around 20 mb in total)
```

Then install the Rust dependencies using Cargo:

```bash
cargo install --path .
```

You'll also need to:

1. Create a GitHub Gist at https://gist.github.com
2. Get Spotify credentials from https://developer.spotify.com
3. For local development, copy `.env` and fill in your values:
   - `GIST_ID`: Your gist ID (from URL)
   - `GH_TOKEN`: GitHub token with `gist` scope
   - `SPOTIFY_CLIENT_ID`: From Spotify Dashboard
   - `SPOTIFY_CLIENT_SECRET`: From Spotify Dashboard
   - `SPOTIFY_REFRESH_TOKEN`: Use Spotify auth flow to obtain
4. For CI/CD, add the above as secrets to your GitHub repository

To build the project, just run: `cargo build`

To run locally: `cargo run` (after setting up .env)
