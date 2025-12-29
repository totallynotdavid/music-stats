use chrono::{DateTime, Utc};
use std::collections::HashMap;

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

#[derive(Debug)]
pub struct Statistics {
    pub top_tracks: Vec<(Track, usize)>,
    pub total_plays: usize,
    pub unique_tracks: usize,
}

pub fn aggregate_scrobbles(scrobbles: Vec<Scrobble>, top_n: usize) -> Statistics {
    let mut play_counts: HashMap<Track, usize> = HashMap::new();
    
    for scrobble in &scrobbles {
        *play_counts.entry(scrobble.track.clone()).or_insert(0) += 1;
    }
    
    let mut top_tracks: Vec<(Track, usize)> = play_counts.into_iter().collect();
    top_tracks.sort_by(|first, second| second.1.cmp(&first.1));
    
    let unique_tracks = top_tracks.len();
    top_tracks.truncate(top_n);
    
    Statistics {
        top_tracks,
        total_plays: scrobbles.len(),
        unique_tracks,
    }
}
