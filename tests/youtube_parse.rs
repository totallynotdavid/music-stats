use music_stats::providers::youtube_parse::extract_json_from_html;

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
