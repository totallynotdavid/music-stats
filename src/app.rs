use crate::config::Config;
use crate::errors::Error;
use crate::providers::types::Scrobble;
use crate::{aggregate, output, providers};

/// The plays of the providers that answered, and the names of those that failed.
#[derive(Debug)]
pub struct Fetched {
    pub scrobbles: Vec<Scrobble>,
    pub failed: Vec<&'static str>,
}

pub async fn run(client: &reqwest::Client, config: &Config) -> Result<(), Error> {
    let fetched = fetch_scrobbles(
        client,
        config,
        providers::lastfm::DEFAULT_BASE_URL,
        providers::youtube_http::DEFAULT_BASE_URL,
    )
    .await?;
    tracing::info!("Fetched {} total scrobbles", fetched.scrobbles.len());

    let statistics = aggregate::compute_statistics(fetched.scrobbles, config.top_n);
    tracing::info!(
        "{} plays, {} unique tracks",
        statistics.total_plays,
        statistics.unique_tracks
    );
    let formatted = output::format::format_statistics(&statistics);

    output::github::upload_gist(
        client,
        output::github::DEFAULT_BASE_URL,
        &config.gist_id,
        &config.github_token,
        &formatted,
    )
    .await?;
    tracing::info!("Updated gist successfully");

    if fetched.failed.is_empty() {
        Ok(())
    } else {
        Err(Error::SomeProvidersFailed {
            providers: fetched.failed,
        })
    }
}

pub async fn fetch_scrobbles(
    client: &reqwest::Client,
    config: &Config,
    lastfm_base_url: &str,
    youtube_base_url: &str,
) -> Result<Fetched, Error> {
    let mut scrobbles = Vec::new();
    let mut attempted = 0;
    let mut failed = Vec::new();

    if let Some(lastfm) = config.provider.lastfm() {
        attempted += 1;
        match providers::lastfm::fetch_scrobbles(
            client,
            lastfm_base_url,
            &lastfm.api_key,
            &lastfm.username,
            config.days,
        )
        .await
        {
            Ok(plays) => {
                tracing::info!("Last.fm: {} scrobbles", plays.len());
                scrobbles.extend(plays);
            }
            Err(error) => {
                tracing::error!("Last.fm fetch failed: {}", error);
                failed.push("Last.fm");
            }
        }
    }

    if let Some(cookie) = config.provider.youtube_cookie() {
        attempted += 1;
        match providers::youtube::fetch_scrobbles(client, youtube_base_url, cookie, config.days)
            .await
        {
            Ok(plays) => {
                tracing::info!("YouTube: {} scrobbles", plays.len());
                scrobbles.extend(plays);
            }
            Err(error) => {
                tracing::error!("YouTube fetch failed: {}", error);
                failed.push("YouTube");
            }
        }
    }

    if attempted > 0 && failed.len() == attempted {
        return Err(Error::AllProvidersFailed);
    }

    Ok(Fetched { scrobbles, failed })
}
