use crate::types::{Config, GistFile, GistUpdate};
use anyhow::{Context, Result};
use reqwest::Client;
use std::collections::HashMap;

const GITHUB_API_BASE: &str = "https://api.github.com/gists";
const USER_AGENT: &str = "music-stats/0.1.0";
const GITHUB_API_VERSION: &str = "2022-11-28";

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
        let url = format!("{}/{}", GITHUB_API_BASE, gist_id);

        let mut files = HashMap::new();
        files.insert("lastfm-recent-tracks".to_string(), GistFile { content });

        let update = GistUpdate {
            description: "🎵 Most listened tracks (last 3 days)".to_string(),
            files,
        };

        let response = self
            .client
            .patch(&url)
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", USER_AGENT)
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
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
