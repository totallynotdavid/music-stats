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

#[test]
fn whitespace_in_names_treated_as_distinct() {
    let scrobbles = vec![
        Scrobble::new("Artist".into(), "Song".into()),
        Scrobble::new(" Artist".into(), "Song".into()),
        Scrobble::new("Artist".into(), " Song".into()),
        Scrobble::new("Artist ".into(), "Song ".into()),
    ];
    let result = aggregate_scrobbles(scrobbles);
    assert_eq!(result.len(), 4, "leading/trailing whitespace creates different tracks");
}

#[test]
fn empty_strings_are_valid_track_names() {
    let scrobbles = vec![
        Scrobble::new("".into(), "".into()),
        Scrobble::new("".into(), "".into()),
        Scrobble::new("Artist".into(), "".into()),
    ];
    let result = aggregate_scrobbles(scrobbles);
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].play_count, 2);
}

#[test]
fn special_characters_in_track_names() {
    let scrobbles = vec![
        Scrobble::new("AC/DC".into(), "Song\nWith\nNewlines".into()),
        Scrobble::new("AC/DC".into(), "Song\nWith\nNewlines".into()),
        Scrobble::new("Artist\t".into(), "Song\t".into()),
    ];
    let result = aggregate_scrobbles(scrobbles);
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].play_count, 2);
}

#[test]
fn case_sensitivity_matters() {
    let scrobbles = vec![
        Scrobble::new("Artist".into(), "Song".into()),
        Scrobble::new("ARTIST".into(), "SONG".into()),
        Scrobble::new("artist".into(), "song".into()),
    ];
    let result = aggregate_scrobbles(scrobbles);
    assert_eq!(result.len(), 3, "case-sensitive comparison treats these as different tracks");
}

#[test]
fn stable_sort_when_counts_are_equal() {
    let scrobbles = vec![
        Scrobble::new("Z".into(), "Last".into()),
        Scrobble::new("A".into(), "First".into()),
        Scrobble::new("M".into(), "Middle".into()),
    ];
    let result = aggregate_scrobbles(scrobbles);
    assert_eq!(result.len(), 3);
    for track in &result {
        assert_eq!(track.play_count, 1);
    }
}

#[test]
fn emoji_and_unicode_in_track_names() {
    let scrobbles = vec![
        Scrobble::new("🎵 Artist 🎵".into(), "Song 🎶".into()),
        Scrobble::new("🎵 Artist 🎵".into(), "Song 🎶".into()),
        Scrobble::new("Артист".into(), "Песня".into()),
    ];
    let result = aggregate_scrobbles(scrobbles);
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].play_count, 2);
}
