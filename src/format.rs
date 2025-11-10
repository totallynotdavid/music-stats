use crate::types::Track;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub fn format_tracks(tracks: &[Track]) -> String {
    const MAX_SONG_COLS: usize = 35;
    const MAX_ARTIST_COLS: usize = 25;
    const ALIGN_POS: usize = 40;

    tracks
        .iter()
        .map(|t| {
            let song = truncate_display_with_ellipsis(&t.name, MAX_SONG_COLS);
            let artist = truncate_display_with_ellipsis(&t.artist, MAX_ARTIST_COLS);

            let song_w = UnicodeWidthStr::width(song.as_str());
            let pad = ALIGN_POS.saturating_sub(song_w);
            let padding = " ".repeat(pad);

            format!("{}{}{}", song, padding, artist)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate_display_with_ellipsis(s: &str, max_width: usize) -> String {
    if UnicodeWidthStr::width(s) <= max_width {
        return s.to_string();
    }

    // reserve 1 column for the ellipsis
    let mut out = String::new();
    let mut acc = 0usize;
    for ch in s.chars() {
        let w = ch.width().unwrap_or(0);
        if acc + w + 1 > max_width {
            break;
        }
        out.push(ch);
        acc += w;
    }
    out.push('…');
    out
}
