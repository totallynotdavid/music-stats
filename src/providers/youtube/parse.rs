use crate::domain::{Scrobble, Track};
use crate::errors::Error;
use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use serde_json::Value;

pub fn parse_history_html(html: &str, days: u64) -> Result<Vec<Scrobble>, Error> {
    let json_string = extract_json_from_html(html)?;
    let history_items = parse_json_to_items(&json_string)?;
    let scrobbles = filter_items_by_date(history_items, days);
    Ok(scrobbles)
}

fn extract_json_from_html(html: &str) -> Result<String, Error> {
    tracing::debug!("HTML length: {}", html.len());
    
    let marker = "});ytcfg.set({'YTMUSIC_INITIAL_DATA': initialData});";
    
    if let Some(marker_pos) = html.find(marker) {
        tracing::debug!("Found YTMUSIC_INITIAL_DATA marker at position {}", marker_pos);
        
        let before_marker = &html[..marker_pos];
        
        if let Some(js_obj_start) = before_marker.rfind('{') {
            tracing::debug!("Found opening brace at position {}", js_obj_start);
            
            if let Some(js_obj_escaped) = extract_balanced_json(html, js_obj_start) {
                let js_obj_decoded = decode_html_entities(&js_obj_escaped);
                tracing::debug!("Decoded JS object length: {}", js_obj_decoded.len());
                
                if let Some(data_start) = js_obj_decoded.find(", data: '") {
                    let json_start_pos = data_start + ", data: '".len();
                    let remaining = &js_obj_decoded[json_start_pos..];
                    
                    if let Some(closing_pos) = remaining.rfind("'}") {
                        let json_str = &remaining[..closing_pos];
                        tracing::debug!("Extracted JSON from data field, length: {}", json_str.len());
                        
                        let json_unescaped = json_str.replace(r"\'", "'").replace(r"\\", "\\");
                        std::fs::write("/tmp/youtube_extracted.json", &json_unescaped).ok();
                        
                        return Ok(json_unescaped);
                    }
                }
            }
        }
    }
    
    Err(Error::YouTubeScraping {
        detail: "No YouTube Music data found in HTML".to_string(),
    })
}

fn decode_html_entities(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() && bytes[i + 1] == b'x' {
            let hex_str = std::str::from_utf8(&bytes[i + 2..i + 4]).unwrap_or("");
            if let Ok(byte_val) = u8::from_str_radix(hex_str, 16) {
                result.push(byte_val as char);
                i += 4;
                continue;
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    
    result
}

fn extract_balanced_json(html: &str, start: usize) -> Option<String> {
    let bytes = html.as_bytes();
    let mut index = start;
    let length = bytes.len();
    let mut depth = 0;
    let mut in_string = false;
    let mut escape = false;
    
    while index < length {
        let character = bytes[index] as char;
        
        if in_string {
            if escape {
                escape = false;
            } else if character == '\\' {
                escape = true;
            } else if character == '"' {
                in_string = false;
            }
        } else {
            match character {
                '"' => in_string = true,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(html[start..=index].to_string());
                    }
                }
                _ => {}
            }
        }
        
        index += 1;
    }
    
    None
}

fn parse_json_to_items(json_string: &str) -> Result<Vec<HistoryItem>, Error> {
    let json: Value = serde_json::from_str(json_string).map_err(|error| {
        Error::YouTubeScraping {
            detail: format!("Invalid JSON: {}", error),
        }
    })?;
    
    std::fs::write("/tmp/youtube_json.json", serde_json::to_string_pretty(&json).unwrap_or_default()).ok();
    tracing::debug!("Saved parsed JSON to /tmp/youtube_json.json");
    
    let shelves = navigate_to_shelves(&json)?;
    let items = extract_items_from_shelves(shelves)?;
    Ok(items)
}

fn navigate_to_shelves(json: &Value) -> Result<&Vec<Value>, Error> {
    json.pointer("/contents/singleColumnBrowseResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents")
        .and_then(|value| value.as_array())
        .ok_or_else(|| Error::YouTubeScraping {
            detail: "Expected structure not found in JSON".to_string(),
        })
}

fn extract_items_from_shelves(shelves: &[Value]) -> Result<Vec<HistoryItem>, Error> {
    let mut items = Vec::new();
    
    for shelf in shelves {
        if let Some(renderer) = shelf.get("musicShelfRenderer") {
            let shelf_label = renderer
                .pointer("/title/runs/0/text")
                .and_then(|value| value.as_str())
                .unwrap_or("Unknown");
            
            let shelf_date = resolve_shelf_date(shelf_label);
            
            if let Some(contents) = renderer.get("contents").and_then(|value| value.as_array()) {
                for item in contents {
                    if let Some(list_item) = item.get("musicResponsiveListItemRenderer") {
                        if let Some(history_item) = parse_list_item(list_item, &shelf_date) {
                            items.push(history_item);
                        }
                    }
                }
            }
        }
    }
    
    Ok(items)
}

fn parse_list_item(list_item: &Value, shelf_date: &str) -> Option<HistoryItem> {
    let flex_columns = list_item.get("flexColumns")?.as_array()?;
    
    let mut title: Option<String> = None;
    let mut artist: Option<String> = None;
    
    for column in flex_columns {
        let runs = column.pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs")?.as_array()?;
        
        for run in runs {
            if let Some(endpoint) = run.get("navigationEndpoint") {
                if endpoint.get("watchEndpoint").is_some() {
                    title = run.get("text").and_then(|value| value.as_str()).map(String::from);
                } else if let Some(page_type) = endpoint.pointer(
                    "/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType"
                ).and_then(|value| value.as_str()) {
                    if page_type == "MUSIC_PAGE_TYPE_ARTIST" {
                        artist = run.get("text").and_then(|value| value.as_str()).map(String::from);
                    }
                }
            }
        }
    }
    
    let parsed_date = parse_shelf_date(shelf_date)?;
    
    Some(HistoryItem {
        title: title?,
        artist: artist.unwrap_or_else(|| "Unknown Artist".to_string()),
        played_at: parsed_date,
    })
}

fn resolve_shelf_date(label: &str) -> String {
    let today_markers = ["today", "hoy", "hoje", "oggi", "aujourd'hui"];
    let yesterday_markers = ["yesterday", "ayer", "ontem", "ieri", "hier"];
    
    let lowercase = label.to_lowercase();
    
    if today_markers.iter().any(|marker| lowercase.contains(marker)) {
        return Local::now().format("%Y-%m-%d").to_string();
    }
    
    if yesterday_markers.iter().any(|marker| lowercase.contains(marker)) {
        return (Local::now() - Duration::days(1)).format("%Y-%m-%d").to_string();
    }
    
    label.to_string()
}

fn parse_shelf_date(shelf_date: &str) -> Option<DateTime<Utc>> {
    if let Ok(parsed) = NaiveDate::parse_from_str(shelf_date, "%Y-%m-%d") {
        return Some(parsed.and_hms_opt(12, 0, 0)?.and_utc());
    }
    
    let last_week_markers = ["last week", "última semana", "semana passada"];
    let lowercase = shelf_date.to_lowercase();
    
    if last_week_markers.iter().any(|marker| lowercase.contains(marker)) {
        return Some(Utc::now() - Duration::days(4));
    }
    
    None
}

fn filter_items_by_date(items: Vec<HistoryItem>, days: u64) -> Vec<Scrobble> {
    let cutoff = Utc::now() - Duration::days(days as i64);
    
    items
        .into_iter()
        .filter(|item| item.played_at >= cutoff)
        .map(|item| Scrobble {
            track: Track {
                artist: item.artist,
                title: item.title,
            },
            played_at: item.played_at,
        })
        .collect()
}

struct HistoryItem {
    title: String,
    artist: String,
    played_at: DateTime<Utc>,
}
