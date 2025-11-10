use crate::types::{Config, GistFile, GistUpdate};
use anyhow::{Context, Result};
use reqwest::Client;
use std::collections::HashMap;

pub struct GitHubClient {
    client: Client,
    token: String,
}

impl GitHubClient {
    pub fn new(config: &Config) -> Self {
        Self {
            client: Client::new(),
            token: config.gh_token.clone(),
        }
    }

    pub async fn update_gist(&self, gist_id: &str, content: String) -> Result<()> {
        let url = format!("https://api.github.com/gists/{}", gist_id);

        let mut files = HashMap::new();
        files.insert("spotify-top-tracks.md".to_string(), GistFile { content });

        let update = GistUpdate {
            description: "🎵 My Top Spotify Tracks (Last 4 Weeks)".to_string(),
            files,
        };

        let response = self
            .client
            .patch(&url)
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .json(&update)
            .send()
            .await
            .context("Failed to update gist")?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            anyhow::bail!("GitHub API error {}: {}", status, text);
        }

        Ok(())
    }
}
