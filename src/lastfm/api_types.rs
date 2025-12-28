use crate::domain::Scrobble;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct ApiResponse {
    pub recenttracks: RecentTracks,
}

#[derive(Debug, Deserialize)]
pub struct RecentTracks {
    pub track: Vec<ApiTrack>,
    #[serde(rename = "@attr")]
    pub attr: Option<PageAttr>,
}

#[derive(Debug, Deserialize)]
pub struct PageAttr {
    #[serde(rename = "totalPages")]
    pub total_pages: String,
}

#[derive(Debug, Deserialize)]
pub struct ApiTrack {
    pub name: String,
    pub artist: ArtistInfo,
    pub date: Option<DateInfo>,
}

#[derive(Debug, Deserialize)]
pub struct ArtistInfo {
    #[serde(rename = "#text")]
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct DateInfo {}

pub fn to_scrobble(track: ApiTrack) -> Option<Scrobble> {
    track
        .date
        .map(|_| Scrobble::new(track.artist.text, track.name))
}
