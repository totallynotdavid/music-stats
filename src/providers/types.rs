use chrono::{DateTime, Utc};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Track {
    pub artist: String,
    pub title: String,
}

#[derive(Debug, Clone)]
pub struct Scrobble {
    pub track: Track,
    pub played_at: DateTime<Utc>,
}

impl Scrobble {
    pub fn new(artist: String, title: String, played_at: DateTime<Utc>) -> Self {
        Self {
            track: Track { artist, title },
            played_at,
        }
    }
}
