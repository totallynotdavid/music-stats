use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TrackId {
    pub artist: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: TrackId,
    pub play_count: usize,
}

impl Track {
    pub fn artist(&self) -> &str {
        &self.id.artist
    }

    pub fn title(&self) -> &str {
        &self.id.title
    }
}

#[derive(Debug, Clone)]
pub struct Scrobble {
    pub artist: String,
    pub title: String,
}

impl Scrobble {
    pub fn new(artist: String, title: String) -> Self {
        Self { artist, title }
    }
}
