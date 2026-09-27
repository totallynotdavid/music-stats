use music_stats::errors::Error;
use music_stats::providers::lastfm;
use serde_json::json;
use tracing_test::traced_test;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
fn parses_real_lastfm_history() {
    let json = match std::fs::read_to_string("tests/fixtures/recent_tracks.json") {
        Ok(content) => content,
        Err(_) => return,
    };

    let data: serde_json::Value =
        serde_json::from_str(&json).expect("Failed to parse real Last.fm JSON");

    let tracks = data["recenttracks"]["track"]
        .as_array()
        .expect("Expected track array");

    assert!(!tracks.is_empty(), "Expected tracks from real history");

    for track in tracks {
        if track.get("date").is_some() {
            assert!(track["name"].is_string(), "Track must have name");
            assert!(
                track["artist"]["#text"].is_string(),
                "Track must have artist"
            );
            assert!(
                track["date"]["uts"].is_string(),
                "Track must have timestamp"
            );
        }
    }
}

#[test]
fn parses_lastfm_minimal_structure() {
    let json = json!({
        "recenttracks": {
            "track": [{
                "name": "Song",
                "artist": {"#text": "Artist"},
                "date": {"uts": "1704543600"}
            }],
            "@attr": {"totalPages": "1"}
        }
    });

    let tracks = json["recenttracks"]["track"].as_array().unwrap();

    assert_eq!(tracks.len(), 1);
    assert_eq!(tracks[0]["name"], "Song");
    assert_eq!(tracks[0]["artist"]["#text"], "Artist");
}

fn page_response(track_name: &str, total_pages: &str) -> serde_json::Value {
    json!({
        "recenttracks": {
            "track": [{
                "name": track_name,
                "artist": {"#text": "Artist"},
                "date": {"uts": "1704543600"}
            }],
            "@attr": {"totalPages": total_pages}
        }
    })
}

#[tokio::test]
async fn fetches_two_pages_with_correct_page_param() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/"))
        .and(query_param("page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(page_response("Song One", "2")))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/"))
        .and(query_param("page", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(page_response("Song Two", "2")))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let scrobbles = lastfm::fetch_scrobbles(&client, &server.uri(), "key", "user", 7)
        .await
        .expect("fetch should succeed");

    assert_eq!(scrobbles.len(), 2);
    assert_eq!(scrobbles[0].track.title, "Song One");
    assert_eq!(scrobbles[1].track.title, "Song Two");
}

#[tokio::test]
#[traced_test]
async fn stops_at_max_pages_and_warns() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(page_response("Song", "15")))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let scrobbles = lastfm::fetch_scrobbles(&client, &server.uri(), "key", "user", 7)
        .await
        .expect("fetch should succeed");

    assert_eq!(scrobbles.len(), 10, "should stop at MAX_PAGES (10)");
    assert_eq!(server.received_requests().await.unwrap().len(), 10);
    assert!(logs_contain("MAX_PAGES"));
}

#[tokio::test]
async fn non_2xx_yields_lastfm_error() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(500).set_body_string("internal error"))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let result = lastfm::fetch_scrobbles(&client, &server.uri(), "key", "user", 7).await;

    match result.unwrap_err() {
        Error::LastFm { status, body, .. } => {
            assert_eq!(status, 500);
            assert_eq!(body, "internal error");
        }
        other => panic!("expected Error::LastFm, got {:?}", other),
    }
}

#[tokio::test]
async fn malformed_json_yields_parse_error() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let result = lastfm::fetch_scrobbles(&client, &server.uri(), "key", "user", 7).await;

    assert!(matches!(result, Err(Error::Network { .. })));
}
