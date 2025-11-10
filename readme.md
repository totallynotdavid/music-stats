# [pkg]: gist (last.fm)

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
2. Get a Last.fm API key from https://www.last.fm/api
3. For local development, copy `.env` and fill in your values:
   - `GIST_ID`: Your gist ID (from URL)
   - `GH_TOKEN`: GitHub token with `gist` scope
   - `LASTFM_API_KEY`: Your Last.fm API key
   - `LASTFM_USER`: Your Last.fm username
4. For CI/CD, add the above as secrets to your GitHub repository

To build the project, just run: `cargo build`

To run locally: `cargo run` (after setting up .env)
