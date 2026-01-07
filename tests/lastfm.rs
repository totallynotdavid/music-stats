use serde_json::json;

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
