mod common;

use common::{history_json, history_page};
use music_stats::errors::Error;
use music_stats::providers::youtube;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn returns_authentication_error_on_401() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let cookie = "__Secure-3PAPISID=testsapisid123; SOCS=CAI";

    let result = youtube::fetch_scrobbles(&client, &server.uri(), cookie, 7).await;

    match result.unwrap_err() {
        Error::YouTube { stage, .. } => assert_eq!(stage, "authentication"),
        other => panic!("expected Error::YouTube, got {:?}", other),
    }
}

#[tokio::test]
async fn refuses_a_history_page_without_plays() {
    let server = MockServer::start().await;
    let page = history_page(&history_json(&[]));

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(page))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let cookie = "__Secure-3PAPISID=testsapisid123; SOCS=CAI";

    let result = youtube::fetch_scrobbles(&client, &server.uri(), cookie, 7).await;

    match result.unwrap_err() {
        Error::YouTube { stage, detail } => {
            assert_eq!(stage, "history");
            assert!(detail.contains("expired"));
        }
        other => panic!("expected Error::YouTube, got {:?}", other),
    }
}

#[tokio::test]
async fn a_window_longer_than_the_clock_keeps_every_play() {
    let server = MockServer::start().await;
    let page = history_page(&history_json(&[("2024-01-15", &[("Song", "Artist")])]));

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(page))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let cookie = "__Secure-3PAPISID=testsapisid123; SOCS=CAI";

    for days in [u64::MAX, 1 << 60] {
        let plays = youtube::fetch_scrobbles(&client, &server.uri(), cookie, days)
            .await
            .unwrap_or_else(|error| panic!("days={days}: {error}"));

        assert_eq!(plays.len(), 1, "days={days}");
    }
}

#[tokio::test]
async fn returns_plays_from_the_history_page() {
    let server = MockServer::start().await;
    let page = history_page(&history_json(&[("Today", &[("Canción", "Artista")])]));

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(page))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let cookie = "__Secure-3PAPISID=testsapisid123; SOCS=CAI";

    let plays = youtube::fetch_scrobbles(&client, &server.uri(), cookie, 7)
        .await
        .expect("fetch should succeed");

    assert_eq!(plays.len(), 1);
    assert_eq!(plays[0].track.title, "Canción");
}
