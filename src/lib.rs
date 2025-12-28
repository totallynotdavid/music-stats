pub mod domain {
    pub use crate::domain_internal::{aggregate_scrobbles, Scrobble, Track};
}

pub mod format {
    pub use crate::format_internal::format_tracks;
}

mod domain_internal {
    include!("domain/mod.rs");
}

mod format_internal {
    include!("format.rs");
}
