mod common;

use common::{history_json, history_page, signed_out_page};
use music_stats::errors::Error;
use music_stats::providers::types::Scrobble;
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

async fn fetch_page(page: String) -> Result<Vec<Scrobble>, Error> {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(page))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let cookie = "__Secure-3PAPISID=testsapisid123; SOCS=CAI";

    youtube::fetch_scrobbles(&client, &server.uri(), cookie, 7).await
}

#[tokio::test]
async fn refuses_a_signed_out_page() {
    match fetch_page(signed_out_page()).await.unwrap_err() {
        Error::YouTube { stage, detail } => {
            assert_eq!(stage, "authentication");
            assert!(detail.contains("signed out"), "{detail}");
        }
        other => panic!("expected Error::YouTube, got {:?}", other),
    }
}

#[tokio::test]
async fn refuses_a_page_without_the_sign_in_flag() {
    let page = history_page(&history_json(&[])).replace(r#""LOGGED_IN":true"#, "");

    match fetch_page(page).await.unwrap_err() {
        Error::YouTube { stage, detail } => {
            assert_eq!(stage, "authentication");
            assert!(detail.contains("LOGGED_IN"), "{detail}");
        }
        other => panic!("expected Error::YouTube, got {:?}", other),
    }
}

#[tokio::test]
async fn accepts_a_signed_in_page_with_an_empty_history() {
    let plays = fetch_page(history_page(&history_json(&[])))
        .await
        .expect("an empty history is not an error");

    assert!(plays.is_empty());
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
