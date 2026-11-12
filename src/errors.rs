use std::fmt;

#[derive(Debug)]
pub enum Error {
    MissingEnvVar {
        variable: String,
    },
    NoProviders,
    NoOutputs,
    AllProvidersFailed,
    SomeProvidersFailed {
        providers: Vec<&'static str>,
    },
    InvalidConfig {
        field: String,
        reason: String,
    },
    LastFm {
        status: u16,
        url: String,
        body: String,
    },
    YouTube {
        stage: String,
        detail: String,
    },
    Network {
        url: String,
        source: reqwest::Error,
    },
    Gist {
        gist_id: String,
        status: u16,
        body: String,
    },
    Upload {
        url: String,
        status: u16,
        cause: String,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Error::MissingEnvVar { variable } => {
                write!(f, "Missing required environment variable: {}", variable)
            }
            Error::NoProviders => {
                write!(
                    f,
                    "No music providers configured. Set LASTFM_API_KEY+LASTFM_USERNAME or YOUTUBE_COOKIE"
                )
            }
            Error::NoOutputs => {
                write!(
                    f,
                    "No output configured. Set GIST_ID+GH_TOKEN, or UPLOAD_TOKEN"
                )
            }
            Error::AllProvidersFailed => {
                write!(
                    f,
                    "All configured music providers failed to fetch scrobbles"
                )
            }
            Error::SomeProvidersFailed { providers } => {
                write!(
                    f,
                    "Finished without {}, which failed to fetch scrobbles",
                    providers.join(" and ")
                )
            }
            Error::InvalidConfig { field, reason } => {
                write!(f, "Invalid {}: {}", field, reason)
            }
            Error::LastFm { status, url, body } => {
                write!(
                    f,
                    "Last.fm API error (status {}): {} - Response: {}",
                    status, url, body
                )
            }
            Error::YouTube { stage, detail } => {
                write!(f, "YouTube {} failed: {}", stage, detail)
            }
            Error::Network { url, source } => {
                write!(f, "Network error accessing {}: {}", url, source)
            }
            Error::Gist {
                gist_id,
                status,
                body,
            } => {
                write!(
                    f,
                    "Failed to update gist {} (status {}): {}",
                    gist_id, status, body
                )
            }
            Error::Upload { url, status, cause } => {
                write!(f, "Upload to {} failed (status {}): {}", url, status, cause)
            }
        }
    }
}

impl std::error::Error for Error {}
