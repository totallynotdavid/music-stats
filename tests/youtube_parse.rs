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
fn fails_when_hex_escapes_are_not_utf8() {
    let page = history_page(&history_json(&[("2024-01-15", &[("Bad", "Artist")])]))
        .replace("Bad", "\\xff\\xfe");

    let err = extract_json_from_html(&page).unwrap_err();
    assert!(format!("{}", err).contains("UTF-8"));
}

#[test]
fn fails_when_marker_missing() {
    let html = "<html><body>No marker here</body></html>";

    let result = extract_json_from_html(html);
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(format!("{}", err).contains("marker not found"));
}

#[test]
fn fails_when_opening_brace_missing() {
    let html = "});ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});";

    let result = extract_json_from_html(html);
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(format!("{}", err).contains("Opening brace"));
}

#[test]
fn fails_when_data_field_missing() {
    let html = r#"
        <script>
        var x = {foo: 'bar'};
        });ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});
        </script>
    "#;

    let result = extract_json_from_html(html);
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(format!("{}", err).contains("data field"));
}
