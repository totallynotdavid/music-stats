mod api_types;
mod client;
mod pagination;

pub use client::fetch_scrobbles;

const PAGE_LIMIT: usize = 200;
const MAX_PAGES: usize = 10;
const RATE_LIMIT_MS: u64 = 200;
