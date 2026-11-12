use crate::errors::Error;
use crate::providers::types::{self, Scrobble};
use crate::providers::{youtube_http, youtube_json, youtube_parse};

pub async fn fetch_scrobbles(
    client: &reqwest::Client,
    base_url: &str,
    cookie: &str,
    days: u64,
) -> Result<Vec<Scrobble>, Error> {
    let html = youtube_http::fetch_history_page(client, base_url, cookie).await?;
    youtube_parse::ensure_signed_in(&html)?;
    let json = youtube_parse::extract_json_from_html(&html)?;
    let scrobbles = youtube_json::parse_scrobbles(&json)?;
    let filtered = filter_by_date(scrobbles, days);
    Ok(filtered)
}

fn filter_by_date(scrobbles: Vec<Scrobble>, days: u64) -> Vec<Scrobble> {
    let cutoff = types::cutoff(days);
    scrobbles
        .into_iter()
        .filter(|s| s.played_at >= cutoff)
        .collect()
}
