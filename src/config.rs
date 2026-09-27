use crate::errors::Error;
use std::collections::HashMap;

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

/// Loads configuration from the process environment.
pub fn load() -> Result<Config, Error> {
    let env: HashMap<String, String> = std::env::vars().collect();
    load_from(&env)
}

/// Loads configuration from an injected source, so tests can supply their own
/// values instead of mutating process env (which is shared across threads).
pub fn load_from(env: &HashMap<String, String>) -> Result<Config, Error> {
    let gist_id = require_env(env, "GIST_ID")?;
    let github_token = require_env(env, "GH_TOKEN")?;
    let days = parse_env(env, "DAYS", 7)?;
    let top_n = parse_env(env, "TOP_N", 5)?;

    let provider = load_provider(env)?;

    validate_config(days, top_n)?;

    Ok(Config {
        gist_id,
        github_token,
        provider,
        days,
        top_n,
    })
}

fn load_provider(env: &HashMap<String, String>) -> Result<Provider, Error> {
    let lastfm = try_load_lastfm(env);
    let youtube = lookup_env(env, "YOUTUBE_COOKIE");

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

fn try_load_lastfm(env: &HashMap<String, String>) -> Option<LastFmConfig> {
    let api_key = lookup_env(env, "LASTFM_API_KEY");
    let username = lookup_env(env, "LASTFM_USERNAME");

    match (api_key, username) {
        (Some(key), Some(user)) => Some(LastFmConfig {
            api_key: key,
            username: user,
        }),
        _ => None,
    }
}

fn lookup_env(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key)
        .map(|s| s.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
}

fn require_env(env: &HashMap<String, String>, key: &str) -> Result<String, Error> {
    lookup_env(env, key).ok_or_else(|| Error::MissingEnvVar {
        variable: key.to_string(),
    })
}

fn parse_env<T: std::str::FromStr>(
    env: &HashMap<String, String>,
    key: &str,
    default: T,
) -> Result<T, Error>
where
    T::Err: std::fmt::Display,
{
    match env.get(key) {
        Some(value) => value.parse().map_err(|e: T::Err| Error::InvalidConfig {
            field: key.to_string(),
            reason: e.to_string(),
        }),
        None => Ok(default),
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
