use crate::domain::{Scrobble, Track};
use crate::errors::Error;
use chrono::{TimeZone, Utc};
use serde::Deserialize;
use std::time::Duration;
use tokio::time::sleep;

const PAGE_LIMIT: usize = 200;
const MAX_PAGES: usize = 10;
const RATE_LIMIT_MILLIS: u64 = 200;

pub async fn fetch_scrobbles(
    api_key: &str,
    username: &str,
    days: u64,
) -> Result<Vec<Scrobble>, Error> {
    let client = crate::http::build_client();
    let from_timestamp = super::calculate_timestamp(days);
    let api_tracks = fetch_all_pages(&client, api_key, username, from_timestamp).await?;
    
    Ok(api_tracks
        .into_iter()
        .filter_map(|track| track.to_scrobble())
        .collect())
}

async fn fetch_all_pages(
    client: &reqwest::Client,
    api_key: &str,
    username: &str,
    from_timestamp: u64,
) -> Result<Vec<ApiTrack>, Error> {
    let mut all_tracks = Vec::new();
    let mut page = 1;
    
    loop {
        let response = fetch_page(client, api_key, username, page, from_timestamp).await?;
        all_tracks.extend(response.recenttracks.track);
        
        let total_pages = response
            .recenttracks
            .attr
            .and_then(|attr| attr.total_pages.parse().ok())
            .unwrap_or(1);
        
        if page >= total_pages || page >= MAX_PAGES {
            break;
        }
        
        if total_pages > 1 {
            tracing::info!("Fetching Last.fm page {}/{}...", page + 1, total_pages);
        }
        
        page += 1;
        sleep(Duration::from_millis(RATE_LIMIT_MILLIS)).await;
    }
    
    Ok(all_tracks)
}

async fn fetch_page(
    client: &reqwest::Client,
    api_key: &str,
    username: &str,
    page: usize,
    from_timestamp: u64,
) -> Result<ApiResponse, Error> {
    let url = format!(
        "https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user={}&api_key={}&limit={}&from={}&page={}&format=json",
        username, api_key, PAGE_LIMIT, from_timestamp, page
    );
    
    let http_response = client
        .get(&url)
        .send()
        .await
        .map_err(|source| Error::Network {
            url: url.clone(),
            source,
        })?;
    
    if !http_response.status().is_success() {
        let status = http_response.status().as_u16();
        let body = http_response.text().await.unwrap_or_default();
        return Err(Error::LastFmApi {
            status,
            message: body,
        });
    }
    
    http_response.json().await.map_err(|source| Error::Network {
        url,
        source,
    })
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

impl ApiTrack {
    fn to_scrobble(self) -> Option<Scrobble> {
        let date_info = self.date?;
        let timestamp: i64 = date_info.uts.parse().ok()?;
        let played_at = Utc.timestamp_opt(timestamp, 0).single()?;
        
        Some(Scrobble {
            track: Track {
                artist: self.artist.text,
                title: self.name,
            },
            played_at,
        })
    }
}
