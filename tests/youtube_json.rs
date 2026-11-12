mod common;

use chrono::{NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use common::{history_json, video_id_for};
use music_stats::providers::youtube_json::{parse_plays, parse_plays_on, today_in};
use serde_json::Value;
use tracing_test::traced_test;

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2024, 3, 20).unwrap()
}

fn play_dates(heading: &str) -> Vec<String> {
    let json = history_json(&[(heading, &[("Song", "Artist")])]).to_string();

    parse_plays_on(&json, today())
        .unwrap()
        .iter()
        .map(|s| s.scrobble.played_at.to_rfc3339())
        .collect()
}

fn play_days(heading: &str) -> Vec<Option<NaiveDate>> {
    let json = history_json(&[(heading, &[("Song", "Artist")])]).to_string();

    parse_plays_on(&json, today())
        .unwrap()
        .iter()
        .map(|s| s.day)
        .collect()
}

#[test]
fn reads_title_and_artist() {
    let json = history_json(&[("2024-01-15", &[("Song Title", "Artist Name")])]).to_string();

    let plays = parse_plays(&json, Tz::UTC).unwrap();

    assert_eq!(plays.len(), 1);
    assert_eq!(plays[0].scrobble.track.title, "Song Title");
    assert_eq!(plays[0].scrobble.track.artist, "Artist Name");
}

#[test]
fn rejects_responses_without_the_history_structure() {
    let cases = [
        ("not valid json{", "Invalid JSON"),
        (r#"{"contents": {}}"#, "Expected structure not found"),
    ];

    for (json, message) in cases {
        let error = parse_plays(json, Tz::UTC).unwrap_err().to_string();

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
            [
                "This week",
                "Esta semana",
                "Questa settimana",
                "Cette semaine",
            ]
            .as_slice(),
            "2024-03-17T12:00:00+00:00",
        ),
        (
            [
                "Last week",
                "Última semana",
                "Semana passada",
                "Settimana scorsa",
                "Semaine dernière",
            ]
            .as_slice(),
            "2024-03-16T12:00:00+00:00",
        ),
        (
            [
                "February 2024",
                "febrero de 2024",
                "fevereiro de 2024",
                "febbraio 2024",
                "février 2024",
            ]
            .as_slice(),
            "2024-02-15T12:00:00+00:00",
        ),
        (
            ["September 2023", "setiembre de 2023"].as_slice(),
            "2023-09-15T12:00:00+00:00",
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
fn only_a_heading_that_names_one_day_gives_a_play_a_day() {
    let day = |y, m, d| Some(NaiveDate::from_ymd_opt(y, m, d).unwrap());
    let cases = [
        ("Today", day(2024, 3, 20)),
        ("Hoy", day(2024, 3, 20)),
        ("Yesterday", day(2024, 3, 19)),
        ("Hier", day(2024, 3, 19)),
        ("2024-01-15", day(2024, 1, 15)),
        ("This week", None),
        ("Last week", None),
        ("February 2024", None),
        ("March 2024", None),
    ];

    for (heading, expected) in cases {
        assert_eq!(play_days(heading), [expected], "{heading}");
    }
}

#[test]
fn today_and_yesterday_follow_the_time_zone() {
    let now = Utc.with_ymd_and_hms(2026, 11, 12, 3, 30, 0).unwrap();
    let cases = [
        ("UTC", "2026-11-12"),
        ("America/Lima", "2026-11-11"),
        ("Asia/Tokyo", "2026-11-12"),
        ("Pacific/Kiritimati", "2026-11-12"),
        ("Pacific/Pago_Pago", "2026-11-11"),
    ];

    for (name, expected) in cases {
        let tz: Tz = name.parse().unwrap();

        assert_eq!(today_in(now, tz).to_string(), expected, "{name}");
    }

    let later = Utc.with_ymd_and_hms(2026, 11, 12, 20, 0, 0).unwrap();
    let tokyo: Tz = "Asia/Tokyo".parse().unwrap();
    assert_eq!(today_in(later, tokyo).to_string(), "2026-11-13");
}

#[test]
fn a_page_resolved_in_a_time_zone_marks_its_days_there() {
    let json = history_json(&[
        ("Today", &[("New", "Artist")]),
        ("Yesterday", &[("Old", "Artist")]),
    ])
    .to_string();
    let lima = NaiveDate::from_ymd_opt(2026, 11, 11).unwrap();

    let plays = parse_plays_on(&json, lima).unwrap();

    assert_eq!(
        plays.iter().map(|p| p.day).collect::<Vec<_>>(),
        [Some(lima), lima.pred_opt()]
    );
}

#[test]
fn reads_the_video_id_of_every_play_in_page_order() {
    let json = history_json(&[
        ("Today", &[("First", "A"), ("Second Song", "B")]),
        ("Yesterday", &[("Third", "A")]),
    ])
    .to_string();

    let plays = parse_plays_on(&json, today()).unwrap();

    let ids: Vec<_> = plays.iter().map(|p| p.video_id.as_deref()).collect();
    assert_eq!(ids, [Some("First"), Some("Second_Song"), Some("Third")]);
    assert_eq!(video_id_for("Second Song"), "Second_Song");
}

fn set_video_id(json: &mut Value, id: Value) {
    json.pointer_mut(
        "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents/0/musicShelfRenderer/contents/0/musicResponsiveListItemRenderer/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/watchEndpoint",
    )
    .unwrap()
    .as_object_mut()
    .unwrap()
    .insert("videoId".to_string(), id);
}

#[test]
fn a_video_id_the_service_would_refuse_is_dropped_and_the_play_kept() {
    let cases = [
        Value::Null,
        Value::from(""),
        Value::from("has space"),
        Value::from("é-id"),
        Value::from("x".repeat(33)),
        Value::from(7),
    ];

    for id in cases {
        let mut json = history_json(&[("Today", &[("Song", "Artist")])]);
        set_video_id(&mut json, id.clone());

        let plays = parse_plays_on(&json.to_string(), today()).unwrap();

        assert_eq!(plays.len(), 1, "{id}");
        assert_eq!(plays[0].video_id, None, "{id}");
    }
}

#[test]
fn a_video_id_may_be_32_characters_of_letters_digits_underscore_and_dash() {
    let id = "aZ09_-aZ09_-aZ09_-aZ09_-aZ09_-aZ".to_string();
    let mut json = history_json(&[("Today", &[("Song", "Artist")])]);
    set_video_id(&mut json, Value::from(id.clone()));

    let plays = parse_plays_on(&json.to_string(), today()).unwrap();

    assert_eq!(id.len(), 32);
    assert_eq!(plays[0].video_id.as_deref(), Some(id.as_str()));
}

#[test]
fn current_month_heading_is_older_than_last_week() {
    assert_eq!(play_dates("March 2024"), ["2024-03-06T12:00:00+00:00"]);
}

#[test]
fn month_heading_stays_inside_its_month() {
    let early = NaiveDate::from_ymd_opt(2024, 3, 5).unwrap();
    let json = history_json(&[("March 2024", &[("Song", "Artist")])]).to_string();

    let plays = parse_plays_on(&json, early).unwrap();

    assert_eq!(
        plays[0].scrobble.played_at.to_rfc3339(),
        "2024-03-01T12:00:00+00:00"
    );
}

#[test]
#[traced_test]
fn warns_about_a_dropped_heading() {
    assert!(play_dates("Earlier").is_empty());
    assert!(logs_contain("unrecognized heading"));
    assert!(logs_contain("Earlier"));
}

#[test]
#[traced_test]
fn empty_unrecognized_heading_is_silent() {
    let json = history_json(&[("Earlier", &[])]).to_string();

    assert!(parse_plays_on(&json, today()).unwrap().is_empty());
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

    let plays = parse_plays(&json.to_string(), Tz::UTC).unwrap();

    assert_eq!(plays.len(), 1);
    assert_eq!(plays[0].scrobble.track.artist, "Unknown Artist");
}
