mod http;
mod parse;

use crate::domain::Scrobble;
use crate::errors::Error;

pub async fn fetch_scrobbles(cookie: &str, days: u64) -> Result<Vec<Scrobble>, Error> {
    let history_html = http::fetch_history_html(cookie).await?;
    let scrobbles = parse::parse_history_html(&history_html, days)?;
    Ok(scrobbles)
}
