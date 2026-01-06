use crate::errors::Error;
use crate::providers::types::Scrobble;
use chrono::{TimeZone, Utc};
use serde::Deserialize;
use std::time::Duration;
use tokio::time::sleep;

const PAGE_LIMIT: usize = 200;
const MAX_PAGES: usize = 10;
const RATE_LIMIT_MS: u64 = 200;

pub async fn fetch_scrobbles(
    client: &reqwest::Client,
    api_key: &str,
    username: &str,
    days: u64,
) -> Result<Vec<Scrobble>, Error> {
    let from_timestamp = calculate_timestamp(days);
    let tracks = fetch_all_pages(client, api_key, username, from_timestamp).await?;
    Ok(tracks.into_iter().filter_map(parse_track).collect())
}

async fn fetch_all_pages(
    client: &reqwest::Client,
    api_key: &str,
    username: &str,
    from: u64,
) -> Result<Vec<ApiTrack>, Error> {
    let mut all_tracks = Vec::new();
    let mut page = 1;

    loop {
        let response = fetch_page(client, api_key, username, page, from).await?;
        all_tracks.extend(response.recenttracks.track);

        let total_pages = response
            .recenttracks
            .attr
            .and_then(|a| a.total_pages.parse().ok())
            .unwrap_or(1);

        if page >= total_pages || page >= MAX_PAGES {
            break;
        }

        if total_pages > 1 {
            tracing::info!("Fetching Last.fm page {}/{}", page + 1, total_pages);
        }

        page += 1;
        sleep(Duration::from_millis(RATE_LIMIT_MS)).await;
    }

    Ok(all_tracks)
}

async fn fetch_page(
    client: &reqwest::Client,
    api_key: &str,
    username: &str,
    page: usize,
    from: u64,
) -> Result<ApiResponse, Error> {
    let url = format!(
        "https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user={}&api_key={}&limit={}&from={}&page={}&format=json",
        username, api_key, PAGE_LIMIT, from, page
    );

    let response = client.get(&url).send().await.map_err(|e| Error::Network {
        url: url.clone(),
        source: e,
    })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(Error::LastFm { status, url, body });
    }

    response
        .json()
        .await
        .map_err(|e| Error::Network { url, source: e })
}

fn parse_track(track: ApiTrack) -> Option<Scrobble> {
    let timestamp: i64 = track.date?.uts.parse().ok()?;
    let played_at = Utc.timestamp_opt(timestamp, 0).single()?;
    Some(Scrobble::new(track.artist.text, track.name, played_at))
}

fn calculate_timestamp(days: u64) -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("System time before UNIX epoch")
        .as_secs();
    now.saturating_sub(days * 86400)
}

#[derive(Debug, Deserialize)]
struct ApiResponse {
    recenttracks: RecentTracks,
}

#[derive(Debug, Deserialize)]
struct RecentTracks {
    track: Vec<ApiTrack>,
    #[serde(rename = "@attr")]
    attr: Option<PageAttr>,
}

#[derive(Debug, Deserialize)]
struct PageAttr {
    #[serde(rename = "totalPages")]
    total_pages: String,
}

#[derive(Debug, Deserialize)]
struct ApiTrack {
    name: String,
    artist: ArtistInfo,
    date: Option<DateInfo>,
}

#[derive(Debug, Deserialize)]
struct ArtistInfo {
    #[serde(rename = "#text")]
    text: String,
}

#[derive(Debug, Deserialize)]
struct DateInfo {
    uts: String,
}
