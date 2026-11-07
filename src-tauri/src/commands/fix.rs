//! The fix commands (M6, CONTRACTS.md invariants 8 and 14): thin wrappers around `crate::fix`.
//! Planning and execution run on a blocking thread (file hashing, renames) and drive the shared
//! Modrinth client through the runtime handle. The `*_with` functions take everything the
//! commands get from Tauri, so tests run them without a Tauri runtime.

use tauri::{AppHandle, State};
use tauri_specta::Event;

use crate::error::{Error, Result};
use crate::fix::{self, ClientRemote, ExecEnv, Remote};
use crate::model::{BackupEntry, FixAction, GameStatus, OpStatus, PackIdentity, WorkOrder, WorkOrderResult};
use crate::state::AppState;

use super::instances::blocking;
use super::Cmd;

/// The online client when Modrinth is enabled in settings, else None (Replace / Install then
/// fail with `Offline`; nothing touches the network).
fn remote(st: &AppState, handle: &tokio::runtime::Handle) -> Result<Option<ClientRemote>> {
    if !st.settings.get().modrinth_enabled {
        return Ok(None);
    }
    let svc = st.modrinth.as_ref().ok_or_else(|| {
        Error::Internal("the Modrinth client could not be set up at startup because the app cache folder is unavailable".into())
    })?;
    Ok(Some(ClientRemote::new(svc.client(true).clone(), handle.clone())))
}

/// Blocking: plan and store an order. Must not run on an async worker thread.
pub(crate) fn plan_with(
    st: &AppState,
    handle: &tokio::runtime::Handle,
    instance_id: &str,
    pack: &PackIdentity,
    actions: &[FixAction],
) -> Result<WorkOrder> {
    let needs_remote = actions.iter().any(|a| matches!(a, FixAction::Replace { .. } | FixAction::InstallDependency { .. }));
    let r = if needs_remote { remote(st, handle)? } else { None };
    fix::plan_order(st, r.as_ref().map(|r| r as &dyn Remote), instance_id, pack, actions)
}

/// Blocking: execute a stored order with the real game guard.
pub(crate) fn execute_with(
    st: &AppState,
    handle: &tokio::runtime::Handle,
    order_id: &str,
    emit: &dyn Fn(OpStatus),
) -> Result<WorkOrderResult> {
    // A missing client only matters for downloads, which then fail as `Offline` (and roll back).
    let r = remote(st, handle).ok().flatten();
    let game_status = |id: &str| -> Result<GameStatus> { super::logs::game_status_blocking(st, id) };
    let env = ExecEnv { remote: r.as_ref().map(|r| r as &dyn Remote), game_status: &game_status, emit };
    fix::execute_order(st, order_id, &env)
}

pub(crate) fn list_backups_with(st: &AppState, instance_id: &str) -> Result<Vec<BackupEntry>> {
    let root = st.fixes.backups_root()?;
    fix::list_backups(&st.guard, &root, instance_id)
}

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
    state: State<'_, AppState>,
    instance_id: String,
    pack: PackIdentity,
    actions: Vec<FixAction>,
) -> Cmd<WorkOrder> {
    let st = AppState::clone(&state);
    let handle = tokio::runtime::Handle::current();
    let _scope = st.scope_lock.clone().read_owned().await;
    Ok(blocking(move || plan_with(&st, &handle, &instance_id, &pack, &actions)).await?)
}

/// Execute a stored order: guard check → snapshot → ops (emits `OpStatus`) → rollback on failure.
#[tauri::command]
#[specta::specta]
pub async fn execute_work_order(app: AppHandle, state: State<'_, AppState>, order_id: String) -> Cmd<WorkOrderResult> {
    let st = AppState::clone(&state);
    let handle = tokio::runtime::Handle::current();
    let _scope = st.scope_lock.clone().read_owned().await;
    Ok(blocking(move || {
        let emit = |s: OpStatus| {
            if let Err(e) = s.emit(&app) {
                eprintln!("fixes: could not emit OpStatus: {e}");
            }
        };
        execute_with(&st, &handle, &order_id, &emit)
    })
    .await?)
}

#[tauri::command]
#[specta::specta]
pub async fn discard_work_order(state: State<'_, AppState>, order_id: String) -> Cmd<()> {
    state.fixes.discard(&order_id);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn list_backups(state: State<'_, AppState>, instance_id: String) -> Cmd<Vec<BackupEntry>> {
    let st = AppState::clone(&state);
    Ok(blocking(move || list_backups_with(&st, &instance_id)).await?)
}

/// Plans the reverse of a backup as a work order (shown and confirmed like any other).
/// `action_indexes`: undo only those actions of the original order; None = all not yet undone.
/// `backup_id` must match `^[0-9a-f]{16}/[0-9]+$` and exist.
#[tauri::command]
#[specta::specta]
pub async fn plan_undo(
    state: State<'_, AppState>,
    backup_id: String,
    action_indexes: Option<Vec<u32>>,
) -> Cmd<WorkOrder> {
    let st = AppState::clone(&state);
    let _scope = st.scope_lock.clone().read_owned().await;
    Ok(blocking(move || fix::plan_undo(&st, &backup_id, action_indexes)).await?)
}

#[cfg(test)]
mod tests;
