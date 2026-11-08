//! Settings (owned by Rust, persisted with tauri-plugin-store). FROZEN (M1).
//!
//! Scope-bearing fields (`manual_folders`, `launcher_roots`) are read-only over IPC: only the
//! native-picker commands add them, so the webview can never widen filesystem scope.
//! `set_settings` takes a `SettingsPatch` that cannot express them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::instance::{Launcher, LoaderInfo, Side};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ThemePref {
    #[default]
    System,
    Dark,
    Light,
}

/// The theme actually in effect (system resolved by the webview).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ResolvedTheme {
    Dark,
    Light,
}

/// Scan-grid tile order after a scan completes. During a scan tiles are always in
/// `ScanStarted` (file-name) order so they don't jump while filling in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum GridSort {
    #[default]
    Name,
    /// error → warning → info → ok → disabled, then by name.
    Severity,
}

/// User override of the pack identity (check 1) and side (check 8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PackOverride {
    pub mc_version: Option<String>,
    pub loader: Option<LoaderInfo>,
    pub side: Option<Side>,
}

/// An extra launcher data root (portable Prism/MultiMC, custom CurseForge folder), added via
/// `pick_launcher_root`. Instances inside it are discovered like auto-detected ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LauncherRoot {
    pub launcher: Launcher,
    pub path: String,
}

/// Full settings as returned by `get_settings` / `set_settings`. Every field is always present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: ThemePref,
    /// Read-only over IPC. Absolute folders added via `pick_and_add_folder`.
    pub manual_folders: Vec<String>,
    /// Read-only over IPC. Added via `pick_launcher_root`.
    pub launcher_roots: Vec<LauncherRoot>,
    /// Instance ids with live watch mode on.
    pub watched: Vec<String>,
    /// instanceId → override.
    pub overrides: BTreeMap<String, PackOverride>,
    /// False = never call the network (offline mode).
    pub modrinth_enabled: bool,
    /// Include beta versions in update suggestions. When false and no release is compatible,
    /// src/core retries with `["release", "beta"]` and labels any result "beta" (never alpha).
    pub include_beta: bool,
    pub grid_sort: GridSort,
    pub inspector_width: u32,
    /// Opt-in: check GitHub for a newer release once, a few seconds after the app starts
    /// (CONTRACTS invariant 18). It only reports; nothing is downloaded or installed by itself.
    /// Settings stored before this field existed load it as `false`.
    pub auto_check_updates: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: ThemePref::System,
            manual_folders: Vec::new(),
            launcher_roots: Vec::new(),
            watched: Vec::new(),
            overrides: BTreeMap::new(),
            modrinth_enabled: true,
            include_beta: false,
            grid_sort: GridSort::Name,
            inspector_width: 360,
            auto_check_updates: false,
        }
    }
}

/// Partial update for `set_settings`. `None` = leave unchanged. Watch mode is changed via
/// `set_watch` (it starts/stops watchers), not here.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub theme: Option<ThemePref>,
    /// Replaces the override for that instance; `{ instanceId: null }` removes it.
    pub overrides: Option<BTreeMap<String, Option<PackOverride>>>,
    pub modrinth_enabled: Option<bool>,
    pub include_beta: Option<bool>,
    pub grid_sort: Option<GridSort>,
    pub inspector_width: Option<u32>,
    pub auto_check_updates: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// `app_info`: shown in About. Empty strings when a folder can't be resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub tauri_version: String,
    pub data_dir: String,
    pub cache_dir: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ReportFormat {
    Markdown,
    Json,
}
