use crate::errors::Error;
use crate::providers::types::Scrobble;
use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use serde_json::Value;

const JSON_PATH: &str = "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents";

pub fn parse_scrobbles(json_str: &str) -> Result<Vec<Scrobble>, Error> {
    let json: Value = serde_json::from_str(json_str).map_err(|e| Error::YouTube {
        stage: "json_parsing".to_string(),
        detail: format!("Invalid JSON: {}", e),
    })?;

    let shelves = json
        .pointer(JSON_PATH)
        .and_then(|v| v.as_array())
        .ok_or_else(|| Error::YouTube {
            stage: "json_parsing".to_string(),
            detail: "Expected structure not found in JSON".to_string(),
        })?;

    let scrobbles = extract_scrobbles_from_shelves(shelves)?;
    Ok(scrobbles)
}

fn extract_scrobbles_from_shelves(shelves: &[Value]) -> Result<Vec<Scrobble>, Error> {
    let mut scrobbles = Vec::new();

    for shelf in shelves {
        if let Some(renderer) = shelf.get("musicShelfRenderer") {
            let shelf_label = renderer
                .pointer("/title/runs/0/text")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");

            let shelf_date = resolve_shelf_date(shelf_label);

            if let Some(contents) = renderer.get("contents").and_then(|v| v.as_array()) {
                for item in contents {
                    if let Some(list_item) = item.get("musicResponsiveListItemRenderer") {
                        if let Some(scrobble) = parse_list_item(list_item, &shelf_date) {
                            scrobbles.push(scrobble);
                        }
                    }
                }
            }
        }
    }

    Ok(scrobbles)
}

fn parse_list_item(item: &Value, shelf_date: &str) -> Option<Scrobble> {
    let flex_columns = item.get("flexColumns")?.as_array()?;
    let (title, artist) = extract_title_and_artist(flex_columns)?;
    let played_at = parse_shelf_date(shelf_date)?;

    Some(Scrobble::new(artist, title, played_at))
}

fn extract_title_and_artist(columns: &[Value]) -> Option<(String, String)> {
    let mut title: Option<String> = None;
    let mut artist: Option<String> = None;

    for column in columns {
        let runs = column
            .pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs")?
            .as_array()?;

        for run in runs {
            if let Some(endpoint) = run.get("navigationEndpoint") {
                if endpoint.get("watchEndpoint").is_some() {
                    title = run.get("text").and_then(|v| v.as_str()).map(String::from);
                } else if is_artist_endpoint(endpoint) {
                    artist = run.get("text").and_then(|v| v.as_str()).map(String::from);
                }
            }
        }
    }

    Some((
        title?,
        artist.unwrap_or_else(|| "Unknown Artist".to_string()),
    ))
}

fn is_artist_endpoint(endpoint: &Value) -> bool {
    endpoint.pointer("/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
        .and_then(|v| v.as_str())
        .map(|t| t == "MUSIC_PAGE_TYPE_ARTIST")
        .unwrap_or(false)
}

fn resolve_shelf_date(label: &str) -> String {
    let lower = label.to_lowercase();

    if ["today", "hoy", "hoje", "oggi", "aujourd'hui"]
        .iter()
        .any(|m| lower.contains(m))
    {
        return Local::now().format("%Y-%m-%d").to_string();
    }

    if ["yesterday", "ayer", "ontem", "ieri", "hier"]
        .iter()
        .any(|m| lower.contains(m))
    {
        return (Local::now() - Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
    }

    label.to_string()
}

fn parse_shelf_date(date_str: &str) -> Option<DateTime<Utc>> {
    if let Ok(naive) = NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
        return naive.and_hms_opt(12, 0, 0)?.and_utc().into();
    }

    let lower = date_str.to_lowercase();
    if ["last week", "última semana", "semana passada"]
        .iter()
        .any(|m| lower.contains(m))
    {
        return Some(Utc::now() - Duration::days(4));
    }

    None
}
