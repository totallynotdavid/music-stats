use music_stats::aggregate::Statistics;
use music_stats::output::format::format_statistics;
use music_stats::providers::types::Track;

#[test]
fn empty_statistics() {
    let stats = Statistics {
        top_tracks: vec![],
        total_plays: 0,
        unique_tracks: 0,
    };

    let output = format_statistics(&stats);
    assert_eq!(output, "No tracks played recently");
}

#[test]
fn single_track_single_play() {
    let stats = Statistics {
        top_tracks: vec![(
            Track {
                artist: "Artist".into(),
                title: "Title".into(),
            },
            1,
        )],
        total_plays: 1,
        unique_tracks: 1,
    };

    let output = format_statistics(&stats);
    assert!(output.contains("Title"));
    assert!(output.contains("Artist"));
    assert!(!output.contains("×"));
}

#[test]
fn single_track_multiple_plays() {
    let stats = Statistics {
        top_tracks: vec![(
            Track {
                artist: "Artist".into(),
                title: "Title".into(),
            },
            5,
        )],
        total_plays: 5,
        unique_tracks: 1,
    };

    let output = format_statistics(&stats);
    assert!(output.contains("(5×)"));
}

#[test]
fn multiple_tracks_formatted_as_lines() {
    let stats = Statistics {
        top_tracks: vec![
            (
                Track {
                    artist: "A1".into(),
                    title: "T1".into(),
                },
                3,
            ),
            (
                Track {
                    artist: "A2".into(),
                    title: "T2".into(),
                },
                2,
            ),
        ],
        total_plays: 5,
        unique_tracks: 2,
    };

    let output = format_statistics(&stats);
    let lines: Vec<&str> = output.lines().collect();

    assert_eq!(lines.len(), 2);
    assert!(lines[0].contains("T1"));
    assert!(lines[1].contains("T2"));
}

#[test]
fn long_title_truncated_with_ellipsis() {
    let long_title = "This Is A Very Long Song Title That Should Be Truncated";
    let stats = Statistics {
        top_tracks: vec![(
            Track {
                artist: "Artist".into(),
                title: long_title.into(),
            },
            1,
        )],
        total_plays: 1,
        unique_tracks: 1,
    };

    let output = format_statistics(&stats);
    assert!(output.contains("…"));
    assert!(output.len() < long_title.len() + 50);
}

#[test]
fn long_artist_truncated_with_ellipsis() {
    let long_artist = "This Is A Very Long Artist Name That Should Be Truncated";
    let stats = Statistics {
        top_tracks: vec![(
            Track {
                artist: long_artist.into(),
                title: "Title".into(),
            },
            1,
        )],
        total_plays: 1,
        unique_tracks: 1,
    };

    let output = format_statistics(&stats);
    assert!(output.contains("…"));
}

#[test]
fn unicode_characters_handled() {
    let stats = Statistics {
        top_tracks: vec![(
            Track {
                artist: "日本語".into(),
                title: "タイトル".into(),
            },
            2,
        )],
        total_plays: 2,
        unique_tracks: 1,
    };

    let output = format_statistics(&stats);
    assert!(output.contains("日本語"));
    assert!(output.contains("タイトル"));
    assert!(output.contains("(2×)"));
}
