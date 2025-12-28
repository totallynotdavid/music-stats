use super::track::{Scrobble, Track, TrackId};
use std::collections::HashMap;

pub fn aggregate_scrobbles(scrobbles: Vec<Scrobble>) -> Vec<Track> {
    let mut counts: HashMap<TrackId, usize> = HashMap::new();

    for scrobble in scrobbles {
        let id = TrackId {
            artist: scrobble.artist,
            title: scrobble.title,
        };
        *counts.entry(id).or_insert(0) += 1;
    }

    let mut tracks: Vec<Track> = counts
        .into_iter()
        .map(|(id, play_count)| Track { id, play_count })
        .collect();

    tracks.sort_unstable_by(|a, b| b.play_count.cmp(&a.play_count));
    tracks
}
