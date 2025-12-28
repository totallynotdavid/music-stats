use music_stats::domain::{Track, TrackId};
use music_stats::format::format_tracks;

fn make_track(artist: &str, title: &str, count: usize) -> Track {
    Track {
        id: TrackId {
            artist: artist.to_string(),
            title: title.to_string(),
        },
        play_count: count,
    }
}

#[test]
fn empty_tracks_returns_message() {
    let result = format_tracks(&[]);
    assert_eq!(result, "No tracks played recently");
}

#[test]
fn formats_single_track() {
    let tracks = vec![make_track("Test Artist", "Test Song", 1)];
    let result = format_tracks(&tracks);
    assert!(result.contains("Test Song"));
    assert!(result.contains("Test Artist"));
    assert!(!result.contains("×"));
}

#[test]
fn shows_play_count_for_multiple_plays() {
    let tracks = vec![make_track("Artist", "Song", 5)];
    let result = format_tracks(&tracks);
    assert!(result.contains("(5×)"));
}

#[test]
fn truncates_long_titles() {
    let tracks = vec![make_track("Artist", &"A".repeat(100), 1)];
    let result = format_tracks(&tracks);
    assert!(result.contains('…'));
}

#[test]
fn truncates_long_artists() {
    let tracks = vec![make_track(&"A".repeat(100), "Song", 1)];
    let result = format_tracks(&tracks);
    assert!(result.contains('…'));
}

#[test]
fn handles_unicode_correctly() {
    let tracks = vec![make_track("日本語アーティスト", "日本語の曲名", 2)];
    let result = format_tracks(&tracks);
    assert!(result.contains("日本語の曲名"));
    assert!(result.contains("日本語アーティスト"));
}

#[test]
fn formats_multiple_tracks() {
    let tracks = vec![
        make_track("Artist A", "Song 1", 3),
        make_track("Artist B", "Song 2", 1),
    ];
    let result = format_tracks(&tracks);
    assert!(result.contains("Song 1"));
    assert!(result.contains("Song 2"));
    assert!(result.contains("(3×)"));
}
