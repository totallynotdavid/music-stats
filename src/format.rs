use crate::domain::Track;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const MAX_TITLE_WIDTH: usize = 35;
const MAX_ARTIST_WIDTH: usize = 25;
const ALIGN_POSITION: usize = 40;

pub fn format_tracks(tracks: &[Track]) -> String {
    if tracks.is_empty() {
        return "No tracks played recently".to_string();
    }

    tracks
        .iter()
        .map(format_track)
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_track(track: &Track) -> String {
    let title = truncate_with_ellipsis(track.title(), MAX_TITLE_WIDTH);
    let artist = truncate_with_ellipsis(track.artist(), MAX_ARTIST_WIDTH);
    let padding = calculate_padding(&title);
    let count = format_play_count(track.play_count);

    format!("{}{}{}{}", title, padding, artist, count)
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
    let mut width = 0;

    for ch in text.chars() {
        let char_width = ch.width().unwrap_or(0);
        if width + char_width + 1 > max_width {
            break;
        }
        result.push(ch);
        width += char_width;
    }

    result.push('…');
    result
}
