use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub gist_id: String,
    pub gh_token: String,
    pub lastfm_api_key: String,
    pub lastfm_user: String,
    pub days: u64,
    pub top_n: usize,
}

pub fn load_from_env() -> Result<Config> {
    Ok(Config {
        gist_id: required_env("GIST_ID")?,
        gh_token: required_env("GH_TOKEN")?,
        lastfm_api_key: required_env("LASTFM_API_KEY")?,
        lastfm_user: required_env("LASTFM_USER")?,
        days: optional_env("STATS_DAYS", "7")?,
        top_n: optional_env("STATS_TOP_N", "5")?,
    })
}

fn required_env(key: &str) -> Result<String> {
    std::env::var(key)
        .with_context(|| format!("Missing required environment variable: {}", key))
        .and_then(|v| {
            if v.trim().is_empty() {
                anyhow::bail!("Environment variable {} is empty", key);
            }
            Ok(v)
        })
}

fn optional_env<T: std::str::FromStr>(key: &str, default: &str) -> Result<T>
where
    T::Err: std::fmt::Display + Send + Sync + std::error::Error + 'static,
{
    std::env::var(key)
        .unwrap_or_else(|_| default.to_string())
        .parse()
        .with_context(|| format!("Invalid value for {}", key))
}
