use chrono::Utc;
use music_stats::aggregate::compute_statistics;
use music_stats::providers::types::Scrobble;

fn scrobbles(plays: &[(&str, &str)]) -> Vec<Scrobble> {
    plays
        .iter()
        .map(|(artist, title)| Scrobble::new(artist.to_string(), title.to_string(), Utc::now()))
        .collect()
}

#[test]
fn counts_plays_and_unique_tracks() {
    let cases = [
        (vec![], 10, [0, 0, 0]),
        (vec!["A"], 10, [1, 1, 1]),
        (vec!["A", "A", "A"], 10, [1, 3, 1]),
        (vec!["A1", "A2", "A3", "A4", "A5"], 3, [3, 5, 5]),
        (vec!["A1", "A2"], 10, [2, 2, 2]),
    ];

    for (artists, top_n, expected) in cases {
        let plays: Vec<(&str, &str)> = artists.iter().map(|artist| (*artist, "T")).collect();

        let stats = compute_statistics(scrobbles(&plays), top_n);

        assert_eq!(
            [
                stats.top_tracks.len(),
                stats.total_plays,
                stats.unique_tracks
            ],
            expected,
            "{artists:?}"
        );
    }
}

#[test]
fn tracks_sorted_by_play_count() {
    let plays = scrobbles(&[
        ("A1", "T1"),
        ("A2", "T2"),
        ("A2", "T2"),
        ("A3", "T3"),
        ("A3", "T3"),
        ("A3", "T3"),
    ]);

    let stats = compute_statistics(plays, 10);

    let order: Vec<(&str, usize)> = stats
        .top_tracks
        .iter()
        .map(|(track, count)| (track.artist.as_str(), *count))
        .collect();
    assert_eq!(order, [("A3", 3), ("A2", 2), ("A1", 1)]);
}

#[test]
fn ties_are_ordered_by_artist_then_title() {
    let plays = scrobbles(&[("B", "x"), ("A", "z"), ("A", "y"), ("C", "a")]);

    for _ in 0..20 {
        let stats = compute_statistics(plays.clone(), 10);
        let order: Vec<(&str, &str)> = stats
            .top_tracks
            .iter()
            .map(|(t, _)| (t.artist.as_str(), t.title.as_str()))
            .collect();

        assert_eq!(order, [("A", "y"), ("A", "z"), ("B", "x"), ("C", "a")]);
    }
}
