mod github;
mod lastfm;
mod types;
mod format;

use anyhow::Result;
use github::GitHubClient;
use lastfm::LastFmClient;

const MAX_TRACKS_TO_FETCH: usize = 200; // limit by the last.fm API
const TOP_TRACKS_TO_DISPLAY: usize = 5;

#[tokio::main]
async fn main() -> Result<()> {
    dotenv::dotenv().ok();

    let config = types::Config::from_env()?;

    let lastfm = LastFmClient::new(&config);
    let tracks = lastfm.get_recent_tracks(MAX_TRACKS_TO_FETCH).await?;
    let total_tracks = tracks.len();

    let content = format::format_tracks(&tracks[..total_tracks.min(TOP_TRACKS_TO_DISPLAY)]);

    let github = GitHubClient::new(&config);
    github.update_gist(&config.gist_id, content).await?;

    println!(
        "Successfully updated gist with top {} tracks (from {} total)",
        TOP_TRACKS_TO_DISPLAY, total_tracks
    );
    Ok(())
}
