use music_stats::providers::youtube_json::parse_scrobbles;

#[test]
fn parses_minimal_valid_structure() {
    let json = r#"{
        "contents": {
            "singleColumnBrowseResultsRenderer": {
                "tabs": [{
                    "tabRenderer": {
                        "content": {
                            "sectionListRenderer": {
                                "contents": [{
                                    "musicShelfRenderer": {
                                        "title": {"runs": [{"text": "2024-01-15"}]},
                                        "contents": [{
                                            "musicResponsiveListItemRenderer": {
                                                "flexColumns": [
                                                    {
                                                        "musicResponsiveListItemFlexColumnRenderer": {
                                                            "text": {
                                                                "runs": [{
                                                                    "text": "Song Title",
                                                                    "navigationEndpoint": {
                                                                        "watchEndpoint": {}
                                                                    }
                                                                }]
                                                            }
                                                        }
                                                    },
                                                    {
                                                        "musicResponsiveListItemFlexColumnRenderer": {
                                                            "text": {
                                                                "runs": [{
                                                                    "text": "Artist Name",
                                                                    "navigationEndpoint": {
                                                                        "browseEndpoint": {
                                                                            "browseEndpointContextSupportedConfigs": {
                                                                                "browseEndpointContextMusicConfig": {
                                                                                    "pageType": "MUSIC_PAGE_TYPE_ARTIST"
                                                                                }
                                                                            }
                                                                        }
                                                                    }
                                                                }]
                                                            }
                                                        }
                                                    }
                                                ]
                                            }
                                        }]
                                    }
                                }]
                            }
                        }
                    }
                }]
            }
        }
    }"#;

    let result = parse_scrobbles(json);
    assert!(result.is_ok());

    let scrobbles = result.unwrap();
    assert_eq!(scrobbles.len(), 1);
    assert_eq!(scrobbles[0].track.title, "Song Title");
    assert_eq!(scrobbles[0].track.artist, "Artist Name");
}

#[test]
fn fails_on_invalid_json() {
    let json = "not valid json{";

    let result = parse_scrobbles(json);
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(format!("{}", err).contains("Invalid JSON"));
}

#[test]
fn fails_on_missing_expected_structure() {
    let json = r#"{"contents": {}}"#;

    let result = parse_scrobbles(json);
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(format!("{}", err).contains("Expected structure not found"));
}

#[test]
fn handles_today_date_label() {
    let json = r#"{
        "contents": {
            "singleColumnBrowseResultsRenderer": {
                "tabs": [{
                    "tabRenderer": {
                        "content": {
                            "sectionListRenderer": {
                                "contents": [{
                                    "musicShelfRenderer": {
                                        "title": {"runs": [{"text": "Today"}]},
                                        "contents": []
                                    }
                                }]
                            }
                        }
                    }
                }]
            }
        }
    }"#;

    let result = parse_scrobbles(json);
    assert!(result.is_ok());
}

#[test]
fn handles_localized_date_labels() {
    let test_labels = vec!["Hoy", "Hoje", "Oggi", "Aujourd'hui"];

    for label in test_labels {
        let json = format!(
            r#"{{
            "contents": {{
                "singleColumnBrowseResultsRenderer": {{
                    "tabs": [{{
                        "tabRenderer": {{
                            "content": {{
                                "sectionListRenderer": {{
                                    "contents": [{{
                                        "musicShelfRenderer": {{
                                            "title": {{"runs": [{{"text": "{}"}}]}},
                                            "contents": []
                                        }}
                                    }}]
                                }}
                            }}
                        }}
                    }}]
                }}
            }}
        }}"#,
            label
        );

        let result = parse_scrobbles(&json);
        assert!(result.is_ok(), "Failed for label: {}", label);
    }
}

#[test]
fn skips_items_without_artist() {
    let json = r#"{
        "contents": {
            "singleColumnBrowseResultsRenderer": {
                "tabs": [{
                    "tabRenderer": {
                        "content": {
                            "sectionListRenderer": {
                                "contents": [{
                                    "musicShelfRenderer": {
                                        "title": {"runs": [{"text": "2024-01-15"}]},
                                        "contents": [{
                                            "musicResponsiveListItemRenderer": {
                                                "flexColumns": [{
                                                    "musicResponsiveListItemFlexColumnRenderer": {
                                                        "text": {
                                                            "runs": [{
                                                                "text": "Song Title",
                                                                "navigationEndpoint": {"watchEndpoint": {}}
                                                            }]
                                                        }
                                                    }
                                                }]
                                            }
                                        }]
                                    }
                                }]
                            }
                        }
                    }
                }]
            }
        }
    }"#;

    let result = parse_scrobbles(json);
    assert!(result.is_ok());

    let scrobbles = result.unwrap();
    assert_eq!(scrobbles.len(), 1);
    assert_eq!(scrobbles[0].track.artist, "Unknown Artist");
}

#[test]
fn skips_items_without_valid_date() {
    let json = r#"{
        "contents": {
            "singleColumnBrowseResultsRenderer": {
                "tabs": [{
                    "tabRenderer": {
                        "content": {
                            "sectionListRenderer": {
                                "contents": [{
                                    "musicShelfRenderer": {
                                        "title": {"runs": [{"text": "Invalid Date Label"}]},
                                        "contents": [{
                                            "musicResponsiveListItemRenderer": {
                                                "flexColumns": [
                                                    {
                                                        "musicResponsiveListItemFlexColumnRenderer": {
                                                            "text": {
                                                                "runs": [{
                                                                    "text": "Song",
                                                                    "navigationEndpoint": {"watchEndpoint": {}}
                                                                }]
                                                            }
                                                        }
                                                    },
                                                    {
                                                        "musicResponsiveListItemFlexColumnRenderer": {
                                                            "text": {
                                                                "runs": [{
                                                                    "text": "Artist",
                                                                    "navigationEndpoint": {
                                                                        "browseEndpoint": {
                                                                            "browseEndpointContextSupportedConfigs": {
                                                                                "browseEndpointContextMusicConfig": {
                                                                                    "pageType": "MUSIC_PAGE_TYPE_ARTIST"
                                                                                }
                                                                            }
                                                                        }
                                                                    }
                                                                }]
                                                            }
                                                        }
                                                    }
                                                ]
                                            }
                                        }]
                                    }
                                }]
                            }
                        }
                    }
                }]
            }
        }
    }"#;

    let result = parse_scrobbles(json);
    assert!(result.is_ok());

    let scrobbles = result.unwrap();
    assert_eq!(scrobbles.len(), 0);
}
