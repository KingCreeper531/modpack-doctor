//! IPC surface. FROZEN signatures (M1) — see docs/CONTRACTS.md.
//!
//! Commands are thin: resolve ids through `AppState`, call the owning module, map
//! `Error` → `AppError`. Bodies marked `not_yet` are filled in by later milestones;
//! signatures do not change without an approved contract proposal.

use tauri::{AppHandle, State};

use crate::error::{AppError, Error};
use crate::model::*;
use crate::state::AppState;

type Cmd<T> = Result<T, AppError>;

fn not_yet<T>(what: &str, milestone: &str) -> Cmd<T> {
    Err(Error::Internal(format!("{what} is not implemented yet ({milestone})")).into())
}

// ── Instances ────────────────────────────────────────────────────────────────

/// Probe every launcher location + manual folders; registers roots with the PathGuard.
#[tauri::command]
#[specta::specta]
pub async fn discover_instances(_app: AppHandle, _state: State<'_, AppState>) -> Cmd<DiscoveryReport> {
    not_yet("discover_instances", "M3")
}

/// Opens a native folder picker (Rust side); adds the folder as a Manual instance.
/// Ok(None) when the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn pick_and_add_folder(_app: AppHandle, _state: State<'_, AppState>) -> Cmd<Option<Instance>> {
    not_yet("pick_and_add_folder", "M3")
}

#[tauri::command]
#[specta::specta]
pub async fn remove_manual_instance(_state: State<'_, AppState>, _instance_id: String) -> Cmd<()> {
    not_yet("remove_manual_instance", "M3")
}

/// Native folder picker for an extra launcher data root (portable Prism/MultiMC, custom
/// CurseForge folder). Persists it, registers it, and returns the refreshed report.
#[tauri::command]
#[specta::specta]
pub async fn pick_launcher_root(
    _app: AppHandle,
    _state: State<'_, AppState>,
    _launcher: Launcher,
) -> Cmd<Option<DiscoveryReport>> {
    not_yet("pick_launcher_root", "M3")
}

/// Removes a launcher root (narrows scope only; `path` must equal a stored entry exactly).
#[tauri::command]
#[specta::specta]
pub async fn remove_launcher_root(_state: State<'_, AppState>, _path: String) -> Cmd<()> {
    not_yet("remove_launcher_root", "M3")
}

/// Opens a native file picker filtered to `.mrpack`; registers it as an Mrpack instance.
#[tauri::command]
#[specta::specta]
pub async fn pick_mrpack(_app: AppHandle, _state: State<'_, AppState>) -> Cmd<Option<Instance>> {
    not_yet("pick_mrpack", "M7")
}

// ── Scanning ─────────────────────────────────────────────────────────────────

/// Scans `mods/` (or the .mrpack). Emits `ScanProgress` per top-level jar; never blocks the UI.
#[tauri::command]
#[specta::specta]
pub async fn scan_instance(_app: AppHandle, _state: State<'_, AppState>, _instance_id: String) -> Cmd<ScanResult> {
    not_yet("scan_instance", "M3")
}

// ── Logs & crashes ───────────────────────────────────────────────────────────

/// Crash reports, latest.log, debug.log, hs_err files; newest first.
#[tauri::command]
#[specta::specta]
pub async fn list_log_sources(_state: State<'_, AppState>, _instance_id: String) -> Cmd<Vec<LogSource>> {
    not_yet("list_log_sources", "M4")
}

/// Streams the file and returns a bounded digest. `anchors` come from `src/core/crash/anchors.ts`.
/// `options: None` uses the defaults documented on `DigestOptions`.
#[tauri::command]
#[specta::specta]
pub async fn read_log_digest(
    _state: State<'_, AppState>,
    _instance_id: String,
    _source_id: String,
    _anchors: Vec<String>,
    _options: Option<DigestOptions>,
) -> Cmd<LogDigest> {
    not_yet("read_log_digest", "M4")
}

/// Toggle live watch mode (persisted in `Settings.watched`). Emits `CrashDetected` per the
/// episode rules in `model/logs.rs`. `anchors` = the tiered list from
/// `src/core/crash/anchors.ts` (`CRASH_ANCHORS`), matched against new `latest.log` lines. Rust
/// never starts watchers on its own: at startup the UI re-arms every id in `Settings.watched`
/// by calling this with `enabled = true` and the current anchors (ignored when disabling).
#[tauri::command]
#[specta::specta]
pub async fn set_watch(
    _app: AppHandle,
    _state: State<'_, AppState>,
    _instance_id: String,
    _enabled: bool,
    _anchors: Vec<WatchAnchor>,
) -> Cmd<()> {
    not_yet("set_watch", "M4")
}

// ── Modrinth ─────────────────────────────────────────────────────────────────

/// `POST /v2/version_files` (sha1), batched + cached. `refresh` bypasses the disk cache.
#[tauri::command]
#[specta::specta]
pub async fn modrinth_identify(_state: State<'_, AppState>, _sha1s: Vec<String>, _refresh: bool) -> Cmd<HashLookup> {
    not_yet("modrinth_identify", "M5")
}

/// `POST /v2/version_files/update` with loaders + game versions + version types.
/// Callers always pass loaders and game versions (an unfiltered call returns betas of
/// other MC versions); `version_types` defaults in the UI to `["release"]`.
#[tauri::command]
#[specta::specta]
pub async fn modrinth_find_updates(
    _state: State<'_, AppState>,
    _sha1s: Vec<String>,
    _loaders: Vec<String>,
    _game_versions: Vec<String>,
    _version_types: Vec<String>,
    _refresh: bool,
) -> Cmd<HashLookup> {
    not_yet("modrinth_find_updates", "M5")
}

/// `GET /v2/projects?ids=[…]` (ids or slugs, ≤100 per request); caches icons into
/// `paths::icon_cache_dir`. Used by src/core to resolve a missing dependency's mod id
/// (validated slug guess) to a project.
#[tauri::command]
#[specta::specta]
pub async fn modrinth_projects(_state: State<'_, AppState>, _ids: Vec<String>, _refresh: bool) -> Cmd<ProjectLookup> {
    not_yet("modrinth_projects", "M5")
}

/// `GET /v2/project/{id}/version?loaders=…&game_versions=…` newest first, filtered by
/// `version_types`. Lets src/core choose the version for `InstallDependency`.
#[tauri::command]
#[specta::specta]
pub async fn modrinth_project_versions(
    _state: State<'_, AppState>,
    _project_id: String,
    _loaders: Vec<String>,
    _game_versions: Vec<String>,
    _version_types: Vec<String>,
) -> Cmd<Vec<MrVersion>> {
    not_yet("modrinth_project_versions", "M5")
}

// ── Fixes ────────────────────────────────────────────────────────────────────

/// Turn intents into a concrete, stored work order. No filesystem mutation.
///
/// Every `versionId` is re-fetched (`GET /v2/version/{id}`) and re-validated; any failure
/// rejects the whole order with a readable `Invalid` error naming the action:
/// - `pack` must agree with launcher/mrpack metadata and any stored override.
/// - `version.loaders` must contain the pack loader (NeoForge 1.20.1 also accepts `forge`),
///   and `version.gameVersions` must contain the pack MC version.
/// - `Replace`: the current jar's sha1 must identify (via `/version_files`) to the same
///   `projectId` as the new version; jars not on Modrinth cannot be replaced.
/// - Download candidate: file chosen by CONTRACTS.md invariant 8 (file type, primary, sole).
/// - After download and SHA-512 check (at execution): the new jar is scanned and must declare
///   the expected mod id (the replaced jar's id, or `InstallDependency.modId` incl. `provides`),
///   else the op fails and the order rolls back.
#[tauri::command]
#[specta::specta]
pub async fn plan_work_order(
    _state: State<'_, AppState>,
    _instance_id: String,
    _pack: PackIdentity,
    _actions: Vec<FixAction>,
) -> Cmd<WorkOrder> {
    not_yet("plan_work_order", "M6")
}

/// Execute a stored order: guard check → snapshot → ops (emits `OpStatus`) → rollback on failure.
#[tauri::command]
#[specta::specta]
pub async fn execute_work_order(_app: AppHandle, _state: State<'_, AppState>, _order_id: String) -> Cmd<WorkOrderResult> {
    not_yet("execute_work_order", "M6")
}

#[tauri::command]
#[specta::specta]
pub async fn discard_work_order(_state: State<'_, AppState>, _order_id: String) -> Cmd<()> {
    not_yet("discard_work_order", "M6")
}

#[tauri::command]
#[specta::specta]
pub async fn list_backups(_state: State<'_, AppState>, _instance_id: String) -> Cmd<Vec<BackupEntry>> {
    not_yet("list_backups", "M6")
}

/// Plans the reverse of a backup as a work order (shown and confirmed like any other).
/// `action_indexes`: undo only those actions of the original order; None = all not yet undone.
/// `backup_id` must match `^[0-9a-f]{16}/[0-9]+$` and exist.
#[tauri::command]
#[specta::specta]
pub async fn plan_undo(
    _state: State<'_, AppState>,
    _backup_id: String,
    _action_indexes: Option<Vec<u32>>,
) -> Cmd<WorkOrder> {
    not_yet("plan_undo", "M6")
}

#[tauri::command]
#[specta::specta]
pub async fn game_running(_state: State<'_, AppState>, _instance_id: String) -> Cmd<GameStatus> {
    not_yet("game_running", "M6")
}

// ── Settings, window, reports, updates ───────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn get_settings(_state: State<'_, AppState>) -> Cmd<Settings> {
    not_yet("get_settings", "M3")
}

/// Applies a partial update, persists, returns the full settings. Cannot change scope
/// (manual folders / launcher roots) or watch mode — see `SettingsPatch`.
#[tauri::command]
#[specta::specta]
pub async fn set_settings(_app: AppHandle, _state: State<'_, AppState>, _patch: SettingsPatch) -> Cmd<Settings> {
    not_yet("set_settings", "M3")
}

/// Rust opens the save dialog; returns the saved path, or None if cancelled.
#[tauri::command]
#[specta::specta]
pub async fn save_report(
    _app: AppHandle,
    _default_name: String,
    _format: ReportFormat,
    _contents: String,
) -> Cmd<Option<String>> {
    not_yet("save_report", "M7")
}

/// Re-themes the native title bar (Windows DWM); no-op elsewhere. Called on every resolved theme change.
#[tauri::command]
#[specta::specta]
pub fn set_window_theme(window: tauri::WebviewWindow, theme: ResolvedTheme) -> Cmd<()> {
    crate::window_theme::apply(&window, theme).map_err(AppError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn check_update(_app: AppHandle) -> Cmd<Option<UpdateInfo>> {
    not_yet("check_update", "M8")
}

/// Downloads, verifies the updater signature, installs, restarts.
#[tauri::command]
#[specta::specta]
pub async fn install_update(_app: AppHandle) -> Cmd<()> {
    not_yet("install_update", "M8")
}
