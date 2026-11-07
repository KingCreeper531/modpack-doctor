//! Interrupted orders (CONTRACTS.md invariant 14, "Write-ahead and recovery").
//!
//! An order whose manifest is still unfinished while no order of that instance executes was
//! interrupted (the app is a single process and holds the instance's execution claim while
//! this runs). Its manifest is marked `interrupted`, and the leftover `mods/.<name>.<hex>.part`
//! downloads its records name are moved into its snapshot (`created/…`), never deleted. Its
//! status is `incomplete`; `plan_undo(id, None)` then plans the recovery from the actual file
//! locations (see `undo`).
//!
//! Runs at startup (for every instance with backups), before `list_backups` and before an
//! order executes. Moving a `.part` needs the instance's game dir inside the PathGuard, which
//! holds the instance roots only after discovery; until then only the marking happens.

use std::path::Path;

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::state::AppState;

use super::fsops::{self, existing, is_absent, move_file, new_path};
use super::manifest;

/// Move one leftover `.part` into the snapshot. `Ok(None)` when it is not there (any more).
fn move_part(guard: &PathGuard, game: &Path, snap: &Path, part: &str) -> Result<Option<String>> {
    if !manifest::is_part_rel(part) {
        return Err(Error::Invalid(format!("{part} is not a temporary download")));
    }
    if is_absent(&PathGuard::join_relative(game, part)?) {
        return Ok(None);
    }
    let src = existing(guard, game, part)?;
    let meta = std::fs::symlink_metadata(&src).map_err(|e| Error::io(&src, e))?;
    if !meta.is_file() {
        return Err(Error::Invalid(format!("{part} is not a regular file, so it is left alone")));
    }
    let dest = fsops::unique_rel(snap, &format!("created/{part}"))?;
    fsops::ensure_parent(guard, snap, &dest)?;
    let dst = new_path(guard, snap, &dest)?;
    move_file(&src, &dst)?;
    Ok(Some(dest))
}

/// Mark the instance's interrupted manifests and move their leftover `.part` files into their
/// snapshots. The caller holds the instance's execution claim. `game_dir`: the registered (and
/// vetted) game dir, if known. Best effort: problems are logged, never fatal.
pub fn recover_instance(guard: &PathGuard, backups_root: &Path, instance_id: &str, game_dir: Option<&Path>) {
    let snaps = match manifest::snapshot_dirs(guard, backups_root, instance_id) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("backups: could not check {instance_id} for interrupted fixes: {e}");
            return;
        }
    };
    for snap in snaps {
        let Ok(mut m) = manifest::load(guard, &snap) else { continue };
        let open_undo = m.undo_log.iter().any(|s| !s.finished && !s.interrupted);
        if m.finished && !open_undo {
            continue;
        }
        let mut changed = false;
        if !m.finished && !m.interrupted {
            m.interrupted = true;
            changed = true;
        }
        for s in m.undo_log.iter_mut().filter(|s| !s.finished && !s.interrupted) {
            s.interrupted = true;
            changed = true;
        }
        let same_game = game_dir.is_some_and(|g| Path::new(&m.game_dir) == g);
        if !m.finished && same_game {
            let game = game_dir.unwrap_or(Path::new(""));
            for rec in m.records.iter_mut().filter(|r| r.part_backup.is_none()) {
                let Some(part) = rec.part.clone() else { continue };
                match move_part(guard, game, &snap, &part) {
                    Ok(Some(dest)) => {
                        eprintln!("backups: moved the leftover download {part} into {}", snap.join(&dest).display());
                        rec.part_backup = Some(dest);
                        changed = true;
                    }
                    Ok(None) => {}
                    Err(e) => eprintln!("backups: left {part} in place: {e}"),
                }
            }
        }
        if changed {
            if let Err(e) = manifest::save(guard, &snap, &m) {
                eprintln!("backups: could not update {}: {e}", snap.display());
            }
        }
    }
}

/// `recover_instance` for one registered or unregistered instance, under its execution claim
/// (skipped while an order of that instance executes).
pub fn recover_with_claim(st: &AppState, instance_id: &str) {
    let Ok(root) = st.fixes.backups_root() else { return };
    let Ok(_ticket) = st.fixes.claim(instance_id, instance_id) else { return };
    let game = super::plan::instance_for(st, instance_id).ok().map(|(_, g)| g);
    recover_instance(&st.guard, &root, instance_id, game.as_deref());
}

/// Startup: every instance folder under `<app data>/backups`.
pub fn recover_at_startup(st: &AppState) {
    let Ok(root) = st.fixes.backups_root() else { return };
    let Ok(rd) = std::fs::read_dir(&root) else { return };
    for entry in rd.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if super::is_instance_id(&name) {
            recover_with_claim(st, &name);
        }
    }
}
