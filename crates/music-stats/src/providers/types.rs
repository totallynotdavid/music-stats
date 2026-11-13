use chrono::{DateTime, NaiveDate, TimeDelta, Utc};

pub fn cutoff(days: u64) -> DateTime<Utc> {
    i64::try_from(days)
        .ok()
        .and_then(TimeDelta::try_days)
        .and_then(|span| Utc::now().checked_sub_signed(span))
        .map_or(DateTime::UNIX_EPOCH, |at| at.max(DateTime::UNIX_EPOCH))
}

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

#[derive(Debug, Clone)]
pub struct YouTubePlay {
    pub scrobble: Scrobble,
    pub video_id: Option<String>,
    pub day: Option<NaiveDate>,
}

impl Scrobble {
    pub fn new(artist: String, title: String, played_at: DateTime<Utc>) -> Self {
        Self {
            track: Track { artist, title },
            played_at,
        }
    }
}
