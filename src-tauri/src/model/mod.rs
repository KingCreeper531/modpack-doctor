//! Shared Rust ↔ TypeScript contract types. FROZEN (M1) — see docs/CONTRACTS.md.
//! TypeScript mirrors are generated into `src/bindings.ts`; never edit that file by hand.

pub mod fix;
pub mod instance;
pub mod logs;
pub mod modrinth;
pub mod scan;
pub mod settings;

pub use fix::*;
pub use instance::*;
pub use logs::*;
pub use modrinth::*;
pub use scan::*;
pub use settings::*;
