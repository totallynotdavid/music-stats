use crate::types::{Config, TokenResponse, TopTracksResponse, Track};
use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use reqwest::Client;

pub struct SpotifyClient {
    client: Client,
    access_token: String,
}

impl SpotifyClient {
    pub async fn new(config: &Config) -> Result<Self> {
        let client = Client::new();
        let access_token = Self::get_access_token(&client, config).await?;

        Ok(Self {
            client,
            access_token,
        })
    }

    /// Exchange refresh token for access token
    async fn get_access_token(client: &Client, config: &Config) -> Result<String> {
        let credentials = format!(
            "{}:{}",
            config.spotify_client_id, config.spotify_client_secret
        );
        let auth = format!("Basic {}", STANDARD.encode(credentials));

        let response = client
            .post("https://accounts.spotify.com/api/token")
            .header("Authorization", auth)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", &config.spotify_refresh_token),
            ])
            .send()
            .await
            .context("Failed to request access token")?;

        let token: TokenResponse = response
            .json()
            .await
            .context("Failed to parse token response")?;

        Ok(token.access_token)
    }

    /// Fetch user's top tracks from the last 4 weeks
    pub async fn get_top_tracks(&self, limit: usize) -> Result<Vec<Track>> {
        let url = format!(
            "https://api.spotify.com/v1/me/top/tracks?limit={}&time_range=medium_term",
            limit
        );

        let response = self
            .client
            .get(&url)
            .bearer_auth(&self.access_token)
            .send()
            .await
            .context("Failed to fetch top tracks")?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            anyhow::bail!("Spotify API error {}: {}", status, text);
        }

        let data: TopTracksResponse = response
            .json()
            .await
            .context("Failed to parse tracks response")?;

        Ok(data.items)
    }
}
