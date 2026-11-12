mod common;

use chrono_tz::Tz;
use common::{history_json, history_page};
use music_stats::app::fetch_plays;
use music_stats::config::{Config, GistConfig, LastFmConfig, Provider, UploadConfig};
use music_stats::errors::Error;
use serde_json::json;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

const COOKIE: &str = "__Secure-3PAPISID=abc123; SOCS=CAI";

fn gist() -> Option<GistConfig> {
    Some(GistConfig {
        id: "gist".to_string(),
        token: "token".to_string(),
    })
}

fn upload() -> Option<UploadConfig> {
    Some(UploadConfig {
        url: "https://example.invalid".to_string(),
        token: "msu_token".to_string(),
    })
}

fn config_with_both() -> Config {
    Config {
        gist: gist(),
        upload: None,
        provider: Provider::Both {
            lastfm: LastFmConfig {
                api_key: "key".to_string(),
                username: "user".to_string(),
            },
            youtube_cookie: COOKIE.to_string(),
        },
        timezone: Tz::UTC,
        days: 7,
        top_n: 5,
    }
}

fn youtube_config(gist: Option<GistConfig>, days: u64) -> Config {
    Config {
        gist,
        upload: upload(),
        provider: Provider::YouTube(COOKIE.to_string()),
        timezone: Tz::UTC,
        days,
        top_n: 5,
    }
}

async fn youtube_server(headings: &[(&str, &[(&str, &str)])]) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(history_page(&history_json(headings))),
        )
        .mount(&server)
        .await;
    server
}

const OLD_AND_NEW: &[(&str, &[(&str, &str)])] = &[
    ("Today", &[("New", "Artist")]),
    ("2024-01-15", &[("Old", "Artist")]),
];

#[tokio::test]
async fn days_limits_the_gist_and_not_the_upload() {
    let server = youtube_server(OLD_AND_NEW).await;
    let client = reqwest::Client::new();

    let fetched = fetch_plays(
        &client,
        &youtube_config(gist(), 7),
        "http://unused.invalid",
        &server.uri(),
    )
    .await
    .unwrap();

    let titles: Vec<_> = fetched
        .scrobbles
        .iter()
        .map(|s| s.track.title.as_str())
        .collect();
    assert_eq!(titles, ["New"]);
    assert_eq!(fetched.youtube_plays.len(), 2);
}

#[tokio::test]
async fn a_window_longer_than_the_clock_keeps_every_play() {
    let server = youtube_server(OLD_AND_NEW).await;
    let client = reqwest::Client::new();

    for days in [u64::MAX, 1 << 60] {
        let fetched = fetch_plays(
            &client,
            &youtube_config(gist(), days),
            "http://unused.invalid",
            &server.uri(),
        )
        .await
        .unwrap_or_else(|error| panic!("days={days}: {error}"));

        assert_eq!(fetched.scrobbles.len(), 2, "days={days}");
    }
}

#[tokio::test]
async fn without_a_gist_nothing_is_counted_for_it() {
    let server = youtube_server(OLD_AND_NEW).await;
    let client = reqwest::Client::new();

    let fetched = fetch_plays(
        &client,
        &youtube_config(None, 7),
        "http://unused.invalid",
        &server.uri(),
    )
    .await
    .unwrap();

    assert!(fetched.scrobbles.is_empty());
    assert_eq!(fetched.youtube_plays.len(), 2);
}

#[tokio::test]
async fn last_fm_is_not_fetched_without_a_gist() {
    let lastfm_server = MockServer::start().await;
    let youtube_server = youtube_server(OLD_AND_NEW).await;
    let mut config = youtube_config(None, 7);
    config.provider = Provider::Both {
        lastfm: LastFmConfig {
            api_key: "key".to_string(),
            username: "user".to_string(),
        },
        youtube_cookie: COOKIE.to_string(),
    };

    let fetched = fetch_plays(
        &reqwest::Client::new(),
        &config,
        &lastfm_server.uri(),
        &youtube_server.uri(),
    )
    .await
    .unwrap();

    assert!(fetched.failed.is_empty());
    assert!(lastfm_server.received_requests().await.unwrap().is_empty());
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

    let fetched = fetch_plays(
        &client,
        &config,
        &lastfm_server.uri(),
        &youtube_server.uri(),
    )
    .await
    .expect("should succeed with the Last.fm data that was fetched");

    assert_eq!(fetched.scrobbles.len(), 1);
    assert_eq!(fetched.scrobbles[0].track.title, "Song");
    assert_eq!(fetched.failed, ["YouTube"]);
}

#[test]
fn a_partial_failure_names_the_missing_providers() {
    let error = Error::SomeProvidersFailed {
        providers: vec!["YouTube"],
    };

    assert!(error.to_string().contains("without YouTube"), "{error}");
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

    let result = fetch_plays(
        &client,
        &config,
        &lastfm_server.uri(),
        &youtube_server.uri(),
    )
    .await;

    assert!(matches!(result, Err(Error::AllProvidersFailed)));
}
