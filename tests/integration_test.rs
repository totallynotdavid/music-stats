use music_stats::domain::{aggregate_scrobbles, Scrobble};
use music_stats::format::format_tracks;

#[test]
fn full_pipeline_with_realistic_data() {
    let scrobbles = vec![
        Scrobble::new("Radiohead".into(), "Paranoid Android".into()),
        Scrobble::new("Radiohead".into(), "Paranoid Android".into()),
        Scrobble::new("Radiohead".into(), "Paranoid Android".into()),
        Scrobble::new("Pink Floyd".into(), "Shine On You Crazy Diamond".into()),
        Scrobble::new("Pink Floyd".into(), "Shine On You Crazy Diamond".into()),
        Scrobble::new("The Beatles".into(), "A Day in the Life".into()),
    ];

    let tracks = aggregate_scrobbles(scrobbles);
    assert_eq!(tracks.len(), 3);
    assert_eq!(tracks[0].play_count, 3);
    assert_eq!(tracks[1].play_count, 2);
    assert_eq!(tracks[2].play_count, 1);

    let formatted = format_tracks(&tracks);
    assert!(formatted.contains("Paranoid Android"));
    assert!(formatted.contains("(3×)"));
    assert!(formatted.contains("(2×)"));
    assert!(!formatted.contains("(1×)"));
}

#[test]
fn handles_empty_data_gracefully() {
    let tracks = aggregate_scrobbles(vec![]);
    let formatted = format_tracks(&tracks);
    assert_eq!(formatted, "No tracks played recently");
}
