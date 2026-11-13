use crate::aggregate::Statistics;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const MAX_TITLE_WIDTH: usize = 35;
const MAX_ARTIST_WIDTH: usize = 25;
const ALIGN_POSITION: usize = 40;

pub fn format_statistics(stats: &Statistics) -> String {
    if stats.top_tracks.is_empty() {
        return "No tracks played recently".to_string();
    }

    stats
        .top_tracks
        .iter()
        .map(|(track, count)| format_track_line(&track.title, &track.artist, *count))
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_track_line(title: &str, artist: &str, count: usize) -> String {
    let truncated_title = truncate_with_ellipsis(title, MAX_TITLE_WIDTH);
    let truncated_artist = truncate_with_ellipsis(artist, MAX_ARTIST_WIDTH);
    let padding = calculate_padding(&truncated_title);
    let count_suffix = format_play_count(count);

    format!(
        "{}{}{}{}",
        truncated_title, padding, truncated_artist, count_suffix
    )
}

fn truncate_with_ellipsis(text: &str, max_width: usize) -> String {
    if UnicodeWidthStr::width(text) <= max_width {
        return text.to_string();
    }

    let mut result = String::new();
    let mut current_width = 0;

    for ch in text.chars() {
        let ch_width = ch.width().unwrap_or(0);
        if current_width + ch_width + 1 > max_width {
            break;
        }
        result.push(ch);
        current_width += ch_width;
    }

    result.push('…');
    result
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
