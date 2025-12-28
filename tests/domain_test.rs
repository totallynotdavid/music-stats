use music_stats::domain::{aggregate_scrobbles, Scrobble};

#[test]
fn empty_scrobbles_returns_empty() {
    let result = aggregate_scrobbles(vec![]);
    assert!(result.is_empty());
}

#[test]
fn single_scrobble_has_count_one() {
    let scrobbles = vec![Scrobble::new("Artist".into(), "Song".into())];
    let result = aggregate_scrobbles(scrobbles);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].play_count, 1);
}

#[test]
fn aggregates_duplicate_tracks() {
    let scrobbles = vec![
        Scrobble::new("Artist".into(), "Song".into()),
        Scrobble::new("Artist".into(), "Song".into()),
        Scrobble::new("Other".into(), "Different".into()),
    ];
    let result = aggregate_scrobbles(scrobbles);
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].play_count, 2);
    assert_eq!(result[1].play_count, 1);
}

#[test]
fn sorts_by_play_count_descending() {
    let scrobbles = vec![
        Scrobble::new("A".into(), "Low".into()),
        Scrobble::new("B".into(), "High".into()),
        Scrobble::new("B".into(), "High".into()),
        Scrobble::new("B".into(), "High".into()),
    ];
    let result = aggregate_scrobbles(scrobbles);
    assert_eq!(result[0].title(), "High");
    assert_eq!(result[0].play_count, 3);
    assert_eq!(result[1].title(), "Low");
    assert_eq!(result[1].play_count, 1);
}

#[test]
fn different_artists_same_title_are_separate() {
    let scrobbles = vec![
        Scrobble::new("Artist A".into(), "Same Title".into()),
        Scrobble::new("Artist B".into(), "Same Title".into()),
    ];
    let result = aggregate_scrobbles(scrobbles);
    assert_eq!(result.len(), 2);
}
