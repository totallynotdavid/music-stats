use crate::errors::Error;
use crate::providers::types::YouTubePlay;
use reqwest::StatusCode;
use reqwest::header::RETRY_AFTER;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_URL: &str = "https://music.rising.sh";

const UPLOAD_PATH: &str = "/api/v1/upload";
const MAX_PLAYS: usize = 1000;
const MAX_TEXT_CHARS: usize = 512;
const MAX_REPORTED_INDEXES: usize = 20;
const CLIENT: &str = concat!("music-stats/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct UploadRequest {
    pub client: &'static str,
    pub plays: Vec<UploadPlay>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct UploadPlay {
    pub day: String,
    pub artist: String,
    pub title: String,
    pub video_id: String,
}

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct UploadReply {
    pub received: u64,
    pub inserted: u64,
    pub duplicate: u64,
    pub gap: bool,
    pub ambiguous: u64,
}

pub fn build_request(plays: &[YouTubePlay]) -> UploadRequest {
    let plays = plays
        .iter()
        .filter_map(to_upload_play)
        .take(MAX_PLAYS)
        .collect();

    UploadRequest {
        client: CLIENT,
        plays,
    }
}

fn to_upload_play(play: &YouTubePlay) -> Option<UploadPlay> {
    let day = play.day?;
    let video_id = play.video_id.clone()?;
    let track = &play.scrobble.track;
    if track.artist.is_empty() || track.title.is_empty() {
        return None;
    }

    Some(UploadPlay {
        day: day.format("%Y-%m-%d").to_string(),
        artist: track.artist.chars().take(MAX_TEXT_CHARS).collect(),
        title: track.title.chars().take(MAX_TEXT_CHARS).collect(),
        video_id,
    })
}

pub async fn upload_plays(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    request: &UploadRequest,
) -> Result<UploadReply, Error> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), UPLOAD_PATH);

    let response = client
        .post(&url)
        .bearer_auth(token)
        .header(reqwest::header::USER_AGENT, CLIENT)
        .json(request)
        .send()
        .await
        .map_err(|e| Error::Network {
            url: url.clone(),
            source: e,
        })?;

    let status = response.status();
    if !status.is_success() {
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(String::from);
        let body = response.text().await.unwrap_or_default();
        return Err(Error::Upload {
            url,
            status: status.as_u16(),
            cause: cause(status, retry_after.as_deref(), &body),
        });
    }

    let text = response.text().await.map_err(|e| Error::Network {
        url: url.clone(),
        source: e,
    })?;
    Ok(serde_json::from_str(&text).unwrap_or_else(|error| {
        tracing::warn!(
            "The upload was accepted, but its reply is unreadable ({:?})",
            error.classify()
        );
        UploadReply::default()
    }))
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct RefusedReply {
    errors: Vec<RefusedItem>,
}

#[derive(Deserialize)]
struct RefusedItem {
    index: u64,
}

fn refused_indexes(body: &str) -> Vec<u64> {
    serde_json::from_str::<RefusedReply>(body)
        .unwrap_or_default()
        .errors
        .iter()
        .map(|item| item.index)
        .take(MAX_REPORTED_INDEXES)
        .collect()
}

fn cause(status: StatusCode, retry_after: Option<&str>, body: &str) -> String {
    match status {
        StatusCode::UNAUTHORIZED => {
            "UPLOAD_TOKEN is unknown or revoked. Create a new token on the settings page"
                .to_string()
        }
        StatusCode::PAYLOAD_TOO_LARGE => "the body is over the service's 256 KiB limit".to_string(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE => {
            "the service accepts only Content-Type: application/json and no Content-Encoding"
                .to_string()
        }
        StatusCode::UNPROCESSABLE_ENTITY => {
            let indexes = refused_indexes(body);
            if indexes.is_empty() {
                "the service refused the plays and stored none".to_string()
            } else {
                let list: Vec<String> = indexes.iter().map(u64::to_string).collect();
                format!(
                    "the service refused the plays and stored none. Failing items: {}",
                    list.join(", ")
                )
            }
        }
        StatusCode::TOO_MANY_REQUESTS => match retry_after {
            Some(seconds) => format!(
                "the service takes one upload per source every 30 seconds. Retry after {seconds} seconds"
            ),
            None => "the service takes one upload per source every 30 seconds".to_string(),
        },
        StatusCode::CONFLICT => "two uploads raced. Run again".to_string(),
        _ => "the service sent an unexpected reply".to_string(),
    }
}
