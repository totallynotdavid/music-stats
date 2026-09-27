use music_stats::errors::Error;
use music_stats::output::github;
use serde_json::json;
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn sends_expected_patch_body_on_success() {
    let server = MockServer::start().await;

    let expected_body = json!({
        "description": "What I've been listening to",
        "files": {
            "lastfm-recent-tracks": {
                "content": "Song - Artist"
            }
        }
    });

    Mock::given(method("PATCH"))
        .and(path("/gists/abc123"))
        .and(body_json(expected_body))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let result =
        github::upload_gist(&client, &server.uri(), "abc123", "token", "Song - Artist").await;

    assert!(result.is_ok());
}

#[tokio::test]
async fn non_2xx_yields_gist_error() {
    let server = MockServer::start().await;

    Mock::given(method("PATCH"))
        .respond_with(ResponseTemplate::new(422).set_body_string("validation failed"))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let result = github::upload_gist(&client, &server.uri(), "abc123", "token", "content").await;

    match result.unwrap_err() {
        Error::Gist { status, body, .. } => {
            assert_eq!(status, 422);
            assert_eq!(body, "validation failed");
        }
        other => panic!("expected Error::Gist, got {:?}", other),
    }
}
