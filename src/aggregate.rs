use crate::providers::types::{Scrobble, Track};
use std::collections::HashMap;

#[derive(Debug)]
pub struct Statistics {
    pub top_tracks: Vec<(Track, usize)>,
    pub total_plays: usize,
    pub unique_tracks: usize,
}

pub fn compute_statistics(scrobbles: Vec<Scrobble>, top_n: usize) -> Statistics {
    let play_counts = count_plays(&scrobbles);
    let mut sorted_tracks = sort_by_play_count(play_counts);
    let unique_tracks = sorted_tracks.len();
    sorted_tracks.truncate(top_n);

    Statistics {
        top_tracks: sorted_tracks,
        total_plays: scrobbles.len(),
        unique_tracks,
    }
}

fn count_plays(scrobbles: &[Scrobble]) -> HashMap<Track, usize> {
    let mut counts = HashMap::new();
    for scrobble in scrobbles {
        *counts.entry(scrobble.track.clone()).or_insert(0) += 1;
    }
    counts
}

fn sort_by_play_count(counts: HashMap<Track, usize>) -> Vec<(Track, usize)> {
    let mut tracks: Vec<(Track, usize)> = counts.into_iter().collect();
    tracks.sort_by(|a, b| b.1.cmp(&a.1));
    tracks
}
