#[derive(Debug, Clone)]
pub struct Config {
    pub gist_id: String,
    pub gh_token: String,
    pub spotify_client_id: String,
    pub spotify_client_secret: String,
    pub spotify_refresh_token: String,
}
