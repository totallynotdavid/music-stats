use crate::errors::Error;
use crate::providers::types::YouTubePlay;
use crate::providers::{youtube_http, youtube_json, youtube_parse};
use chrono_tz::Tz;

pub async fn fetch_plays(
    client: &reqwest::Client,
    base_url: &str,
    cookie: &str,
    tz: Tz,
) -> Result<Vec<YouTubePlay>, Error> {
    let html = youtube_http::fetch_history_page(client, base_url, cookie).await?;
    youtube_parse::ensure_signed_in(&html)?;
    let json = youtube_parse::extract_json_from_html(&html)?;
    youtube_json::parse_plays(&json, tz)
}
