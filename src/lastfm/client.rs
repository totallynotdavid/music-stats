use crate::config::Config;
use crate::domain::Scrobble;
use anyhow::Result;
use reqwest::Client;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{api_types, pagination};

pub async fn fetch_scrobbles(config: &Config) -> Result<Vec<Scrobble>> {
    let client = Client::new();
    let from = calculate_timestamp(config.days);

    let api_tracks = pagination::fetch_all_pages(&client, config, from).await?;

    Ok(api_tracks
        .into_iter()
        .filter_map(api_types::to_scrobble)
        .collect())
}

fn calculate_timestamp(days: u64) -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("System time before UNIX epoch")
        .as_secs();
    now.saturating_sub(days * 86400)
}
