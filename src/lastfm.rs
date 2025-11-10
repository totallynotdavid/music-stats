use crate::types::{Config, LastFmRecentTracksResponse, Track};
use anyhow::{Context, Result};
use reqwest::Client;
use std::collections::HashMap;

const THREE_DAYS_IN_SECONDS: u64 = 259200;
const USER_AGENT: &str = "music-stats/0.1.0";

pub struct LastFmClient {
    client: Client,
    api_key: String,
    user: String,
}

impl LastFmClient {
    pub fn new(config: &Config) -> Self {
        Self {
            client: Client::new(),
            api_key: config.lastfm_api_key.clone(),
            user: config.lastfm_user.clone(),
        }
    }

    pub async fn get_recent_tracks(&self, limit: usize) -> Result<Vec<Track>> {
        let url = format!(
            "http://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user={}&api_key={}&limit={}&format=json",
            self.user, self.api_key, limit
        );

        let response = self
            .client
            .get(&url)
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .context("Failed to fetch recent tracks from Last.fm")?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            anyhow::bail!("Last.fm API error {}: {}", status, text);
        }

        let data: LastFmRecentTracksResponse = response
            .json()
            .await
            .context("Failed to parse Last.fm response")?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let three_days_ago = now - THREE_DAYS_IN_SECONDS;

        let mut track_counts = HashMap::new();

        for track in &data.recenttracks.track {
            if let Some(date) = &track.date
                && let Ok(timestamp) = date.uts.parse::<u64>()
                && timestamp >= three_days_ago {
                let key = format!("{} - {}", track.artist.text, track.name);
                *track_counts.entry(key).or_insert(0) += 1;
            }
        }

        let mut tracks: Vec<Track> = track_counts
            .into_iter()
            .map(|(key, count)| {
                let mut parts = key.split(" - ");
                Track {
                    artist: parts.next().unwrap_or("Unknown").to_string(),
                    name: parts.next().unwrap_or("Unknown").to_string(),
                    play_count: count,
                }
            })
            .collect();

        tracks.sort_by(|a, b| b.play_count.cmp(&a.play_count));

        Ok(tracks.into_iter().take(limit).collect())
    }
}
