//! Logs and crash detection: the streaming digest (M2 agent D: `digest.rs`), log source
//! listing (`sources.rs`), and live watch mode (M4 agent K: `tail.rs`, `episode.rs`, `watch.rs`).

pub mod digest;
pub mod episode;
pub mod sources;
pub mod tail;
pub mod watch;
