use crate::config::{Config, LastFmConfig};
use crate::domain::Scrobble;
use crate::errors::Error;
use crate::{domain, output, providers};

pub async fn run(config: &Config) -> Result<(), Error> {
    let scrobbles = fetch_from_all_providers(config).await;
    let statistics = domain::aggregate_scrobbles(scrobbles, config.top_n);
    let formatted_output = output::format::stats_to_text(&statistics);
    output::github::upload_to_gist(&config.gist_id, &config.github_token, &formatted_output).await?;
    
    tracing::info!("Updated gist successfully");
    Ok(())
}

async fn fetch_from_all_providers(config: &Config) -> Vec<Scrobble> {
    let mut scrobbles = Vec::new();
    
    if let Some(lastfm_config) = &config.lastfm {
        scrobbles.extend(fetch_lastfm(lastfm_config, config.days).await);
    }
    
    if let Some(youtube_cookie) = &config.youtube_cookie {
        scrobbles.extend(fetch_youtube(youtube_cookie, config.days).await);
    }
    
    scrobbles
}

async fn fetch_lastfm(config: &LastFmConfig, days: u64) -> Vec<Scrobble> {
    match providers::lastfm::fetch_scrobbles(&config.api_key, &config.username, days).await {
        Ok(scrobbles) => {
            tracing::info!("Last.fm: {} scrobbles", scrobbles.len());
            scrobbles
        }
        Err(error) => {
            tracing::warn!("Last.fm failed: {}", error);
            Vec::new()
        }
    }
}

async fn fetch_youtube(cookie: &str, days: u64) -> Vec<Scrobble> {
    match providers::youtube::fetch_scrobbles(cookie, days).await {
        Ok(scrobbles) => {
            tracing::info!("YouTube: {} scrobbles", scrobbles.len());
            scrobbles
        }
        Err(error) => {
            tracing::warn!("YouTube failed: {}", error);
            Vec::new()
        }
    }
}
