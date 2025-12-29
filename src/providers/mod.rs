pub mod lastfm;
pub mod youtube;

use chrono::{DateTime, Duration, Utc};

pub fn within_days(timestamp: DateTime<Utc>, days: u64) -> bool {
    let cutoff = Utc::now() - Duration::days(days as i64);
    timestamp >= cutoff
}

pub fn calculate_timestamp(days: u64) -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("System time before UNIX epoch")
        .as_secs();
    now.saturating_sub(days * 86400)
}
