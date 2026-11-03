//! Instances and launcher discovery. FROZEN (M1).

use serde::{Deserialize, Serialize};
use specta::Type;

/// Which launcher (or source) an instance came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Launcher {
    Modrinth,
    Prism,
    Multimc,
    Curseforge,
    Vanilla,
    /// A folder the user added by hand.
    Manual,
    /// An opened `.mrpack` file (read-only, never mutated).
    Mrpack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum LoaderKind {
    Forge,
    Neoforge,
    Fabric,
    Quilt,
    /// Pre-1.13 Forge (`mcmod.info`).
    Legacyforge,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoaderInfo {
    pub kind: LoaderKind,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Client,
    Server,
}

/// Where the instance's MC version / loader came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum MetadataSource {
    Launcher,
    Mrpack,
    /// Not available from launcher metadata; `src/core/pack` infers from jars.
    Inferred,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    /// Stable id: first 16 hex chars of SHA-1 over the canonical **game dir** path, lowercased
    /// on Windows and macOS (case-insensitive filesystems). Discovery de-duplicates by it, so a
    /// manual folder pointing at a launcher instance merges into the launcher's entry.
    pub id: String,
    pub name: String,
    pub launcher: Launcher,
    /// Absolute instance root as displayed to the user (launcher instance folder; for
    /// `Mrpack` the `.mrpack` file path).
    pub root: String,
    /// Absolute game directory (contains `mods/`, `logs/`, `crash-reports/`). For `Mrpack`
    /// this equals `root`; jar ids are then relative to the pack (`overrides/mods/x.jar`).
    pub game_dir: String,
    pub mc_version: Option<String>,
    pub loader: Option<LoaderInfo>,
    pub side: Side,
    pub metadata_source: MetadataSource,
    /// Number of `*.jar` + `*.jar.disabled` files in `mods/` at discovery time.
    pub mod_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ProbeResult {
    NotInstalled,
    Found { count: u32 },
    PermissionDenied,
    Error { message: String },
}

/// One location the discovery module looked at; drives the useful empty state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LauncherProbe {
    pub launcher: Launcher,
    pub path: String,
    pub result: ProbeResult,
    /// Degradations worth showing, e.g. "app.db schema not recognised — using jar metadata",
    /// "database busy — retried 3×".
    pub notes: Vec<String>,
}

/// Events: the window received a drop (handled entirely in Rust; paths never reach the UI).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct InstanceAdded {
    pub instance: Instance,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct DropRejected {
    /// File name only (not the full path) and a readable reason.
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryReport {
    pub instances: Vec<Instance>,
    pub probes: Vec<LauncherProbe>,
}
