use crate::errors::Error;
use crate::providers::types::Scrobble;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::Value;

const JSON_PATH: &str = "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents";

const LAST_WEEK_OFFSET_DAYS: i64 = 4;

pub fn parse_scrobbles(json_str: &str) -> Result<Vec<Scrobble>, Error> {
    parse_scrobbles_on(json_str, Utc::now().date_naive())
}

/// Parses with an explicit "today" (UTC), so relative headings are testable.
pub fn parse_scrobbles_on(json_str: &str, today: NaiveDate) -> Result<Vec<Scrobble>, Error> {
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

    Ok(extract_scrobbles_from_shelves(shelves, today))
}

fn extract_scrobbles_from_shelves(shelves: &[Value], today: NaiveDate) -> Vec<Scrobble> {
    let mut scrobbles = Vec::new();

    for shelf in shelves {
        if let Some(renderer) = shelf.get("musicShelfRenderer") {
            let shelf_label = renderer
                .pointer("/title/runs/0/text")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");
            let items = renderer
                .get("contents")
                .and_then(|v| v.as_array())
                .map(Vec::as_slice)
                .unwrap_or_default();

            let Some(played_at) = resolve_shelf_date(shelf_label, today) else {
                if !items.is_empty() {
                    tracing::warn!(
                        "Skipping {} YouTube plays under unrecognized heading {:?}",
                        items.len(),
                        shelf_label
                    );
                }
                continue;
            };

            for item in items {
                if let Some(list_item) = item.get("musicResponsiveListItemRenderer")
                    && let Some(scrobble) = parse_list_item(list_item, played_at)
                {
                    scrobbles.push(scrobble);
                }
            }
        }
    }

    scrobbles
}

fn parse_list_item(item: &Value, played_at: DateTime<Utc>) -> Option<Scrobble> {
    let flex_columns = item.get("flexColumns")?.as_array()?;
    let (title, artist) = extract_title_and_artist(flex_columns)?;

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

/// Maps a section heading to a day. YouTube gives no per-play time, so every
/// play in a section gets noon UTC of that day, and "Last week" (an unbounded
/// range of days) is placed `LAST_WEEK_OFFSET_DAYS` back. Unrecognized
/// headings return `None`.
fn resolve_shelf_date(label: &str, today: NaiveDate) -> Option<DateTime<Utc>> {
    let lower = label.to_lowercase();
    let matches = |words: &[&str]| words.iter().any(|w| lower.contains(w));

    let date = if let Ok(date) = NaiveDate::parse_from_str(label, "%Y-%m-%d") {
        date
    } else if matches(&["today", "hoy", "hoje", "oggi", "aujourd'hui"]) {
        today
    } else if matches(&["yesterday", "ayer", "ontem", "ieri", "hier"]) {
        today - Duration::days(1)
    } else if matches(&["last week", "última semana", "semana passada"]) {
        today - Duration::days(LAST_WEEK_OFFSET_DAYS)
    } else {
        return None;
    };

    Some(date.and_hms_opt(12, 0, 0)?.and_utc())
}
