use super::api_types::{ApiResponse, ApiTrack};
use super::{MAX_PAGES, PAGE_LIMIT, RATE_LIMIT_MS};
use crate::config::Config;
use anyhow::{Context, Result};
use reqwest::Client;
use tracing::info;

pub async fn fetch_all_pages(
    client: &Client,
    config: &Config,
    from_timestamp: u64,
) -> Result<Vec<ApiTrack>> {
    let mut all_tracks = Vec::new();
    let mut page = 1;

    loop {
        let response = fetch_page(client, config, page, from_timestamp).await?;
        all_tracks.extend(response.recenttracks.track);

        let Some(attr) = response.recenttracks.attr else {
            break;
        };

        let total_pages: usize = attr.total_pages.parse().unwrap_or(1);

        if page >= total_pages || page >= MAX_PAGES {
            break;
        }

        if total_pages > 1 {
            info!("Fetching page {}/{}...", page + 1, total_pages);
        }

        page += 1;
        tokio::time::sleep(tokio::time::Duration::from_millis(RATE_LIMIT_MS)).await;
    }

    Ok(all_tracks)
}

async fn fetch_page(
    client: &Client,
    config: &Config,
    page: usize,
    from: u64,
) -> Result<ApiResponse> {
    let url = format!(
        "http://ws.audioscrobbler.com/2.0/\
         ?method=user.getrecenttracks\
         &user={}\
         &api_key={}\
         &limit={}\
         &from={}\
         &page={}\
         &format=json",
        config.lastfm_user, config.lastfm_api_key, PAGE_LIMIT, from, page
    );

    let response = client
        .get(&url)
        .header("User-Agent", "music-stats/0.1.0")
        .send()
        .await
        .context("Failed to send request to Last.fm")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Last.fm API error (status {}): {}", status, body);
    }

    response
        .json()
        .await
        .context("Failed to parse Last.fm response")
}
