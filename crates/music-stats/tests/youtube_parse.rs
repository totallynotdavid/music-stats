mod common;

use chrono_tz::Tz;
use common::{history_json, history_page};
use music_stats::providers::youtube_json::parse_plays;
use music_stats::providers::youtube_parse::{ensure_signed_in, extract_json_from_html};

#[test]
fn reads_every_play_of_the_recorded_page() {
    let html = std::fs::read_to_string("tests/fixtures/history.html").expect("fixture missing");

    ensure_signed_in(&html).expect("the recorded page is signed in");
    let json = extract_json_from_html(&html).expect("extract");
    let plays = parse_plays(&json, Tz::UTC).expect("parse");

    assert_eq!(plays.len(), 200, "every play on the page is kept");

    let collaboration = plays.iter().find(|s| s.scrobble.track.title == "Golden");
    assert_eq!(
        collaboration.expect("track missing").scrobble.track.artist,
        "HUNTR/X",
        "the first credited artist names the play"
    );

    let spanish = plays
        .iter()
        .find(|s| s.scrobble.track.artist.starts_with("Pelo Mad"));
    assert_eq!(
        spanish.expect("track missing").scrobble.track.artist,
        "Pelo Madueño"
    );

    let korean = plays.iter().find(|s| s.scrobble.track.artist == "PENTAGON");
    assert_eq!(
        korean.expect("track missing").scrobble.track.title,
        "Shine (빛나리)"
    );
}

#[test]
fn reads_the_video_id_of_every_play_of_the_recorded_page() {
    let html = std::fs::read_to_string("tests/fixtures/history.html").expect("fixture missing");
    let json = extract_json_from_html(&html).expect("extract");

    let plays = parse_plays(&json, Tz::UTC).expect("parse");

    assert_eq!(
        plays[0].video_id.as_deref(),
        Some("rSvTmvpx0JI"),
        "the newest play comes first"
    );
    let without_id = plays.iter().filter(|p| p.video_id.is_none()).count();
    assert_eq!(without_id, 0, "every recorded play carries a video id");
}

#[test]
fn decodes_utf8_spelled_as_hex_escapes() {
    let page = history_page(&history_json(&[("2024-01-15", &[("Ünï", "Artist")])]))
        .replace("Ünï", "\\xc3\\x9cn\\xc3\\xaf");

    let json = extract_json_from_html(&page).expect("extract");
    let plays = parse_plays(&json, Tz::UTC).expect("parse");

    assert_eq!(plays[0].scrobble.track.title, "Ünï");
}

#[test]
fn rejects_pages_it_cannot_extract() {
    let not_utf8 = history_page(&history_json(&[("2024-01-15", &[("Bad", "Artist")])]))
        .replace("Bad", "\\xff\\xfe");
    let cases = [
        (not_utf8.as_str(), "UTF-8"),
        (
            "<html><body>No marker here</body></html>",
            "marker not found",
        ),
        (
            "});ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});",
            "Opening brace",
        ),
        (
            "<script>var x = {foo: 'bar'};});ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});</script>",
            "data field",
        ),
    ];

    for (html, message) in cases {
        let error = extract_json_from_html(html).unwrap_err().to_string();

        assert!(error.contains(message), "{error:?} lacks {message:?}");
    }
}
