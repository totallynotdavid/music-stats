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
fn does_not_show_1x_for_single_play() {
    let tracks = vec![make_track("Artist", "Song", 1)];
    let result = format_tracks(&tracks);
    assert!(!result.contains("(1×)"));
    assert!(!result.contains("×"));
}

#[test]
fn truncates_long_titles() {
    let tracks = vec![make_track("Artist", &"A".repeat(100), 1)];
    let result = format_tracks(&tracks);
    assert!(result.contains('…'));
    let lines: Vec<&str> = result.lines().collect();
    let title_part = lines[0].split_whitespace().next().unwrap();
    assert!(title_part.len() <= 36 * 3, "truncated title should not exceed max width plus ellipsis in bytes");
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

#[test]
fn truncates_emoji_correctly() {
    let tracks = vec![make_track("Artist", &"🎵".repeat(50), 1)];
    let result = format_tracks(&tracks);
    assert!(result.contains('…'));
    assert!(!result.contains("🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵"));
}

#[test]
fn handles_empty_artist_and_title() {
    let tracks = vec![make_track("", "", 10)];
    let result = format_tracks(&tracks);
    assert!(result.contains("(10×)"));
}

#[test]
fn newlines_in_track_names_appear_in_output() {
    let tracks = vec![make_track("Artist\nWith\nNewlines", "Song\nWith\nBreaks", 2)];
    let result = format_tracks(&tracks);
    assert!(result.contains("Song\nWith\nBreaks"));
}

#[test]
fn very_large_play_counts() {
    let tracks = vec![make_track("Artist", "Song", usize::MAX)];
    let result = format_tracks(&tracks);
    assert!(result.contains(&format!("({}×)", usize::MAX)));
}

#[test]
fn multiple_tracks_separated_by_newlines() {
    let tracks = vec![
        make_track("A", "First", 1),
        make_track("B", "Second", 1),
        make_track("C", "Third", 1),
    ];
    let result = format_tracks(&tracks);
    let lines: Vec<&str> = result.lines().collect();
    assert_eq!(lines.len(), 3, "should have three lines for three tracks");
}

#[test]
fn title_exactly_at_max_width() {
    let tracks = vec![make_track("Artist", &"A".repeat(35), 1)];
    let result = format_tracks(&tracks);
    assert!(!result.contains('…'), "should not truncate when exactly at max width");
}

#[test]
fn title_one_over_max_width() {
    let tracks = vec![make_track("Artist", &"A".repeat(36), 1)];
    let result = format_tracks(&tracks);
    assert!(result.contains('…'), "should truncate when one over max width");
}
