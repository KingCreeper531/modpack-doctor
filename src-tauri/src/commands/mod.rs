//! IPC surface. FROZEN signatures (M1) — see docs/CONTRACTS.md.
//!
//! Commands are thin: resolve ids through `AppState`, call the owning module, map
//! `Error` → `AppError`. Every command is implemented (M8 filled in the last two);
//! signatures do not change without an approved contract proposal.

mod fix;
mod instances;
mod logs;
mod modrinth;
mod mrpack;
mod report;
mod scanning;
mod update;

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
pub use fix::*;
pub use modrinth::*;
pub use mrpack::*;
pub use report::*;
pub use update::*;

type Cmd<T> = Result<T, AppError>;

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
    Ok(blocking(move || {
        // An opened `.mrpack` is closed (session only; CONTRACTS invariant 15).
        if st.instance(&instance_id).is_ok_and(|i| i.instance.launcher == Launcher::Mrpack) {
            return mrpack::remove_pack_and_forget(&st, &instance_id);
        }
        remove_manual_and_forget(&st, &instance_id)
    })
    .await?)
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

// `pick_mrpack` lives in `mrpack.rs` (glob re-export above), with the drop handler.

// ── Scanning ─────────────────────────────────────────────────────────────────

/// Scans `mods/` (or the .mrpack). Emits `ScanProgress` per top-level jar; never blocks the UI.
#[tauri::command]
#[specta::specta]
pub async fn scan_instance(app: AppHandle, state: State<'_, AppState>, instance_id: String) -> Cmd<ScanResult> {
    let st = AppState::clone(&state);
    let inst = st.instance(&instance_id)?;
    let sink = EventSink::new(app);
    let _scope = st.scope_lock.clone().read_owned().await;
    if inst.instance.launcher == Launcher::Mrpack {
        return Ok(blocking(move || mrpack::scan_registered_pack(&st.guard, &st.scans, &inst, &sink)).await?);
    }
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
//
// `plan_work_order`, `execute_work_order`, `discard_work_order`, `list_backups` and `plan_undo`
// live in `fix.rs` (glob re-export below).

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
    let packs = st.opened_pack_ids();
    let (settings, ()) = blocking(move || st.settings.update(|s| crate::settings::apply_patch(s, patch, &known, &packs))).await?;
    Ok(settings)
}

// `save_report` lives in `report.rs` (glob re-export above).

/// The user's home folder (absolute), so `src/core/report` can replace it by `~` in exported
/// reports (CONTRACTS invariant 16). Empty when the OS reports none. Read-only; never a scope.
#[tauri::command]
#[specta::specta]
pub fn home_dir() -> Cmd<String> {
    Ok(dirs::home_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default())
}

/// Re-themes the native title bar (Windows DWM); no-op elsewhere. Called on every resolved theme change.
#[tauri::command]
#[specta::specta]
pub fn set_window_theme(window: tauri::WebviewWindow, theme: ResolvedTheme) -> Cmd<()> {
    crate::window_theme::apply(&window, theme).map_err(AppError::from)
}

// `check_update` and `install_update` live in `update.rs` (glob re-export above).
