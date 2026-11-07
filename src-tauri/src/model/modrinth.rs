//! Modrinth API projections. FROZEN (M1). Only the fields the app uses.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MrFile {
    /// Always a `https://cdn.modrinth.com/` URL (others are dropped by the client).
    pub url: String,
    pub filename: String,
    /// None when the API omitted it (unknown — never treated as 0).
    #[specta(type = Option<specta_typescript::Number>)]
    pub size: Option<u64>,
    pub primary: bool,
    pub sha1: String,
    pub sha512: String,
    /// `required-resource-pack` | `optional-resource-pack` | `sources-jar` | `dev-jar` |
    /// `javadoc-jar` | `signature` | None (normal file). Files with `sources-jar`, `dev-jar`,
    /// `javadoc-jar` or `signature` are never download candidates.
    pub file_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MrDependency {
    pub version_id: Option<String>,
    pub project_id: Option<String>,
    pub file_name: Option<String>,
    /// `required` | `optional` | `incompatible` | `embedded`
    pub dependency_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MrVersion {
    pub id: String,
    pub project_id: String,
    pub version_number: String,
    pub name: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    /// `release` | `beta` | `alpha`
    pub version_type: String,
    /// ISO 8601 publish time (`date_published`). An update must be published after the identified
    /// version (CONTRACTS invariant 8): Modrinth returns the newest *matching* version, which can
    /// be older than a beta the user runs. None only when the API omitted it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub date_published: Option<String>,
    /// Raw v3 environment of this version (`client_only`, `client_and_server`,
    /// `server_only_client_optional`, …). Preferred over the project's legacy side fields.
    pub environment: Option<String>,
    /// Usable files only (CDN URL + sha1 + sha512). Others are dropped by the client.
    pub files: Vec<MrFile>,
    /// Number of files the API listed but the client dropped (non-CDN host, missing hashes).
    pub dropped_files: u32,
    /// True when the API's `primary: true` file was among the dropped ones. The planner must
    /// then fail rather than fall back to "the sole remaining file" (CONTRACTS invariant 8).
    pub primary_dropped: bool,
    pub dependencies: Vec<MrDependency>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum SideSupport {
    Required,
    Optional,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MrProject {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub project_type: String,
    /// Raw v3 environments used across the project's versions. Read this first.
    pub environment: Vec<String>,
    /// Deprecated legacy fields (derived by Modrinth from `environment`); fallback only.
    pub client_side: SideSupport,
    pub server_side: SideSupport,
    /// Absolute path of the cached icon under the icon cache dir (pass to `convertFileSrc`).
    /// None until fetched or when the project has no icon.
    pub icon_path: Option<String>,
}

/// Result of a batched lookup. Partial failures are reported, never thrown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HashLookup {
    /// sha1 → version. Hashes absent here and absent from `failed` are not on Modrinth.
    pub found: BTreeMap<String, MrVersion>,
    /// Hashes whose batch failed (network/5xx) — unknown, not "not on Modrinth".
    pub failed: Vec<String>,
    /// True when the whole lookup was served offline/from cache only.
    pub offline: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLookup {
    /// Keyed by the id or slug that was requested.
    pub found: BTreeMap<String, MrProject>,
    pub failed: Vec<String>,
    pub offline: bool,
}
