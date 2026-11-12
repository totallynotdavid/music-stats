use crate::errors::Error;
use crate::providers::types::Scrobble;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::Value;

const JSON_PATH: &str = "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents";

const LAST_WEEK_OFFSET_DAYS: i64 = 4;
const THIS_WEEK_OFFSET_DAYS: i64 = 3;
const MONTH_MIN_AGE_DAYS: i64 = 14;

pub fn parse_scrobbles(json_str: &str) -> Result<Vec<Scrobble>, Error> {
    parse_scrobbles_on(json_str, Utc::now().date_naive())
}

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
        let Some(runs) = column
            .pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs")
            .and_then(Value::as_array)
        else {
            continue;
        };

        for run in runs {
            if let Some(endpoint) = run.get("navigationEndpoint") {
                let text = run.get("text").and_then(Value::as_str).map(String::from);
                if endpoint.get("watchEndpoint").is_some() {
                    title = title.or(text);
                } else if is_artist_endpoint(endpoint) {
                    artist = artist.or(text);
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

fn resolve_shelf_date(label: &str, today: NaiveDate) -> Option<DateTime<Utc>> {
    let lower = label.to_lowercase();
    let matches = |words: &[&str]| words.iter().any(|w| lower.contains(w));

    let date = if let Ok(date) = NaiveDate::parse_from_str(label, "%Y-%m-%d") {
        date
    } else if let Some(date) = resolve_month_heading(&lower, today) {
        date
    } else if matches(&["today", "hoy", "hoje", "oggi", "aujourd'hui"]) {
        today
    } else if matches(&["yesterday", "ayer", "ontem", "ieri", "hier"]) {
        today - Duration::days(1)
    } else if matches(&[
        "last week",
        "última semana",
        "semana passada",
        "settimana scorsa",
        "semaine dernière",
    ]) {
        today - Duration::days(LAST_WEEK_OFFSET_DAYS)
    } else if matches(&[
        "this week",
        "esta semana",
        "questa settimana",
        "cette semaine",
    ]) {
        today - Duration::days(THIS_WEEK_OFFSET_DAYS)
    } else {
        return None;
    };

    Some(date.and_hms_opt(12, 0, 0)?.and_utc())
}

/// Reads a heading such as "October 2026", "octubre de 2026" or "octobre 2026".
/// A month heading only holds plays older than the Last week heading, so the
/// date is the 15th, moved back to `MONTH_MIN_AGE_DAYS` ago for the current
/// month and kept inside the month.
fn resolve_month_heading(lower: &str, today: NaiveDate) -> Option<NaiveDate> {
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let month = words.iter().find_map(|w| month_number(w))?;
    let year = words
        .iter()
        .find(|w| w.len() == 4 && w.chars().all(|c| c.is_ascii_digit()))?
        .parse()
        .ok()?;

    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let middle = NaiveDate::from_ymd_opt(year, month, 15)?;
    let newest = today - Duration::days(MONTH_MIN_AGE_DAYS);
    Some(middle.min(newest).max(first))
}

fn month_number(word: &str) -> Option<u32> {
    const MONTHS: [&[&str]; 12] = [
        &["january", "enero", "janeiro", "gennaio", "janvier"],
        &["february", "febrero", "fevereiro", "febbraio", "février"],
        &["march", "marzo", "março", "mars"],
        &["april", "abril", "aprile", "avril"],
        &["may", "mayo", "maio", "maggio", "mai"],
        &["june", "junio", "junho", "giugno", "juin"],
        &["july", "julio", "julho", "luglio", "juillet"],
        &["august", "agosto", "août"],
        &[
            "september",
            "septiembre",
            "setiembre",
            "setembro",
            "settembre",
            "septembre",
        ],
        &["october", "octubre", "outubro", "ottobre", "octobre"],
        &["november", "noviembre", "novembro", "novembre"],
        &["december", "diciembre", "dezembro", "dicembre", "décembre"],
    ];
    let index = MONTHS.iter().position(|names| names.contains(&word))?;
    u32::try_from(index + 1).ok()
}
