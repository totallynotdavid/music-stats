mod config;
mod domain;
mod format;
mod github;
mod lastfm;

use anyhow::Result;
use tracing::info;
use tracing_subscriber::FmtSubscriber;

#[tokio::main]
async fn main() -> Result<()> {
    dotenv::dotenv().ok();
    tracing::subscriber::set_global_default(FmtSubscriber::default())?;

    let config = config::load_from_env()?;

    info!(
        "Fetching scrobbles for {} (last {} days)",
        config.lastfm_user, config.days
    );

    let scrobbles = lastfm::fetch_scrobbles(&config).await?;
    let mut tracks = domain::aggregate_scrobbles(scrobbles);
    tracks.truncate(config.top_n);

    info!("Found {} top tracks", tracks.len());

    let content = format::format_tracks(&tracks);
    github::update_gist(&config, content).await?;

    info!("Gist updated successfully");
    Ok(())
}
