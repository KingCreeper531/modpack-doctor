//! IPC surface. FROZEN signatures (M1) — see docs/CONTRACTS.md.
//!
//! Commands are thin: resolve ids through `AppState`, call the owning module, map
//! `Error` → `AppError`. Bodies marked `not_yet` are filled in by later milestones;
//! signatures do not change without an approved contract proposal.

mod instances;
mod logs;
mod modrinth;
mod scanning;

#[cfg(test)]
mod tests;

use tauri::{AppHandle, State};

use crate::error::{AppError, Error};
use crate::model::*;
use crate::state::AppState;

pub use instances::{
    add_launcher_root, add_manual_folder, canonical_dir, manual_folder_id, manual_game_dir, remove_manual_folders_for,
    remove_stored_path,
};
pub use scanning::{scan_registered, EventSink, ScanSink};

use instances::{blocking, discover_blocking, pick_folder};
pub use logs::{disable_watch, enable_watch, forget_instance, remove_manual_and_forget};
pub use modrinth::*;

type Cmd<T> = Result<T, AppError>;

/// A command whose feature arrives in a later milestone (noted at each call site).
fn not_yet<T>(feature: &str) -> Cmd<T> {
    Err(Error::Unavailable(feature.to_string()).into())
}

// ── Instances ────────────────────────────────────────────────────────────────

/// Probe every launcher location + manual folders; registers roots with the PathGuard.
#[tauri::command]
#[specta::specta]
pub async fn discover_instances(_app: AppHandle, state: State<'_, AppState>) -> Cmd<DiscoveryReport> {
    let st = AppState::clone(&state);
    let _scope = st.scope_lock.clone().write_owned().await;
    Ok(blocking(move || discover_blocking(&st)).await?)
}

/// Opens a native folder picker (Rust side); adds the folder as a Manual instance.
/// Ok(None) when the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn pick_and_add_folder(app: AppHandle, state: State<'_, AppState>) -> Cmd<Option<Instance>> {
    let Some(picked) = pick_folder(&app, "Add an instance folder").await? else {
        return Ok(None);
    };
    let st = AppState::clone(&state);
    let _scope = st.scope_lock.clone().write_owned().await;
    let instance = blocking(move || {
        let folder = canonical_dir(&picked)?;
        let shown = folder.display().to_string();
        st.settings.update(|s| Ok(add_manual_folder(s, &shown)))?;
        let report = discover_blocking(&st)?;
        // The instance for this folder: the launcher's entry if it merged into one.
        let id = manual_folder_id(&folder);
        report.instances.into_iter().find(|i| i.id == id).ok_or(Error::NotFound { path: shown })
    })
    .await?;
    Ok(Some(instance))
}

#[tauri::command]
#[specta::specta]
pub async fn remove_manual_instance(state: State<'_, AppState>, instance_id: String) -> Cmd<()> {
    let st = AppState::clone(&state);
    let _scope = st.scope_lock.clone().write_owned().await;
    // Also stops its watcher and drops its `watched` entry and pack override.
    Ok(blocking(move || remove_manual_and_forget(&st, &instance_id)).await?)
}

/// Native folder picker for an extra launcher data root (portable Prism/MultiMC, custom
/// CurseForge folder). Persists it, registers it, and returns the refreshed report.
#[tauri::command]
#[specta::specta]
pub async fn pick_launcher_root(
    app: AppHandle,
    state: State<'_, AppState>,
    launcher: Launcher,
) -> Cmd<Option<DiscoveryReport>> {
    if !crate::settings::is_launcher_root_kind(launcher) {
        let msg = "only Modrinth App, Prism, MultiMC, CurseForge or Minecraft Launcher folders can be added as launcher folders";
        return Err(Error::Invalid(msg.into()).into());
    }
    let Some(picked) = pick_folder(&app, "Choose a launcher folder").await? else {
        return Ok(None);
    };
    let st = AppState::clone(&state);
    let _scope = st.scope_lock.clone().write_owned().await;
    let report = blocking(move || {
        let folder = canonical_dir(&picked)?;
        let shown = folder.display().to_string();
        st.settings.update(|s| Ok(add_launcher_root(s, launcher, &shown)))?;
        discover_blocking(&st)
    })
    .await?;
    Ok(Some(report))
}

/// Removes a launcher root (narrows scope only; `path` must equal a stored entry exactly).
#[tauri::command]
#[specta::specta]
pub async fn remove_launcher_root(state: State<'_, AppState>, path: String) -> Cmd<()> {
    let st = AppState::clone(&state);
    let _scope = st.scope_lock.clone().write_owned().await;
    Ok(blocking(move || {
        let (_, removed) = st.settings.update(|s| Ok(remove_stored_path(s, &path)))?;
        if !removed {
            return Err(Error::Invalid(format!("no stored launcher folder is exactly \"{path}\"")));
        }
        // Rediscover so instances from that folder (and the roots only they needed) disappear.
        discover_blocking(&st).map(|_| ())
    })
    .await?)
}

/// Opens a native file picker filtered to `.mrpack`; registers it as an Mrpack instance.
#[tauri::command]
#[specta::specta]
pub async fn pick_mrpack(_app: AppHandle, _state: State<'_, AppState>) -> Cmd<Option<Instance>> {
    not_yet("Opening .mrpack files" /* M7 */)
}

// ── Scanning ─────────────────────────────────────────────────────────────────

/// Scans `mods/` (or the .mrpack). Emits `ScanProgress` per top-level jar; never blocks the UI.
#[tauri::command]
#[specta::specta]
pub async fn scan_instance(app: AppHandle, state: State<'_, AppState>, instance_id: String) -> Cmd<ScanResult> {
    let st = AppState::clone(&state);
    let inst = st.instance(&instance_id)?;
    if inst.instance.launcher == Launcher::Mrpack {
        return not_yet("Scanning .mrpack files" /* M7 */);
    }
    let sink = EventSink::new(app);
    let _scope = st.scope_lock.clone().read_owned().await;
    Ok(blocking(move || scan_registered(&st.guard, &st.scan_cache, &st.scans, &inst, &sink)).await?)
}

// ── Logs & crashes ───────────────────────────────────────────────────────────

/// Crash reports, latest.log, debug.log, hs_err files; newest first.
#[tauri::command]
#[specta::specta]
pub async fn list_log_sources(state: State<'_, AppState>, instance_id: String) -> Cmd<Vec<LogSource>> {
    let st = AppState::clone(&state);
    let _scope = st.scope_lock.clone().read_owned().await;
    Ok(blocking(move || logs::list_sources_blocking(&st, &instance_id)).await?)
}

/// Streams the file and returns a bounded digest. `anchors` come from `src/core/crash/anchors.ts`.
/// `options: None` uses the defaults documented on `DigestOptions`.
#[tauri::command]
#[specta::specta]
pub async fn read_log_digest(
    state: State<'_, AppState>,
    instance_id: String,
    source_id: String,
    anchors: Vec<String>,
    options: Option<DigestOptions>,
) -> Cmd<LogDigest> {
    let st = AppState::clone(&state);
    let _scope = st.scope_lock.clone().read_owned().await;
    Ok(blocking(move || logs::read_digest_blocking(&st, &instance_id, &source_id, &anchors, options)).await?)
}

/// Toggle live watch mode (persisted in `Settings.watched`). Emits `CrashDetected` per the
/// episode rules in `model/logs.rs`. `anchors` = the tiered list from
/// `src/core/crash/anchors.ts` (`CRASH_ANCHORS`), matched against new `latest.log` lines. Rust
/// never starts watchers on its own: at startup the UI re-arms every id in `Settings.watched`
/// by calling this with `enabled = true` and the current anchors (ignored when disabling).
#[tauri::command]
#[specta::specta]
pub async fn set_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    enabled: bool,
    anchors: Vec<WatchAnchor>,
) -> Cmd<()> {
    let st = AppState::clone(&state);
    if enabled {
        let sink: std::sync::Arc<dyn crate::logs::watch::CrashSink> =
            std::sync::Arc::new(crate::logs::watch::TauriCrashSink::new(app));
        Ok(blocking(move || enable_watch(&st, &instance_id, anchors, sink)).await?)
    } else {
        Ok(blocking(move || disable_watch(&st, &instance_id)).await?)
    }
}

// ── Modrinth ─────────────────────────────────────────────────────────────────
//
// `modrinth_identify`, `modrinth_find_updates`, `modrinth_projects`, `modrinth_project_versions`
// and `modrinth_resolve_mod_id` live in `modrinth.rs` (glob re-export below, so the command macros
// `collect_commands!` needs come along).

// ── Fixes ────────────────────────────────────────────────────────────────────

/// Turn intents into a concrete, stored work order. No filesystem mutation.
///
/// Every `versionId` is re-fetched (`GET /v2/version/{id}`) and re-validated; any failure
/// rejects the whole order with a readable `Invalid` error naming the action:
/// - `pack` must agree with launcher/mrpack metadata and any stored override.
/// - `version.loaders` must contain the pack loader (NeoForge 1.20.1 also accepts `forge`,
///   Quilt also accepts `fabric`); the version must be published after the current one (`Replace`),
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
    not_yet("Applying fixes" /* M6 */)
}

/// Execute a stored order: guard check → snapshot → ops (emits `OpStatus`) → rollback on failure.
#[tauri::command]
#[specta::specta]
pub async fn execute_work_order(_app: AppHandle, _state: State<'_, AppState>, _order_id: String) -> Cmd<WorkOrderResult> {
    not_yet("Applying fixes" /* M6 */)
}

#[tauri::command]
#[specta::specta]
pub async fn discard_work_order(_state: State<'_, AppState>, _order_id: String) -> Cmd<()> {
    not_yet("Applying fixes" /* M6 */)
}

#[tauri::command]
#[specta::specta]
pub async fn list_backups(_state: State<'_, AppState>, _instance_id: String) -> Cmd<Vec<BackupEntry>> {
    not_yet("Backup history" /* M6 */)
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
    not_yet("Undo" /* M6 */)
}

#[tauri::command]
#[specta::specta]
pub async fn game_running(state: State<'_, AppState>, instance_id: String) -> Cmd<GameStatus> {
    let st = AppState::clone(&state);
    Ok(blocking(move || logs::game_status_blocking(&st, &instance_id)).await?)
}

// ── Settings, window, reports, updates ───────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn get_settings(state: State<'_, AppState>) -> Cmd<Settings> {
    Ok(state.settings.get())
}

/// Applies a partial update, persists, returns the full settings. Cannot change scope
/// (manual folders / launcher roots) or watch mode — see `SettingsPatch`.
#[tauri::command]
#[specta::specta]
pub async fn set_settings(_app: AppHandle, state: State<'_, AppState>, patch: SettingsPatch) -> Cmd<Settings> {
    let st = AppState::clone(&state);
    let known = st.known_ids();
    let (settings, ()) = blocking(move || st.settings.update(|s| crate::settings::apply_patch(s, patch, &known))).await?;
    Ok(settings)
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
    not_yet("Saving reports" /* M7 */)
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
    not_yet("Update checks" /* M8 */)
}

/// Downloads, verifies the updater signature, installs, restarts.
#[tauri::command]
#[specta::specta]
pub async fn install_update(_app: AppHandle) -> Cmd<()> {
    not_yet("Installing updates" /* M8 */)
}
