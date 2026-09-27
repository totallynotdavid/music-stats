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
