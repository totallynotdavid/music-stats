mod common;

use common::{history_json, history_page};
use music_stats::providers::youtube_json::parse_scrobbles;
use music_stats::providers::youtube_parse::extract_json_from_html;

#[test]
fn keeps_non_ascii_text_from_the_recorded_page() {
    let html = std::fs::read_to_string("tests/fixtures/history.html").expect("fixture missing");

    let json = extract_json_from_html(&html).expect("extract");
    let plays = parse_scrobbles(&json).expect("parse");

    let spanish = plays
        .iter()
        .find(|s| s.track.artist.starts_with("Pelo Mad"));
    assert_eq!(spanish.expect("track missing").track.artist, "Pelo Madueño");

    let korean = plays.iter().find(|s| s.track.artist == "PENTAGON");
    assert_eq!(korean.expect("track missing").track.title, "Shine (빛나리)");
}

#[test]
fn decodes_utf8_spelled_as_hex_escapes() {
    let page = history_page(&history_json(&[("2024-01-15", &[("Ünï", "Artist")])]))
        .replace("Ünï", "\\xc3\\x9cn\\xc3\\xaf");

    let json = extract_json_from_html(&page).expect("extract");
    let plays = parse_scrobbles(&json).expect("parse");

    assert_eq!(plays[0].track.title, "Ünï");
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
