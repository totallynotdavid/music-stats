mod common;

use chrono::NaiveDate;
use common::history_json;
use music_stats::errors::Error;
use music_stats::output::upload::{UploadReply, build_request, upload_plays};
use music_stats::providers::types::{Scrobble, YouTubePlay};
use music_stats::providers::youtube_json::parse_plays_on;
use serde_json::json;
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "msu_secret-token-value";

fn play(day: Option<&str>, video_id: Option<&str>, title: &str) -> YouTubePlay {
    let played_at = NaiveDate::from_ymd_opt(2026, 11, 11)
        .unwrap()
        .and_hms_opt(12, 0, 0)
        .unwrap()
        .and_utc();
    YouTubePlay {
        scrobble: Scrobble::new("Radiohead".to_string(), title.to_string(), played_at),
        video_id: video_id.map(String::from),
        day: day.map(|d| d.parse().unwrap()),
    }
}

fn sample() -> Vec<YouTubePlay> {
    vec![
        play(
            Some("2026-11-11"),
            Some("rSvTmvpx0JI"),
            "Weird Fishes/ Arpeggi",
        ),
        play(Some("2026-11-10"), Some("abc_-123XYZ"), "Nude"),
    ]
}

fn client_field() -> String {
    format!("music-stats/{}", env!("CARGO_PKG_VERSION"))
}

#[tokio::test]
async fn posts_the_documented_body_with_a_bearer_token() {
    let server = MockServer::start().await;
    let expected = json!({
        "client": client_field(),
        "plays": [
            {"day": "2026-11-11", "artist": "Radiohead",
             "title": "Weird Fishes/ Arpeggi", "video_id": "rSvTmvpx0JI"},
            {"day": "2026-11-10", "artist": "Radiohead",
             "title": "Nude", "video_id": "abc_-123XYZ"},
        ]
    });
    Mock::given(method("POST"))
        .and(path("/api/v1/upload"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .and(header("content-type", "application/json"))
        .and(body_json(expected))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "received": 2, "inserted": 1, "duplicate": 1, "gap": false, "ambiguous": 0
        })))
        .expect(1)
        .mount(&server)
        .await;

    let reply = upload_plays(
        &reqwest::Client::new(),
        &server.uri(),
        TOKEN,
        &build_request(&sample()),
    )
    .await
    .unwrap();

    assert_eq!(
        reply,
        UploadReply {
            received: 2,
            inserted: 1,
            duplicate: 1,
            gap: false,
            ambiguous: 0
        }
    );
}

#[tokio::test]
async fn a_trailing_slash_on_the_base_url_is_harmless() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/v1/upload"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(&server)
        .await;

    upload_plays(
        &reqwest::Client::new(),
        &format!("{}/", server.uri()),
        TOKEN,
        &build_request(&sample()),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn an_unreadable_reply_to_an_accepted_upload_is_not_an_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let reply = upload_plays(
        &reqwest::Client::new(),
        &server.uri(),
        TOKEN,
        &build_request(&sample()),
    )
    .await
    .unwrap();

    assert_eq!(reply, UploadReply::default());
}

#[tokio::test]
async fn each_refusal_names_its_cause() {
    let cases = [
        (401, None, "UPLOAD_TOKEN is unknown or revoked"),
        (413, None, "256 KiB"),
        (415, None, "application/json"),
        (
            422,
            Some(format!(
                r#"{{"errors":[{{"index":3,"field":"day","got":"Bearer {TOKEN}"}},{{"index":7}}]}}"#
            )),
            "stored none. Failing items: 3, 7",
        ),
        (
            422,
            Some(format!("Bearer {TOKEN}")),
            "refused the plays and stored none",
        ),
        (429, None, "every 30 seconds"),
        (409, None, "raced"),
        (
            500,
            Some(format!("Authorization: Bearer {TOKEN}")),
            "unexpected reply",
        ),
    ];

    for (status, body, cause) in cases {
        let server = MockServer::start().await;
        let mut response = ResponseTemplate::new(status);
        if let Some(body) = &body {
            response = response.set_body_string(body.as_str());
        }
        Mock::given(method("POST"))
            .respond_with(response)
            .mount(&server)
            .await;

        let error = upload_plays(
            &reqwest::Client::new(),
            &server.uri(),
            TOKEN,
            &build_request(&sample()),
        )
        .await
        .unwrap_err();

        assert!(
            matches!(&error, Error::Upload { status: s, .. } if *s == status),
            "{status}: {error}"
        );
        let message = error.to_string();
        assert!(
            message.contains(&format!("(status {status})")) && message.contains(cause),
            "{status}: {message:?} lacks {cause:?}"
        );
        assert!(!message.contains(TOKEN), "{status}: {message}");
    }
}

#[tokio::test]
async fn a_429_says_when_to_retry() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "17"))
        .mount(&server)
        .await;

    let error = upload_plays(
        &reqwest::Client::new(),
        &server.uri(),
        TOKEN,
        &build_request(&sample()),
    )
    .await
    .unwrap_err()
    .to_string();

    assert!(error.contains("Retry after 17 seconds"), "{error}");
}

#[tokio::test]
async fn a_refused_connection_is_a_network_error() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);

    let error = upload_plays(
        &reqwest::Client::new(),
        &url,
        TOKEN,
        &build_request(&sample()),
    )
    .await
    .unwrap_err();

    assert!(matches!(error, Error::Network { .. }), "{error}");
}

#[test]
fn plays_without_a_day_or_a_video_id_are_not_sent() {
    let plays = vec![
        play(Some("2026-11-11"), Some("keep1"), "A"),
        play(None, Some("week"), "B"),
        play(Some("2026-11-10"), None, "C"),
        play(Some("2026-11-09"), Some("keep2"), "D"),
    ];

    let request = build_request(&plays);

    let ids: Vec<_> = request.plays.iter().map(|p| p.video_id.as_str()).collect();
    assert_eq!(ids, ["keep1", "keep2"]);
}

#[test]
fn heading_kinds_decide_which_plays_are_sent() {
    let today = NaiveDate::from_ymd_opt(2026, 11, 11).unwrap();
    let json = history_json(&[
        ("Today", &[("T1", "A")]),
        ("Yesterday", &[("Y1", "A")]),
        ("This week", &[("W1", "A")]),
        ("Last week", &[("L1", "A")]),
        ("October 2026", &[("M1", "A")]),
        ("2026-10-01", &[("D1", "A")]),
    ])
    .to_string();

    let plays = parse_plays_on(&json, today).unwrap();
    let request = build_request(&plays);

    let sent: Vec<_> = request
        .plays
        .iter()
        .map(|p| (p.day.as_str(), p.video_id.as_str()))
        .collect();
    assert_eq!(plays.len(), 6);
    assert_eq!(
        sent,
        [
            ("2026-11-11", "T1"),
            ("2026-11-10", "Y1"),
            ("2026-10-01", "D1")
        ]
    );
}

#[test]
fn a_page_over_the_item_limit_keeps_its_newest_plays_in_order() {
    let plays: Vec<_> = (0..1200)
        .map(|i| play(Some("2026-11-11"), Some(&format!("id{i}")), "Song"))
        .collect();

    let request = build_request(&plays);

    assert_eq!(request.plays.len(), 1000);
    assert_eq!(request.plays[0].video_id, "id0");
    assert_eq!(request.plays[999].video_id, "id999");
}

#[test]
fn text_over_512_characters_is_cut_instead_of_failing_the_upload() {
    let long = "é".repeat(600);
    let mut play = play(Some("2026-11-11"), Some("id"), &long);
    play.scrobble.track.artist = long.clone();

    let request = build_request(&[play]);

    assert_eq!(request.plays[0].title.chars().count(), 512);
    assert_eq!(request.plays[0].artist.chars().count(), 512);
}

#[test]
fn plays_with_empty_text_are_not_sent() {
    let mut empty_artist = play(Some("2026-11-11"), Some("a"), "Song");
    empty_artist.scrobble.track.artist = String::new();
    let empty_title = play(Some("2026-11-11"), Some("b"), "");

    assert!(build_request(&[empty_artist, empty_title]).plays.is_empty());
}
