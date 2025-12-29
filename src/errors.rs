use std::time::Duration;

#[derive(Debug)]
pub enum Error {
    MissingEnvVar { 
        variable: String 
    },
    NoProviders,
    InvalidConfig { 
        field: String, 
        reason: String 
    },
    
    LastFmApi { 
        status: u16, 
        message: String 
    },
    
    YouTubeAuth { 
        reason: String 
    },
    YouTubeScraping { 
        detail: String 
    },
    
    Network { 
        url: String, 
        source: reqwest::Error 
    },
    RateLimit { 
        retry_after: Option<Duration> 
    },
    
    GistUpdate { 
        gist_id: String, 
        status: u16, 
        body: String 
    },
}

impl Error {
    pub fn is_transient(&self) -> bool {
        matches!(self, Error::Network { .. } | Error::RateLimit { .. })
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Error::MissingEnvVar { variable } => {
                write!(formatter, "Missing required environment variable: {}", variable)
            }
            Error::NoProviders => {
                write!(formatter, "No music providers configured. Set either LASTFM_API_KEY or YOUTUBE_COOKIE")
            }
            Error::InvalidConfig { field, reason } => {
                write!(formatter, "Invalid configuration for {}: {}", field, reason)
            }
            Error::LastFmApi { status, message } => {
                write!(formatter, "Last.fm API error (status {}): {}", status, message)
            }
            Error::YouTubeAuth { reason } => {
                write!(formatter, "YouTube authentication failed: {}. Make sure your cookie includes __Secure-3PAPISID", reason)
            }
            Error::YouTubeScraping { detail } => {
                write!(formatter, "YouTube scraping failed: {}", detail)
            }
            Error::Network { url, source } => {
                write!(formatter, "Network error accessing {}: {}", url, source)
            }
            Error::RateLimit { retry_after } => {
                match retry_after {
                    Some(duration) => write!(formatter, "Rate limited. Retry after {:?}", duration),
                    None => write!(formatter, "Rate limited"),
                }
            }
            Error::GistUpdate { gist_id, status, body } => {
                write!(formatter, "Failed to update gist {} (status {}): {}", gist_id, status, body)
            }
        }
    }
}

impl std::error::Error for Error {}
