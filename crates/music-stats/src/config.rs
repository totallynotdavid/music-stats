use crate::errors::Error;
use crate::output::upload;
use chrono_tz::Tz;
use std::collections::HashMap;

#[derive(Debug)]
pub struct Config {
    pub gist: Option<GistConfig>,
    pub upload: Option<UploadConfig>,
    pub provider: Provider,
    pub timezone: Tz,
    pub days: u64,
    pub top_n: usize,
}

#[derive(Debug, Clone)]
pub struct GistConfig {
    pub id: String,
    pub token: String,
}

#[derive(Debug, Clone)]
pub struct UploadConfig {
    pub url: String,
    pub token: String,
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
    let env: HashMap<String, String> = std::env::vars().collect();
    load_from(&env)
}

pub fn load_from(env: &HashMap<String, String>) -> Result<Config, Error> {
    let gist = load_gist(env)?;
    let provider = load_provider(env)?;
    let upload = load_upload(env, &provider)?;
    if gist.is_none() && upload.is_none() {
        return Err(Error::NoOutputs);
    }

    let days = parse_env(env, "DAYS", 7)?;
    let top_n = parse_env(env, "TOP_N", 5)?;
    let timezone = load_timezone(env)?;
    validate_config(days, top_n)?;

    Ok(Config {
        gist,
        upload,
        provider,
        timezone,
        days,
        top_n,
    })
}

fn load_timezone(env: &HashMap<String, String>) -> Result<Tz, Error> {
    match lookup_env(env, "MUSIC_STATS_TZ") {
        Some(name) => name.parse().map_err(|_| Error::InvalidConfig {
            field: "MUSIC_STATS_TZ".to_string(),
            reason: format!("{name:?} is not an IANA time zone name such as America/Lima"),
        }),
        None => Ok(Tz::UTC),
    }
}

fn load_gist(env: &HashMap<String, String>) -> Result<Option<GistConfig>, Error> {
    let id = lookup_env(env, "GIST_ID");
    let token = lookup_env(env, "GH_TOKEN");

    match (id, token) {
        (None, None) => Ok(None),
        (Some(id), Some(token)) => Ok(Some(GistConfig { id, token })),
        (Some(_), None) => Err(missing("GH_TOKEN")),
        (None, Some(_)) => Err(missing("GIST_ID")),
    }
}

fn load_upload(
    env: &HashMap<String, String>,
    provider: &Provider,
) -> Result<Option<UploadConfig>, Error> {
    let Some(token) = lookup_env(env, "UPLOAD_TOKEN") else {
        return Ok(None);
    };
    if provider.youtube_cookie().is_none() {
        return Err(Error::InvalidConfig {
            field: "UPLOAD_TOKEN".to_string(),
            reason: "the upload sends YouTube Music plays, so YOUTUBE_COOKIE must be set"
                .to_string(),
        });
    }
    let url = lookup_env(env, "UPLOAD_URL").unwrap_or_else(|| upload::DEFAULT_BASE_URL.to_string());

    Ok(Some(UploadConfig { url, token }))
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
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn missing(variable: &str) -> Error {
    Error::MissingEnvVar {
        variable: variable.to_string(),
    }
}

fn parse_env<T: std::str::FromStr>(
    env: &HashMap<String, String>,
    key: &str,
    default: T,
) -> Result<T, Error>
where
    T::Err: std::fmt::Display,
{
    match lookup_env(env, key) {
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
