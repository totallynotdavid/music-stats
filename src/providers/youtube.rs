use crate::errors::Error;
use crate::providers::types::Scrobble;
use crate::providers::{youtube_http, youtube_json, youtube_parse};
use chrono::{Duration, Utc};

pub async fn fetch_scrobbles(
    client: &reqwest::Client,
    cookie: &str,
    days: u64,
) -> Result<Vec<Scrobble>, Error> {
    let html = youtube_http::fetch_history_page(client, cookie).await?;
    let json = youtube_parse::extract_json_from_html(&html)?;
    let scrobbles = youtube_json::parse_scrobbles(&json)?;
    let filtered = filter_by_date(scrobbles, days);
    Ok(filtered)
}

fn filter_by_date(scrobbles: Vec<Scrobble>, days: u64) -> Vec<Scrobble> {
    let cutoff = Utc::now() - Duration::days(days as i64);
    scrobbles
        .into_iter()
        .filter(|s| s.played_at >= cutoff)
        .collect()
}
