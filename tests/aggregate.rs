use chrono::Utc;
use music_stats::aggregate::compute_statistics;
use music_stats::providers::types::Scrobble;

#[test]
fn empty_scrobbles_returns_empty_statistics() {
    let stats = compute_statistics(vec![], 10);

    assert_eq!(stats.top_tracks.len(), 0);
    assert_eq!(stats.total_plays, 0);
    assert_eq!(stats.unique_tracks, 0);
}

#[test]
fn single_track_played_once() {
    let scrobbles = vec![Scrobble::new("Artist".into(), "Track".into(), Utc::now())];

    let stats = compute_statistics(scrobbles, 10);

    assert_eq!(stats.top_tracks.len(), 1);
    assert_eq!(stats.top_tracks[0].1, 1);
    assert_eq!(stats.total_plays, 1);
    assert_eq!(stats.unique_tracks, 1);
}

#[test]
fn same_track_played_multiple_times() {
    let scrobbles = vec![
        Scrobble::new("Artist".into(), "Track".into(), Utc::now()),
        Scrobble::new("Artist".into(), "Track".into(), Utc::now()),
        Scrobble::new("Artist".into(), "Track".into(), Utc::now()),
    ];

    let stats = compute_statistics(scrobbles, 10);

    assert_eq!(stats.top_tracks.len(), 1);
    assert_eq!(stats.top_tracks[0].1, 3);
    assert_eq!(stats.total_plays, 3);
    assert_eq!(stats.unique_tracks, 1);
}

#[test]
fn tracks_sorted_by_play_count() {
    let scrobbles = vec![
        Scrobble::new("A1".into(), "T1".into(), Utc::now()),
        Scrobble::new("A2".into(), "T2".into(), Utc::now()),
        Scrobble::new("A2".into(), "T2".into(), Utc::now()),
        Scrobble::new("A3".into(), "T3".into(), Utc::now()),
        Scrobble::new("A3".into(), "T3".into(), Utc::now()),
        Scrobble::new("A3".into(), "T3".into(), Utc::now()),
    ];

    let stats = compute_statistics(scrobbles, 10);

    assert_eq!(stats.top_tracks[0].1, 3);
    assert_eq!(stats.top_tracks[0].0.artist, "A3");
    assert_eq!(stats.top_tracks[1].1, 2);
    assert_eq!(stats.top_tracks[1].0.artist, "A2");
    assert_eq!(stats.top_tracks[2].1, 1);
    assert_eq!(stats.top_tracks[2].0.artist, "A1");
}

#[test]
fn top_n_truncates_results() {
    let scrobbles = vec![
        Scrobble::new("A1".into(), "T1".into(), Utc::now()),
        Scrobble::new("A2".into(), "T2".into(), Utc::now()),
        Scrobble::new("A3".into(), "T3".into(), Utc::now()),
        Scrobble::new("A4".into(), "T4".into(), Utc::now()),
        Scrobble::new("A5".into(), "T5".into(), Utc::now()),
    ];

    let stats = compute_statistics(scrobbles, 3);

    assert_eq!(stats.top_tracks.len(), 3);
    assert_eq!(stats.unique_tracks, 5);
}

#[test]
fn top_n_larger_than_unique_tracks() {
    let scrobbles = vec![
        Scrobble::new("A1".into(), "T1".into(), Utc::now()),
        Scrobble::new("A2".into(), "T2".into(), Utc::now()),
    ];

    let stats = compute_statistics(scrobbles, 10);

    assert_eq!(stats.top_tracks.len(), 2);
    assert_eq!(stats.unique_tracks, 2);
}
