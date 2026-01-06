use std::time::Duration;
use tracing_subscriber::EnvFilter;

mod aggregate;
mod config;
mod errors;
mod output;
mod providers;

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    if let Err(error) = run().await {
        eprintln!("Error: {}", error);
        std::process::exit(1);
    }
}

async fn run() -> Result<(), errors::Error> {
    let config = config::load()?;
    let client = build_http_client();

    let scrobbles = fetch_scrobbles(&client, &config).await?;
    tracing::info!("Fetched {} total scrobbles", scrobbles.len());

    let statistics = aggregate::compute_statistics(scrobbles, config.top_n);
    let formatted = output::format::format_statistics(&statistics);

    output::github::upload_gist(&client, &config.gist_id, &config.github_token, &formatted).await?;
    tracing::info!("Updated gist successfully");

    Ok(())
}

async fn fetch_scrobbles(
    client: &reqwest::Client,
    config: &config::Config,
) -> Result<Vec<providers::types::Scrobble>, errors::Error> {
    let mut all_scrobbles = Vec::new();

    if let Some(lastfm) = config.provider.lastfm() {
        let scrobbles = providers::lastfm::fetch_scrobbles(
            client,
            &lastfm.api_key,
            &lastfm.username,
            config.days,
        )
        .await?;
        tracing::info!("Last.fm: {} scrobbles", scrobbles.len());
        all_scrobbles.extend(scrobbles);
    }

    if let Some(cookie) = config.provider.youtube_cookie() {
        let scrobbles = providers::youtube::fetch_scrobbles(client, cookie, config.days).await?;
        tracing::info!("YouTube: {} scrobbles", scrobbles.len());
        all_scrobbles.extend(scrobbles);
    }

    Ok(all_scrobbles)
}

fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .expect("Failed to build HTTP client")
}
