use crate::errors::Error;

#[derive(Debug, Clone)]
pub struct Config {
    pub gist_id: String,
    pub github_token: String,
    pub lastfm: Option<LastFmConfig>,
    pub youtube_cookie: Option<String>,
    pub days: u64,
    pub top_n: usize,
}

#[derive(Debug, Clone)]
pub struct LastFmConfig {
    pub api_key: String,
    pub username: String,
}

pub fn load() -> Result<Config, Error> {
    let config = Config {
        gist_id: env_required("GIST_ID")?,
        github_token: env_required("GITHUB_TOKEN")?,
        lastfm: LastFmConfig::try_load(),
        youtube_cookie: std::env::var("YOUTUBE_COOKIE").ok(),
        days: env_optional("DAYS", 7)?,
        top_n: env_optional("TOP_N", 10)?,
    };
    
    validate(&config)?;
    Ok(config)
}

fn validate(config: &Config) -> Result<(), Error> {
    if config.lastfm.is_none() && config.youtube_cookie.is_none() {
        return Err(Error::NoProviders);
    }
    
    if config.days == 0 {
        return Err(Error::InvalidConfig {
            field: "DAYS".to_string(),
            reason: "must be greater than 0".to_string(),
        });
    }
    
    if config.top_n == 0 {
        return Err(Error::InvalidConfig {
            field: "TOP_N".to_string(),
            reason: "must be greater than 0".to_string(),
        });
    }
    
    Ok(())
}

impl LastFmConfig {
    fn try_load() -> Option<Self> {
        let api_key = std::env::var("LASTFM_API_KEY").ok();
        let username = std::env::var("LASTFM_USERNAME").ok();
        
        match (api_key, username) {
            (Some(key), Some(user)) if !key.trim().is_empty() && !user.trim().is_empty() => {
                Some(LastFmConfig { api_key: key, username: user })
            }
            (Some(_), None) => {
                tracing::warn!("LASTFM_API_KEY is set but LASTFM_USERNAME is missing");
                None
            }
            (None, Some(_)) => {
                tracing::warn!("LASTFM_USERNAME is set but LASTFM_API_KEY is missing");
                None
            }
            _ => None,
        }
    }
}

fn env_required(key: &str) -> Result<String, Error> {
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

fn env_optional<T>(key: &str, default: T) -> Result<T, Error>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match std::env::var(key) {
        Ok(value) => value.parse().map_err(|error: T::Err| Error::InvalidConfig {
            field: key.to_string(),
            reason: error.to_string(),
        }),
        Err(_) => Ok(default),
    }
}
