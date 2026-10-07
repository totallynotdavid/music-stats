mod common;

use chrono::NaiveDate;
use common::history_json;
use music_stats::providers::youtube_json::{parse_scrobbles, parse_scrobbles_on};
use tracing_test::traced_test;

#[test]
fn parses_real_youtube_history() {
    let html = std::fs::read_to_string("tests/fixtures/history.html")
        .expect("tracked fixture tests/fixtures/history.html is missing");

    let json = music_stats::providers::youtube_parse::extract_json_from_html(&html)
        .expect("Failed to extract JSON from real fixture");

    let scrobbles = parse_scrobbles(&json).expect("Failed to parse real YouTube response");

    assert!(
        !scrobbles.is_empty(),
        "Expected scrobbles from real history"
    );

    for scrobble in &scrobbles {
        assert!(!scrobble.track.title.is_empty(), "Track must have title");
        assert!(!scrobble.track.artist.is_empty(), "Track must have artist");
    }
}

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

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2024, 3, 20).unwrap()
}

fn play_dates(heading: &str) -> Vec<String> {
    let json = history_json(&[(heading, &[("Song", "Artist")])]).to_string();

    parse_scrobbles_on(&json, today())
        .unwrap()
        .iter()
        .map(|s| s.played_at.to_rfc3339())
        .collect()
}

#[test]
fn relative_headings_resolve_to_noon_utc() {
    for label in ["Today", "Hoy", "Hoje", "Oggi", "Aujourd'hui"] {
        assert_eq!(play_dates(label), ["2024-03-20T12:00:00+00:00"], "{label}");
    }
    for label in ["Yesterday", "Ayer", "Ontem", "Ieri", "Hier"] {
        assert_eq!(play_dates(label), ["2024-03-19T12:00:00+00:00"], "{label}");
    }
}

#[test]
fn last_week_heading_resolves_four_days_back() {
    for label in ["Last week", "Última semana", "Semana passada"] {
        assert_eq!(play_dates(label), ["2024-03-16T12:00:00+00:00"], "{label}");
    }
}

#[test]
fn iso_date_heading_resolves_to_that_day() {
    assert_eq!(play_dates("2024-01-15"), ["2024-01-15T12:00:00+00:00"]);
}

#[test]
#[traced_test]
fn warns_about_a_dropped_heading() {
    assert!(play_dates("March 2024").is_empty());
    assert!(logs_contain("unrecognized heading"));
    assert!(logs_contain("March 2024"));
}

#[test]
#[traced_test]
fn empty_unrecognized_heading_is_silent() {
    let json = history_json(&[("March 2024", &[])]).to_string();

    assert!(parse_scrobbles_on(&json, today()).unwrap().is_empty());
    assert!(!logs_contain("unrecognized heading"));
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
