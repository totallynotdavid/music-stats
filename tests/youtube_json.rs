mod common;

use chrono::NaiveDate;
use common::history_json;
use music_stats::providers::youtube_json::{parse_scrobbles, parse_scrobbles_on};
use serde_json::Value;
use tracing_test::traced_test;

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2024, 3, 20).unwrap()
}

fn play_dates(heading: &str) -> Vec<String> {
    let json = history_json(&[(heading, &[("Song", "Artist")])]).to_string();

    parse_scrobbles_on(&json, today())
        .unwrap()
        .iter()
        .map(|s| s.played_at.to_rfc3339())
        .collect()
}

#[test]
fn reads_title_and_artist() {
    let json = history_json(&[("2024-01-15", &[("Song Title", "Artist Name")])]).to_string();

    let scrobbles = parse_scrobbles(&json).unwrap();

    assert_eq!(scrobbles.len(), 1);
    assert_eq!(scrobbles[0].track.title, "Song Title");
    assert_eq!(scrobbles[0].track.artist, "Artist Name");
}

#[test]
fn rejects_responses_without_the_history_structure() {
    let cases = [
        ("not valid json{", "Invalid JSON"),
        (r#"{"contents": {}}"#, "Expected structure not found"),
    ];

    for (json, message) in cases {
        let error = parse_scrobbles(json).unwrap_err().to_string();

        assert!(error.contains(message), "{error:?} lacks {message:?}");
    }
}

#[test]
fn headings_resolve_to_noon_utc_of_their_day() {
    let cases = [
        (
            ["Today", "Hoy", "Hoje", "Oggi", "Aujourd'hui"].as_slice(),
            "2024-03-20T12:00:00+00:00",
        ),
        (
            ["Yesterday", "Ayer", "Ontem", "Ieri", "Hier"].as_slice(),
            "2024-03-19T12:00:00+00:00",
        ),
        (
            ["Last week", "Última semana", "Semana passada"].as_slice(),
            "2024-03-16T12:00:00+00:00",
        ),
        (["2024-01-15"].as_slice(), "2024-01-15T12:00:00+00:00"),
    ];

    for (labels, date) in cases {
        for label in labels {
            assert_eq!(play_dates(label), [date], "{label}");
        }
    }
}

#[test]
#[traced_test]
fn warns_about_a_dropped_heading() {
    assert!(play_dates("March 2024").is_empty());
    assert!(logs_contain("unrecognized heading"));
    assert!(logs_contain("March 2024"));
}

#[test]
#[traced_test]
fn empty_unrecognized_heading_is_silent() {
    let json = history_json(&[("March 2024", &[])]).to_string();

    assert!(parse_scrobbles_on(&json, today()).unwrap().is_empty());
    assert!(!logs_contain("unrecognized heading"));
}

#[test]
fn play_without_artist_link_is_listed_as_unknown_artist() {
    let mut json: Value = history_json(&[("2024-01-15", &[("Song Title", "Artist")])]);
    json.pointer_mut(
        "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents/0/musicShelfRenderer/contents/0/musicResponsiveListItemRenderer/flexColumns",
    )
    .unwrap()
    .as_array_mut()
    .unwrap()
    .truncate(1);

    let scrobbles = parse_scrobbles(&json.to_string()).unwrap();

    assert_eq!(scrobbles.len(), 1);
    assert_eq!(scrobbles[0].track.artist, "Unknown Artist");
}
