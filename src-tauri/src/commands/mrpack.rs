//! The `.mrpack` commands and the drop handler (M7, CONTRACTS.md invariant 15): opening a pack
//! (native file picker or a file dropped on the window), scanning it, and closing it. Packs are
//! session-only; the logic lives in `crate::mrpack` and `AppState::{add,remove}_opened_pack`.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_specta::Event;

use crate::error::{Error, Result};
use crate::fix::{ClientRemote, Remote};
use crate::guard::PathGuard;
use crate::model::{DropRejected, Instance, InstanceAdded, PackEdit, PackFixPlan, SavedPack, ScanResult, ScanStarted};
use crate::mrpack::fixcopy::{self, PackFixStore};
use crate::state::{AppState, InFlight, RegisteredInstance};

use super::instances::blocking;
use super::{Cmd, ScanSink};

/// Most files handled from one drop; the rest are rejected.
pub const MAX_DROPPED_FILES: usize = 32;
/// Most `DropRejected` events emitted one by one per drop; the rest are summed up in one more.
pub const MAX_DROP_REJECTIONS: usize = 3;

/// Opens a native file picker filtered to `.mrpack`; registers it as an Mrpack instance.
#[tauri::command]
#[specta::specta]
pub async fn pick_mrpack(app: AppHandle, state: State<'_, AppState>) -> Cmd<Option<Instance>> {
    let Some(picked) = pick_pack_file(&app).await? else {
        return Ok(None);
    };
    let st = AppState::clone(&state);
    let _scope = st.scope_lock.clone().write_owned().await;
    let instance = blocking(move || {
        open_pack(&st, &picked).map_err(|reason| {
            Error::Invalid(format!("\"{}\" was not opened: {}", file_name(&picked), reason.trim_end_matches('.')))
        })
    })
    .await?;
    Ok(Some(instance))
}

/// Native file picker filtered to `.mrpack`, async-safe (callback + oneshot). None = cancelled.
async fn pick_pack_file<R: Runtime>(app: &AppHandle<R>) -> Result<Option<PathBuf>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Open a Modrinth modpack").add_filter("Modrinth modpack", &["mrpack"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_file(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx.await.map_err(|_| Error::Internal("the file picker closed unexpectedly".into()))?;
    match picked {
        None => Ok(None),
        Some(p) => p
            .into_path()
            .map(Some)
            .map_err(|e| Error::Invalid(format!("the selected file is not a local file ({e})"))),
    }
}

/// File name only (never the full path), for messages and `DropRejected.name`.
fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

/// Check `path` (picked or dropped), describe it and register it. Err is a readable reason that
/// completes "… was not added: <reason>". Blocking; callers hold `scope_lock` for writing.
pub(crate) fn open_pack(st: &AppState, path: &Path) -> std::result::Result<Instance, String> {
    let canon = crate::mrpack::check_pack_file(path)?;
    let instance = crate::mrpack::describe_pack(&canon);
    st.add_opened_pack(instance.clone()).map_err(|e| e.to_string())?;
    Ok(instance)
}

/// Every dropped path in order: the opened instance, or the rejection to report. Blocking;
/// callers hold `scope_lock` for writing.
pub(crate) fn open_dropped(st: &AppState, paths: &[PathBuf]) -> Vec<std::result::Result<Instance, DropRejected>> {
    paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let reject = |reason: String| DropRejected { name: file_name(p), reason };
            if i >= MAX_DROPPED_FILES {
                return Err(reject(format!("at most {MAX_DROPPED_FILES} files can be dropped at once.")));
            }
            open_pack(st, p).map_err(reject)
        })
        .collect()
}

/// What one drop emits: every opened pack (`InstanceAdded`, in order), then at most
/// [`MAX_DROP_REJECTIONS`] rejections one by one and, when there were more, one summary
/// rejection for the rest. Rejections come last so the UI (which shows the latest and clears it
/// on `InstanceAdded`) keeps showing one.
pub(crate) fn drop_events(
    outcomes: Vec<std::result::Result<Instance, DropRejected>>,
) -> (Vec<InstanceAdded>, Vec<DropRejected>) {
    let mut added = Vec::new();
    let mut rejected = Vec::new();
    let mut more = 0usize;
    for outcome in outcomes {
        match outcome {
            Ok(instance) => added.push(InstanceAdded { instance }),
            Err(r) if rejected.len() < MAX_DROP_REJECTIONS => rejected.push(r),
            Err(_) => more += 1,
        }
    }
    if more > 0 {
        let files = if more == 1 { "1 more file was".to_string() } else { format!("{more} more files were") };
        rejected.push(DropRejected {
            name: "The rest of this drop".into(),
            reason: format!(
                "{files} refused as well (only .mrpack files are opened, at most {MAX_DROPPED_FILES} per drop)."
            ),
        });
    }
    (added, rejected)
}

/// `WindowEvent::DragDrop` → `InstanceAdded` per opened pack, then a few `DropRejected` (see
/// [`drop_events`]). Runs in the background so the window event loop never waits for the scope
/// lock or the disk.
pub fn handle_drop<R: Runtime>(app: AppHandle<R>, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else { return };
        let st = AppState::clone(&state);
        let _scope = st.scope_lock.clone().write_owned().await;
        let outcomes = match blocking(move || Ok(open_dropped(&st, &paths))).await {
            Ok(o) => o,
            Err(e) => {
                eprintln!("drop: {e}");
                return;
            }
        };
        let (added, rejected) = drop_events(outcomes);
        let emitted = added.into_iter().map(|a| a.emit(&app)).chain(rejected.into_iter().map(|r| r.emit(&app)));
        for result in emitted {
            if let Err(e) = result {
                eprintln!("drop: could not emit the result: {e}");
            }
        }
    });
}

/// `scan_instance` for an opened pack: in-flight tracking, then `crate::mrpack::scan_pack` with
/// `ScanStarted` / `ScanProgress` through `sink`. Blocking.
pub(crate) fn scan_registered_pack(
    guard: &PathGuard,
    scans: &InFlight,
    inst: &RegisteredInstance,
    sink: &dyn ScanSink,
) -> Result<ScanResult> {
    let _ticket = scans.begin(&inst.instance.id, &inst.instance.name)?;
    let id = inst.instance.id.as_str();
    crate::mrpack::scan_pack(
        guard,
        &inst.game_dir,
        id,
        |stubs| sink.started(ScanStarted { instance_id: id.to_string(), jars: stubs.to_vec() }),
        |p| sink.progress(p),
    )
}

/// `remove_manual_instance` for an opened pack: close it, then drop its override (and watch
/// entry, if any). Blocking; callers hold `scope_lock` for writing.
pub(crate) fn remove_pack_and_forget(st: &AppState, instance_id: &str) -> Result<()> {
    st.remove_opened_pack(instance_id)?;
    super::forget_instance(st, instance_id)
}

// ── "Save fixed copy…" (crate::mrpack::fixcopy) ──────────────────────────────

/// The online client when Modrinth is enabled in settings, else None (replacements and
/// additions then fail with `Offline`; nothing touches the network).
fn pack_remote(st: &AppState, handle: &tokio::runtime::Handle) -> Result<Option<ClientRemote>> {
    if !st.settings.get().modrinth_enabled {
        return Ok(None);
    }
    let svc = st.modrinth.as_ref().ok_or_else(|| {
        Error::Internal("the Modrinth client could not be set up at startup because the app cache folder is unavailable".into())
    })?;
    Ok(Some(ClientRemote::new(svc.client(true).clone(), handle.clone())))
}

/// Blocking: plan and store a fixed copy. Must not run on an async worker thread. With Modrinth
/// on, the pack's declared files are identified for every plan (warnings name the ones that are
/// not on Modrinth); a missing client fails only plans that replace or add files.
pub(crate) fn plan_pack_fix_with(
    st: &AppState,
    store: &PackFixStore,
    handle: &tokio::runtime::Handle,
    instance_id: &str,
    edits: &[PackEdit],
) -> Result<PackFixPlan> {
    let needs_remote = edits.iter().any(|e| matches!(e, PackEdit::ReplaceDeclared { .. } | PackEdit::AddDependency { .. }));
    let r = match pack_remote(st, handle) {
        Ok(r) => r,
        Err(e) if needs_remote => return Err(e),
        Err(_) => None,
    };
    fixcopy::plan(st, store, r.as_ref().map(|r| r as &dyn Remote), instance_id, edits)
}

/// Plan a fixed copy of an opened `.mrpack` from edit intents. Nothing is written. Every edit is
/// checked against the pack (index paths, override jars) and every Modrinth version is fetched
/// fresh and checked (same project and a newer version for a replacement; for an addition, a
/// project some kept file requires and the copy does not have yet; the pack's loader and
/// Minecraft version, a CDN download with sha1, sha512 and size, no path collision). The plan is
/// stored in Rust for 15 minutes, single use; any failure refuses the whole plan with a readable
/// error naming the edit.
#[tauri::command]
#[specta::specta]
pub async fn plan_pack_fix(
    state: State<'_, AppState>,
    plans: State<'_, PackFixStore>,
    instance_id: String,
    edits: Vec<PackEdit>,
) -> Cmd<PackFixPlan> {
    let st = AppState::clone(&state);
    let store = PackFixStore::clone(&plans);
    let handle = tokio::runtime::Handle::current();
    let _scope = st.scope_lock.clone().read_owned().await;
    Ok(blocking(move || plan_pack_fix_with(&st, &store, &handle, &instance_id, &edits)).await?)
}

/// Native save dialog for the copy, async-safe (callback + oneshot). None = cancelled.
async fn pick_copy_path<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<Option<PathBuf>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog =
        app.dialog().file().set_title("Save fixed copy").set_file_name(name).add_filter("Modrinth modpack", &["mrpack"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx.await.map_err(|_| Error::Internal("the save dialog closed unexpectedly".into()))?;
    match picked {
        None => Ok(None),
        Some(p) => p
            .into_path()
            .map(Some)
            .map_err(|e| Error::Invalid(format!("the chosen location is not a local file ({e})"))),
    }
}

/// Rust opens the native save dialog (default name `<pack> (fixed).mrpack`) and writes the
/// planned copy there as a new file: temp file in the chosen folder, then a no-replace rename
/// (replacing only the exact path the dialog confirmed). The opened pack is never written; its
/// own path is refused. Returns None when the dialog was cancelled (the plan stays usable).
#[tauri::command]
#[specta::specta]
pub async fn save_fixed_pack(
    app: AppHandle,
    state: State<'_, AppState>,
    plans: State<'_, PackFixStore>,
    plan_id: String,
) -> Cmd<Option<SavedPack>> {
    let plan = plans.peek(&plan_id)?;
    let name = fixcopy::default_copy_name(&plan.pack_file_name);
    let Some(picked) = pick_copy_path(&app, &name).await? else {
        return Ok(None);
    };
    // The dialog confirmed replacing `picked` itself; a name we had to extend was not confirmed.
    let (dest, may_replace) = fixcopy::destination(picked)?;
    let st = AppState::clone(&state);
    let store = PackFixStore::clone(&plans);
    let _scope = st.scope_lock.clone().read_owned().await;
    let saved = blocking(move || fixcopy::save(&st, &store, &plan_id, &dest, may_replace)).await?;
    Ok(Some(saved))
}

#[cfg(test)]
mod tests;
