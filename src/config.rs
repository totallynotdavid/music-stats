use crate::errors::Error;

#[derive(Debug)]
pub struct Config {
    pub gist_id: String,
    pub github_token: String,
    pub provider: Provider,
    pub days: u64,
    pub top_n: usize,
}

#[derive(Debug)]
pub enum Provider {
    LastFm(LastFmConfig),
    YouTube(String),
    Both {
        lastfm: LastFmConfig,
        youtube_cookie: String,
    },
}

#[derive(Debug, Clone)]
pub struct LastFmConfig {
    pub api_key: String,
    pub username: String,
}

impl Provider {
    pub fn lastfm(&self) -> Option<&LastFmConfig> {
        match self {
            Provider::LastFm(config) => Some(config),
            Provider::Both { lastfm, .. } => Some(lastfm),
            _ => None,
        }
    }

    pub fn youtube_cookie(&self) -> Option<&str> {
        match self {
            Provider::YouTube(cookie) => Some(cookie),
            Provider::Both { youtube_cookie, .. } => Some(youtube_cookie),
            _ => None,
        }
    }
}

pub fn load() -> Result<Config, Error> {
    let gist_id = require_env("GIST_ID")?;
    let github_token = require_env("GH_TOKEN")?;
    let days = parse_env("DAYS", 7)?;
    let top_n = parse_env("TOP_N", 5)?;

    let provider = load_provider()?;

    validate_config(days, top_n)?;

    Ok(Config {
        gist_id,
        github_token,
        provider,
        days,
        top_n,
    })
}

fn load_provider() -> Result<Provider, Error> {
    let lastfm = try_load_lastfm();
    let youtube = std::env::var("YOUTUBE_COOKIE")
        .ok()
        .filter(|s| !s.trim().is_empty());

    match (lastfm, youtube) {
        (Some(lf), Some(yt)) => Ok(Provider::Both {
            lastfm: lf,
            youtube_cookie: yt,
        }),
        (Some(lf), None) => Ok(Provider::LastFm(lf)),
        (None, Some(yt)) => Ok(Provider::YouTube(yt)),
        (None, None) => Err(Error::NoProviders),
    }
}

fn try_load_lastfm() -> Option<LastFmConfig> {
    let api_key = std::env::var("LASTFM_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let username = std::env::var("LASTFM_USERNAME")
        .ok()
        .filter(|s| !s.trim().is_empty());

    match (api_key, username) {
        (Some(key), Some(user)) => Some(LastFmConfig {
            api_key: key,
            username: user,
        }),
        _ => None,
    }
}

fn require_env(key: &str) -> Result<String, Error> {
    let value = std::env::var(key).map_err(|_| Error::MissingEnvVar {
        variable: key.to_string(),
    })?;

    if value.trim().is_empty() {
        return Err(Error::MissingEnvVar {
            variable: key.to_string(),
        });
    }

    Ok(value)
}

fn parse_env<T: std::str::FromStr>(key: &str, default: T) -> Result<T, Error>
where
    T::Err: std::fmt::Display,
{
    match std::env::var(key) {
        Ok(value) => value.parse().map_err(|e: T::Err| Error::InvalidConfig {
            field: key.to_string(),
            reason: e.to_string(),
        }),
        Err(_) => Ok(default),
    }
}

fn validate_config(days: u64, top_n: usize) -> Result<(), Error> {
    if days == 0 {
        return Err(Error::InvalidConfig {
            field: "DAYS".to_string(),
            reason: "must be greater than 0".to_string(),
        });
    }

    if top_n == 0 {
        return Err(Error::InvalidConfig {
            field: "TOP_N".to_string(),
            reason: "must be greater than 0".to_string(),
        });
    }

    Ok(())
}
