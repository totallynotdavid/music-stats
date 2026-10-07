mod common;

use common::{history_json, history_page};
use music_stats::app::fetch_scrobbles;
use music_stats::config::{Config, LastFmConfig, Provider};
use music_stats::errors::Error;
use serde_json::json;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

fn config_with_both() -> Config {
    Config {
        gist_id: "gist".to_string(),
        github_token: "token".to_string(),
        provider: Provider::Both {
            lastfm: LastFmConfig {
                api_key: "key".to_string(),
                username: "user".to_string(),
            },
            youtube_cookie: "__Secure-3PAPISID=abc123; SOCS=CAI".to_string(),
        },
        days: 7,
        top_n: 5,
    }
}

#[tokio::test]
async fn returns_lastfm_scrobbles_when_youtube_fails() {
    let lastfm_server = MockServer::start().await;
    let youtube_server = MockServer::start().await;

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "recenttracks": {
                "track": [{
                    "name": "Song",
                    "artist": {"#text": "Artist"},
                    "date": {"uts": "1704543600"}
                }],
                "@attr": {"totalPages": "1"}
            }
        })))
        .mount(&lastfm_server)
        .await;

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&youtube_server)
        .await;

    let client = reqwest::Client::new();
    let config = config_with_both();

    let scrobbles = fetch_scrobbles(
        &client,
        &config,
        &lastfm_server.uri(),
        &youtube_server.uri(),
    )
    .await
    .expect("should succeed with the Last.fm data that was fetched");

    assert_eq!(scrobbles.len(), 1);
    assert_eq!(scrobbles[0].track.title, "Song");
}

#[tokio::test]
async fn fails_when_both_providers_fail() {
    let lastfm_server = MockServer::start().await;
    let youtube_server = MockServer::start().await;

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&lastfm_server)
        .await;

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&youtube_server)
        .await;

    let client = reqwest::Client::new();
    let config = config_with_both();

    let result = fetch_scrobbles(
        &client,
        &config,
        &lastfm_server.uri(),
        &youtube_server.uri(),
    )
    .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn expired_cookie_fails_instead_of_yielding_an_empty_list() {
    let youtube_server = MockServer::start().await;

    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(history_page(&history_json(&[]))))
        .mount(&youtube_server)
        .await;

    let mut config = config_with_both();
    config.provider = Provider::YouTube("__Secure-3PAPISID=abc123; SOCS=CAI".to_string());

    let result = fetch_scrobbles(
        &reqwest::Client::new(),
        &config,
        "http://127.0.0.1:1",
        &youtube_server.uri(),
    )
    .await;

    assert!(matches!(result, Err(Error::AllProvidersFailed)));
}
