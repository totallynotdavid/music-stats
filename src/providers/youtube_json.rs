use crate::errors::Error;
use crate::providers::types::{Scrobble, YouTubePlay};
use chrono::{DateTime, Duration, NaiveDate, NaiveTime, Utc};
use chrono_tz::Tz;
use serde_json::Value;

const JSON_PATH: &str = "/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents";

const LAST_WEEK_OFFSET_DAYS: i64 = 4;
const THIS_WEEK_OFFSET_DAYS: i64 = 3;
const MONTH_MIN_AGE_DAYS: i64 = 14;
const MAX_VIDEO_ID_LEN: usize = 32;

const NOON: NaiveTime = match NaiveTime::from_hms_opt(12, 0, 0) {
    Some(time) => time,
    None => panic!("12:00:00 is a valid time"),
};

pub fn today_in(now: DateTime<Utc>, tz: Tz) -> NaiveDate {
    now.with_timezone(&tz).date_naive()
}

pub fn parse_plays(json_str: &str, tz: Tz) -> Result<Vec<YouTubePlay>, Error> {
    parse_plays_on(json_str, today_in(Utc::now(), tz))
}

pub fn parse_plays_on(json_str: &str, today: NaiveDate) -> Result<Vec<YouTubePlay>, Error> {
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

    Ok(extract_plays_from_shelves(shelves, today))
}

fn extract_plays_from_shelves(shelves: &[Value], today: NaiveDate) -> Vec<YouTubePlay> {
    let mut plays = Vec::new();

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

            let Some(heading) = resolve_heading(shelf_label, today) else {
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
                    && let Some(play) = parse_list_item(list_item, heading)
                {
                    plays.push(play);
                }
            }
        }
    }

    plays
}

fn parse_list_item(item: &Value, heading: Heading) -> Option<YouTubePlay> {
    let flex_columns = item.get("flexColumns")?.as_array()?;
    let (title, artist, video_id) = extract_title_and_artist(flex_columns)?;

    Some(YouTubePlay {
        scrobble: Scrobble::new(artist, title, heading.played_at()),
        video_id,
        day: heading.day(),
    })
}

fn extract_title_and_artist(columns: &[Value]) -> Option<(String, String, Option<String>)> {
    let mut title: Option<String> = None;
    let mut video_id: Option<String> = None;
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
                if let Some(watch) = endpoint.get("watchEndpoint") {
                    if title.is_none() {
                        title = text;
                        video_id = watch
                            .get("videoId")
                            .and_then(Value::as_str)
                            .filter(|id| is_video_id(id))
                            .map(String::from);
                    }
                } else if is_artist_endpoint(endpoint) {
                    artist = artist.or(text);
                }
            }
        }
    }

    Some((
        title?,
        artist.unwrap_or_else(|| "Unknown Artist".to_string()),
        video_id,
    ))
}

fn is_video_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_VIDEO_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_artist_endpoint(endpoint: &Value) -> bool {
    endpoint.pointer("/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
        .and_then(|v| v.as_str())
        .map(|t| t == "MUSIC_PAGE_TYPE_ARTIST")
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy)]
enum Heading {
    Day(NaiveDate),
    Span(NaiveDate),
}

impl Heading {
    fn date(self) -> NaiveDate {
        match self {
            Heading::Day(date) | Heading::Span(date) => date,
        }
    }

    fn day(self) -> Option<NaiveDate> {
        match self {
            Heading::Day(date) => Some(date),
            Heading::Span(_) => None,
        }
    }

    fn played_at(self) -> DateTime<Utc> {
        self.date().and_time(NOON).and_utc()
    }
}

fn resolve_heading(label: &str, today: NaiveDate) -> Option<Heading> {
    let lower = label.to_lowercase();
    let matches = |words: &[&str]| words.iter().any(|w| lower.contains(w));

    let heading = if let Ok(date) = NaiveDate::parse_from_str(label, "%Y-%m-%d") {
        Heading::Day(date)
    } else if let Some(date) = resolve_month_heading(&lower, today) {
        Heading::Span(date)
    } else if matches(&["today", "hoy", "hoje", "oggi", "aujourd'hui"]) {
        Heading::Day(today)
    } else if matches(&["yesterday", "ayer", "ontem", "ieri", "hier"]) {
        Heading::Day(today - Duration::days(1))
    } else if matches(&[
        "last week",
        "última semana",
        "semana passada",
        "settimana scorsa",
        "semaine dernière",
    ]) {
        Heading::Span(today - Duration::days(LAST_WEEK_OFFSET_DAYS))
    } else if matches(&[
        "this week",
        "esta semana",
        "questa settimana",
        "cette semaine",
    ]) {
        Heading::Span(today - Duration::days(THIS_WEEK_OFFSET_DAYS))
    } else {
        return None;
    };

    Some(heading)
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
