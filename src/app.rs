use crate::config::Config;
use crate::errors::Error;
use crate::providers::types::Scrobble;
use crate::{aggregate, output, providers};

pub async fn run(client: &reqwest::Client, config: &Config) -> Result<(), Error> {
    let scrobbles = fetch_scrobbles(
        client,
        config,
        providers::lastfm::DEFAULT_BASE_URL,
        providers::youtube_http::DEFAULT_BASE_URL,
    )
    .await?;
    tracing::info!("Fetched {} total scrobbles", scrobbles.len());

    let statistics = aggregate::compute_statistics(scrobbles, config.top_n);
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

    Ok(())
}

/// Fetches scrobbles from every configured provider. A provider that fails is
/// logged at `warn` and skipped so the others can still publish; the overall
/// fetch only fails once every configured provider has failed.
pub async fn fetch_scrobbles(
    client: &reqwest::Client,
    config: &Config,
    lastfm_base_url: &str,
    youtube_base_url: &str,
) -> Result<Vec<Scrobble>, Error> {
    let mut all_scrobbles = Vec::new();
    let mut attempted = 0;
    let mut failed = 0;

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
            Ok(scrobbles) => {
                tracing::info!("Last.fm: {} scrobbles", scrobbles.len());
                all_scrobbles.extend(scrobbles);
            }
            Err(error) => {
                tracing::warn!("Last.fm fetch failed: {}", error);
                failed += 1;
            }
        }
    }

    if let Some(cookie) = config.provider.youtube_cookie() {
        attempted += 1;
        match providers::youtube::fetch_scrobbles(client, youtube_base_url, cookie, config.days)
            .await
        {
            Ok(scrobbles) => {
                tracing::info!("YouTube: {} scrobbles", scrobbles.len());
                all_scrobbles.extend(scrobbles);
            }
            Err(error) => {
                tracing::warn!("YouTube fetch failed: {}", error);
                failed += 1;
            }
        }
    }

    if attempted > 0 && failed == attempted {
        return Err(Error::AllProvidersFailed);
    }

    Ok(all_scrobbles)
}
