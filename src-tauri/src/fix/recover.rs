//! Interrupted orders (CONTRACTS.md invariant 14, "Write-ahead and recovery").
//!
//! An order (or undo session) whose manifest record is still unfinished while it is not
//! executing was interrupted (the app is a single process). Its manifest is marked
//! `interrupted`, and the leftover temporary files its records name — `mods/.<name>.<hex>.part`
//! downloads and `<dir>/.<name>.<hex>.part` copies of a cross-volume move — are moved into its
//! snapshot (`created/…`), never deleted. Its status is `incomplete`; `plan_undo(id, None)` then
//! plans the recovery from the actual file locations (see `undo`).
//!
//! Runs at startup (for every instance with backups), before `list_backups` and before an
//! order executes. A pass holds the recovery lock ([`super::FixState::recovery_lock`]), never an
//! instance's execution claim, so it never makes an execution fail with a Conflict. It skips the
//! manifest an executing order writes (bound to its claim under the same lock), and it moves
//! leftover files only while no order of that instance executes. Moving needs the instance's
//! game dir inside the PathGuard, which holds the instance roots only after discovery; until
//! then only the marking happens.

use std::collections::HashSet;
use std::path::Path;

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::state::AppState;

use super::fsops::{self, existing, is_absent, move_file, new_path};
use super::manifest::{self, OpRecord};

/// Move one leftover temporary file into the snapshot. `Ok(None)` when it is not there (any
/// more).
fn move_leftover(guard: &PathGuard, game: &Path, snap: &Path, rel: &str, valid: fn(&str) -> bool) -> Result<Option<String>> {
    if !valid(rel) {
        return Err(Error::Invalid(format!("{rel} is not a temporary file of Modpack Doctor")));
    }
    if is_absent(&PathGuard::join_relative(game, rel)?) {
        return Ok(None);
    }
    let src = existing(guard, game, rel)?;
    let meta = std::fs::symlink_metadata(&src).map_err(|e| Error::io(&src, e))?;
    if !meta.is_file() {
        return Err(Error::Invalid(format!("{rel} is not a regular file, so it is left alone")));
    }
    let dest = fsops::unique_rel(snap, &format!("created/{rel}"))?;
    fsops::ensure_parent(guard, snap, &dest)?;
    let dst = new_path(guard, snap, &dest)?;
    move_file(&src, &dst)?;
    Ok(Some(dest))
}

/// Move the leftover `.part` downloads (`parts`) and copy temps these records name into the
/// snapshot; true when any moved.
fn move_leftovers(guard: &PathGuard, game: &Path, snap: &Path, records: &mut [OpRecord], parts: bool) -> bool {
    let mut changed = false;
    let moved = |rel: &str, valid: fn(&str) -> bool| match move_leftover(guard, game, snap, rel, valid) {
        Ok(Some(dest)) => {
            eprintln!("backups: moved the leftover temporary file {rel} into {}", snap.join(&dest).display());
            Some(dest)
        }
        Ok(None) => None,
        Err(e) => {
            eprintln!("backups: left {rel} in place: {e}");
            None
        }
    };
    for rec in records {
        if parts && rec.part_backup.is_none() {
            if let Some(part) = rec.part.clone() {
                if let Some(dest) = moved(&part, manifest::is_part_rel) {
                    rec.part_backup = Some(dest);
                    changed = true;
                }
            }
        }
        for t in rec.temps.iter_mut().filter(|t| t.backup.is_none()) {
            if let Some(dest) = moved(&t.path, manifest::is_temp_rel) {
                t.backup = Some(dest);
                changed = true;
            }
        }
    }
    changed
}

/// Mark the instance's interrupted manifests and move their leftover temporary files into their
/// snapshots. The caller holds the recovery lock; `busy` are the backups executing orders write
/// (skipped). `game_dir`: the registered (and vetted) game dir, passed only when no other order
/// of this instance executes (else nothing is moved). Best effort: problems are logged, never
/// fatal.
pub fn recover_instance(guard: &PathGuard, backups_root: &Path, instance_id: &str, game_dir: Option<&Path>, busy: &HashSet<String>) {
    let snaps = match manifest::snapshot_dirs(guard, backups_root, instance_id) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("backups: could not check {instance_id} for interrupted fixes: {e}");
            return;
        }
    };
    for snap in snaps {
        let ms = snap.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if busy.contains(&format!("{instance_id}/{ms}")) {
            continue; // an executing order writes this manifest
        }
        let Ok(mut m) = manifest::load(guard, &snap) else { continue };
        if m.finished && m.undo_log.iter().all(|s| s.finished) {
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
        if let Some(game) = game_dir.filter(|g| Path::new(&m.game_dir) == *g) {
            if !m.finished {
                changed |= move_leftovers(guard, game, &snap, &mut m.records, true);
            }
            for s in m.undo_log.iter_mut().filter(|s| !s.finished) {
                changed |= move_leftovers(guard, game, &snap, &mut s.records, false);
            }
        }
        if changed {
            if let Err(e) = manifest::save(guard, &snap, &m) {
                eprintln!("backups: could not update {}: {e}", snap.display());
            }
        }
    }
}

/// `recover_instance` for one registered or unregistered instance, under the recovery lock.
/// Never blocks or fails an execution: while an order of the instance executes, its manifest is
/// left alone and nothing is moved.
pub fn recover_one(st: &AppState, instance_id: &str) {
    let Ok(root) = st.fixes.backups_root() else { return };
    let _recovery = st.fixes.recovery_lock();
    let busy = st.fixes.busy_backups();
    // Under the recovery lock no order of this instance can start running its ops (it binds its
    // backup under this lock first), so "not executing" holds for the whole pass.
    let game = if st.fixes.is_executing(instance_id) {
        None
    } else {
        super::plan::instance_for(st, instance_id).ok().map(|(_, g)| g)
    };
    recover_instance(&st.guard, &root, instance_id, game.as_deref(), &busy);
}

/// Startup: every instance folder under `<app data>/backups`.
pub fn recover_at_startup(st: &AppState) {
    let Ok(root) = st.fixes.backups_root() else { return };
    let Ok(rd) = std::fs::read_dir(&root) else { return };
    for entry in rd.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if super::is_instance_id(&name) {
            recover_one(st, &name);
        }
    }
}
