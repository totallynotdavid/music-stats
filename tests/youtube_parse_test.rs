use music_stats::providers::youtube_parse::extract_json_from_html;

#[test]
fn extracts_json_from_minimal_html() {
    let html = r#"
        <script>
        var data = {foo: 'bar', data: '{"test": "value"}'};
        });ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});
        </script>
    "#;

    let result = extract_json_from_html(html);
    assert!(result.is_ok());
    assert!(result.unwrap().contains("test"));
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

#[test]
fn handles_escaped_quotes_in_json() {
    let html = r#"
        <script>
        var x = {test: "value", data: '{"artist": "It\'s Good"}'};
        });ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});
        </script>
    "#;

    let result = extract_json_from_html(html);
    assert!(result.is_ok());
    assert!(result.unwrap().contains("It's Good"));
}

#[test]
fn handles_nested_braces() {
    let html = r#"
        <script>
        var x = {nested: {deep: {value: 1}}, data: '{"test": "value"}'};
        });ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});
        </script>
    "#;

    let result = extract_json_from_html(html);
    assert!(result.is_ok());
}

#[test]
fn decodes_hex_entities() {
    let html = r#"
        <script>
        var x = {data: '\x7b"test": "value"\x7d'};
        });ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});
        </script>
    "#;

    let result = extract_json_from_html(html);
    assert!(result.is_ok());
    let json = result.unwrap();
    assert!(json.contains("{"));
    assert!(json.contains("}"));
}
