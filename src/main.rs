mod github;
mod spotify;
mod types;

use anyhow::Result;
use github::GitHubClient;
use spotify::SpotifyClient;
use types::{Config, Track};

#[tokio::main]
async fn main() -> Result<()> {
    dotenv::dotenv().ok();

    let config = Config::from_env()?;

    let spotify = SpotifyClient::new(&config).await?;
    let tracks = spotify.get_top_tracks(10).await?;

    let content = format_tracks(&tracks);

    let github = GitHubClient::new(&config);
    github.update_gist(&config.gist_id, content).await?;

    println!("Successfully updated gist with {} tracks", tracks.len());
    Ok(())
}

fn format_tracks(tracks: &[Track]) -> String {
    let mut content = String::new();

    for (i, track) in tracks.iter().enumerate() {
        let artists = track
            .artists
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");

        content.push_str(&format!(
            "{}. **[{}]({})** by {}\n",
            i + 1,
            track.name,
            track.external_urls.spotify,
            artists
        ));
    }

    content
}
