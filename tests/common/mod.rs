#![allow(dead_code)]

use serde_json::{Value, json};

/// Builds a YouTube Music history response from `(heading, plays)` shelves.
/// Each play is a `(title, artist)` pair.
pub fn history_json(shelves: &[(&str, &[(&str, &str)])]) -> Value {
    let shelves: Vec<Value> = shelves
        .iter()
        .map(|(heading, plays)| {
            let items: Vec<Value> = plays
                .iter()
                .map(|(title, artist)| item(title, artist))
                .collect();
            json!({"musicShelfRenderer": {
                "title": {"runs": [{"text": heading}]},
                "contents": items,
            }})
        })
        .collect();

    json!({"contents": {"singleColumnBrowseResultsRenderer": {"tabs": [{
        "tabRenderer": {"content": {"sectionListRenderer": {"contents": shelves}}}
    }]}}})
}

fn item(title: &str, artist: &str) -> Value {
    json!({"musicResponsiveListItemRenderer": {"flexColumns": [
        {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{
            "text": title,
            "navigationEndpoint": {"watchEndpoint": {}},
        }]}}},
        {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{
            "text": artist,
            "navigationEndpoint": {"browseEndpoint": {
                "browseEndpointContextSupportedConfigs": {
                    "browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_ARTIST"}
                }
            }},
        }]}}},
    ]}})
}

/// Wraps history JSON in the JavaScript string used by YouTube Music.
/// Structural characters use `\xNN` escapes, while non-ASCII text stays raw.
pub fn history_page(json: &Value) -> String {
    let escaped = json
        .to_string()
        .replace('{', "\\x7b")
        .replace('}', "\\x7d")
        .replace('"', "\\x22");

    format!(
        "<script>initialData.push({{path: '/browse', data: '{escaped}'}});ytcfg.set({{'YTMUSIC_INITIAL_DATA': initialData}});</script>"
    )
}
