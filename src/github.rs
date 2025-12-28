use crate::config::Config;
use anyhow::{Context, Result};
use reqwest::Client;
use serde::Serialize;
use std::collections::HashMap;

pub async fn update_gist(config: &Config, content: String) -> Result<()> {
    let client = Client::new();
    let url = format!("https://api.github.com/gists/{}", config.gist_id);

    let update = build_gist_update(content);

    let response = client
        .patch(&url)
        .bearer_auth(&config.gh_token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "music-stats/0.1.0")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&update)
        .send()
        .await
        .context("Failed to send gist update request")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("GitHub API error (status {}): {}", status, body);
    }

    Ok(())
}

fn build_gist_update(content: String) -> GistUpdate {
    let mut files = HashMap::new();
    files.insert("lastfm-recent-tracks".to_string(), GistFile { content });

    GistUpdate {
        description: "🎵 What I've been listening to".to_string(),
        files,
    }
}

#[derive(Serialize)]
struct GistUpdate {
    description: String,
    files: HashMap<String, GistFile>,
}

#[derive(Serialize)]
struct GistFile {
    content: String,
}
