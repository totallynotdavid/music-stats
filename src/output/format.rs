use crate::domain::Statistics;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const MAX_TITLE_WIDTH: usize = 35;
const MAX_ARTIST_WIDTH: usize = 25;
const ALIGN_POSITION: usize = 40;

pub fn stats_to_text(statistics: &Statistics) -> String {
    if statistics.top_tracks.is_empty() {
        return "No tracks played recently".to_string();
    }
    
    statistics
        .top_tracks
        .iter()
        .map(|(track, play_count)| format_track_line(&track.title, &track.artist, *play_count))
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_track_line(title: &str, artist: &str, play_count: usize) -> String {
    let truncated_title = truncate_with_ellipsis(title, MAX_TITLE_WIDTH);
    let truncated_artist = truncate_with_ellipsis(artist, MAX_ARTIST_WIDTH);
    let padding = calculate_padding(&truncated_title);
    let count_suffix = format_play_count(play_count);
    
    format!("{}{}{}{}", truncated_title, padding, truncated_artist, count_suffix)
}

fn calculate_padding(title: &str) -> String {
    let title_width = UnicodeWidthStr::width(title);
    let padding_size = ALIGN_POSITION.saturating_sub(title_width);
    " ".repeat(padding_size)
}

fn format_play_count(count: usize) -> String {
    if count > 1 {
        format!(" ({}×)", count)
    } else {
        String::new()
    }
}

fn truncate_with_ellipsis(text: &str, max_width: usize) -> String {
    if UnicodeWidthStr::width(text) <= max_width {
        return text.to_string();
    }
    
    let mut result = String::new();
    let mut current_width = 0;
    
    for character in text.chars() {
        let char_width = character.width().unwrap_or(0);
        if current_width + char_width + 1 > max_width {
            break;
        }
        result.push(character);
        current_width += char_width;
    }
    
    result.push('…');
    result
}
