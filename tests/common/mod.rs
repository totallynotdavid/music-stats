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

pub fn video_id_for(title: &str) -> String {
    title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn item(title: &str, artist: &str) -> Value {
    json!({"musicResponsiveListItemRenderer": {"flexColumns": [
        {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{
            "text": title,
            "navigationEndpoint": {"watchEndpoint": {"videoId": video_id_for(title)}},
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

/// Wraps history JSON in the JavaScript string used by YouTube Music, on a
/// signed-in page. Structural characters use `\xNN` escapes, while non-ASCII
/// text stays raw.
pub fn history_page(json: &Value) -> String {
    page_with_sign_in(json, r#"ytcfg.set({"LOGGED_IN":true});"#)
}

/// The page YouTube Music returns for a cookie that is no longer signed in.
pub fn signed_out_page() -> String {
    page_with_sign_in(&history_json(&[]), r#"ytcfg.set({"LOGGED_IN":false});"#)
}

fn page_with_sign_in(json: &Value, ytcfg: &str) -> String {
    let escaped = json
        .to_string()
        .replace('{', "\\x7b")
        .replace('}', "\\x7d")
        .replace('"', "\\x22");

    format!(
        "<script>{ytcfg}</script><script>initialData.push({{path: '/browse', data: '{escaped}'}});ytcfg.set({{'YTMUSIC_INITIAL_DATA': initialData}});</script>"
    )
}
