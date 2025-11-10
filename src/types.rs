use serde::{Deserialize, Serialize};

pub struct Config {
    pub gist_id: String,
    pub gh_token: String,
    pub lastfm_api_key: String,
    pub lastfm_user: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            gist_id: env_var("GIST_ID")?,
            gh_token: env_var("GH_TOKEN")?,
            lastfm_api_key: env_var("LASTFM_API_KEY")?,
            lastfm_user: env_var("LASTFM_USER")?,
        })
    }
}

fn env_var(key: &str) -> anyhow::Result<String> {
    std::env::var(key)
        .map_err(|_| anyhow::anyhow!("Missing environment variable: {}", key))
}

#[derive(Debug, Deserialize)]
pub struct LastFmRecentTracksResponse {
    pub recenttracks: RecentTracks,
}

#[derive(Debug, Deserialize)]
pub struct RecentTracks {
    pub track: Vec<LastFmTrack>,
}

#[derive(Debug, Deserialize)]
pub struct LastFmTrack {
    pub name: String,
    pub artist: ArtistInfo,
    pub date: Option<DateInfo>,
}

#[derive(Debug, Deserialize)]
pub struct ArtistInfo {
    #[serde(rename = "#text")]
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct DateInfo {
    pub uts: String,
}

#[derive(Clone, Debug)]
pub struct Track {
    pub name: String,
    pub artist: String,
    pub play_count: usize,
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
