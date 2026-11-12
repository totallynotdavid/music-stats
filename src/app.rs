use crate::config::{Config, GistConfig, UploadConfig};
use crate::errors::Error;
use crate::providers::types::{self, Scrobble, YouTubePlay};
use crate::{aggregate, output, providers};

#[derive(Debug)]
pub struct Fetched {
    pub scrobbles: Vec<Scrobble>,
    pub youtube_plays: Vec<YouTubePlay>,
    pub failed: Vec<&'static str>,
}

pub async fn run(client: &reqwest::Client, config: &Config) -> Result<(), Error> {
    let fetched = fetch_plays(
        client,
        config,
        providers::lastfm::DEFAULT_BASE_URL,
        providers::youtube_http::DEFAULT_BASE_URL,
    )
    .await?;

    let mut errors = Vec::new();

    if let Some(gist) = &config.gist
        && let Err(error) = update_gist(client, config, gist, fetched.scrobbles).await
    {
        errors.push(error);
    }

    if let Some(upload) = &config.upload {
        if fetched.failed.contains(&"YouTube") {
            tracing::warn!("Skipping the upload: YouTube Music returned no plays");
        } else if let Err(error) = send_upload(client, upload, &fetched.youtube_plays).await {
            errors.push(error);
        }
    }

    let mut errors = errors.into_iter();
    if let Some(first) = errors.next() {
        for error in errors {
            tracing::error!("{}", error);
        }
        return Err(first);
    }

    if fetched.failed.is_empty() {
        Ok(())
    } else {
        Err(Error::SomeProvidersFailed {
            providers: fetched.failed,
        })
    }
}

async fn update_gist(
    client: &reqwest::Client,
    config: &Config,
    gist: &GistConfig,
    scrobbles: Vec<Scrobble>,
) -> Result<(), Error> {
    tracing::info!("Counting {} scrobbles for the Gist", scrobbles.len());
    let statistics = aggregate::compute_statistics(scrobbles, config.top_n);
    tracing::info!(
        "{} plays, {} unique tracks",
        statistics.total_plays,
        statistics.unique_tracks
    );
    let formatted = output::format::format_statistics(&statistics);

    output::github::upload_gist(
        client,
        output::github::DEFAULT_BASE_URL,
        &gist.id,
        &gist.token,
        &formatted,
    )
    .await?;
    tracing::info!("Updated gist successfully");
    Ok(())
}

async fn send_upload(
    client: &reqwest::Client,
    upload: &UploadConfig,
    plays: &[YouTubePlay],
) -> Result<(), Error> {
    let request = output::upload::build_request(plays);
    tracing::info!(
        "Uploading {} of {} YouTube plays to {}",
        request.plays.len(),
        plays.len(),
        upload.url
    );

    let reply = output::upload::upload_plays(client, &upload.url, &upload.token, &request).await?;
    tracing::info!(
        "Upload accepted: {} received, {} inserted, {} duplicate",
        reply.received,
        reply.inserted,
        reply.duplicate
    );
    if reply.gap {
        tracing::warn!("The service reports a gap: plays since the last upload may be missing");
    }
    if reply.ambiguous > 0 {
        tracing::warn!(
            "The service could not tell {} plays of repeated songs apart",
            reply.ambiguous
        );
    }
    Ok(())
}

pub async fn fetch_plays(
    client: &reqwest::Client,
    config: &Config,
    lastfm_base_url: &str,
    youtube_base_url: &str,
) -> Result<Fetched, Error> {
    let mut scrobbles = Vec::new();
    let mut youtube_plays = Vec::new();
    let mut attempted = 0;
    let mut failed = Vec::new();

    if let Some(lastfm) = config.provider.lastfm() {
        if config.gist.is_some() {
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
        } else {
            tracing::warn!("Ignoring Last.fm: it feeds the Gist, and no Gist is configured");
        }
    }

    if let Some(cookie) = config.provider.youtube_cookie() {
        attempted += 1;
        match providers::youtube::fetch_plays(client, youtube_base_url, cookie, config.timezone)
            .await
        {
            Ok(plays) => {
                tracing::info!("YouTube: {} plays on the page", plays.len());
                if config.gist.is_some() {
                    let cutoff = types::cutoff(config.days);
                    scrobbles.extend(
                        plays
                            .iter()
                            .filter(|play| play.scrobble.played_at >= cutoff)
                            .map(|play| play.scrobble.clone()),
                    );
                }
                youtube_plays = plays;
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

    Ok(Fetched {
        scrobbles,
        youtube_plays,
        failed,
    })
}
