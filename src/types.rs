use serde::{Deserialize, Serialize};

pub struct Config {
    pub gist_id: String,
    pub gh_token: String,
    pub spotify_client_id: String,
    pub spotify_client_secret: String,
    pub spotify_refresh_token: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            gist_id: env_var("GIST_ID")?,
            gh_token: env_var("GH_TOKEN")?,
            spotify_client_id: env_var("SPOTIFY_CLIENT_ID")?,
            spotify_client_secret: env_var("SPOTIFY_CLIENT_SECRET")?,
            spotify_refresh_token: env_var("SPOTIFY_REFRESH_TOKEN")?,
        })
    }
}

fn env_var(key: &str) -> anyhow::Result<String> {
    std::env::var(key).map_err(|_| anyhow::anyhow!("Missing environment variable: {}", key))
}

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
}

#[derive(Debug, Deserialize)]
pub struct TopTracksResponse {
    pub items: Vec<Track>,
}

#[derive(Debug, Deserialize)]
pub struct Track {
    pub name: String,
    pub artists: Vec<Artist>,
    pub album: Album,
    pub external_urls: ExternalUrls,
}

#[derive(Debug, Deserialize)]
pub struct Artist {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct Album {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct ExternalUrls {
    pub spotify: String,
}

#[derive(Debug, Serialize)]
pub struct GistUpdate {
    pub description: String,
    pub files: std::collections::HashMap<String, GistFile>,
}

#[derive(Debug, Serialize)]
pub struct GistFile {
    pub content: String,
}
