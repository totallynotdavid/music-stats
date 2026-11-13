use music_stats::aggregate::Statistics;
use music_stats::output::format::format_statistics;
use music_stats::providers::types::Track;

fn format(tracks: &[(&str, &str, usize)]) -> String {
    let top_tracks: Vec<(Track, usize)> = tracks
        .iter()
        .map(|(artist, title, count)| {
            (
                Track {
                    artist: artist.to_string(),
                    title: title.to_string(),
                },
                *count,
            )
        })
        .collect();
    let total_plays = top_tracks.iter().map(|(_, count)| count).sum();

    format_statistics(&Statistics {
        unique_tracks: top_tracks.len(),
        top_tracks,
        total_plays,
    })
}

#[test]
fn formats_a_track_per_line() {
    let long_title = "This Is A Very Long Song Title That Should Be Truncated";
    let long_artist = "This Is A Very Long Artist Name That Should Be Truncated";
    let wide_title = "あ".repeat(20);

    let cases = [
        (vec![], "No tracks played recently"),
        (
            vec![("Artist", "Title", 1)],
            "Title                                   Artist",
        ),
        (
            vec![("Artist", "Title", 5)],
            "Title                                   Artist (5×)",
        ),
        (
            vec![("A1", "T1", 3), ("A2", "T2", 2)],
            "T1                                      A1 (3×)\n\
             T2                                      A2 (2×)",
        ),
        (
            vec![("Artist", long_title, 1)],
            "This Is A Very Long Song Title Tha…     Artist",
        ),
        (
            vec![(long_artist, "Title", 1)],
            "Title                                   This Is A Very Long Arti…",
        ),
        (
            vec![("日本語", "タイトル", 2)],
            "タイトル                                日本語 (2×)",
        ),
        (
            vec![("Artist", &wide_title, 1)],
            "あああああああああああああああああ…     Artist",
        ),
    ];

    for (tracks, expected) in cases {
        assert_eq!(format(&tracks), expected);
    }
}
