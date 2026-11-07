//! `plan_undo`: the reverse of a backup snapshot, per action, as a `kind: undo` work order.
//!
//! Each reverse op is checked against the manifest's "after" state now: the file a fix created
//! or renamed must still have the sha1 it had right after the fix, a path the fix emptied must
//! still be empty, and the snapshot copy must still match the "before" sha1. Any mismatch fails
//! planning for that action with a readable error (the user changed the file since); nothing is
//! ever silently overwritten. Reverse ops of one fix op:
//! - `Rename{from,to}` → `Rename{to,from}`;
//! - `MoveToBackup{path}` → `Restore{files/path → path}`;
//! - `Download{dest, replaces}` → `RemoveCreated{dest}` then `Restore{files/replaces → replaces}`.
//!
//! Undo orders work inside the original snapshot: `Restore` moves files back out of `files/`,
//! `RemoveCreated` moves the created file into `created/`. On success the original manifest's
//! `undoneActions` gains the undone actions.

use std::path::Path;
use std::time::Instant;

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::model::{FileOp, FixAction, PlannedOp, WorkOrder, WorkOrderKind};
use crate::state::AppState;

use super::fsops::{self, Stamp};
use super::manifest::{self, FileChange, Manifest};
use super::plan::{action_label, decapitalize, instance_for, title_for};
use super::{Check, Expect, Loc, OpPlan, StoredOrder, UndoOf};

/// `^[0-9a-f]{16}/[0-9]+$` → (instance id, ms).
pub fn parse_backup_id(id: &str) -> Result<(String, u64)> {
    let bad = || Error::Invalid(format!("\"{}\" is not a backup id", id.chars().take(48).collect::<String>()));
    let (inst, ms) = id.split_once('/').ok_or_else(bad)?;
    if !super::is_instance_id(inst) || ms.is_empty() || ms.len() > 19 || !ms.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let n: u64 = ms.parse().map_err(|_| bad())?;
    if n.to_string() != ms {
        return Err(bad());
    }
    Ok((inst.to_string(), n))
}

struct Ctx<'a> {
    guard: &'a PathGuard,
    game: &'a Path,
    snap: &'a Path,
    label: String,
}

impl Ctx<'_> {
    fn refuse(&self, msg: impl std::fmt::Display) -> Error {
        Error::Invalid(format!("{}: {msg}", self.label))
    }

    /// The current file at `rel` must exist with `sha`; returns its fingerprint.
    fn expect_file(&self, loc: Loc, rel: &str, sha: &str) -> Result<Stamp> {
        let (base, shown) = match loc {
            Loc::Game => (self.game, rel.to_string()),
            Loc::Snapshot => (self.snap, format!("the backup copy {rel}")),
        };
        let path = match fsops::existing(self.guard, base, rel) {
            Ok(p) => p,
            Err(Error::NotFound { .. }) => return Err(self.refuse(format!("{shown} is gone since the fix, so it cannot be undone safely"))),
            Err(e) => return Err(e),
        };
        let st = fsops::stamp(&path)?;
        if st.sha1 != sha {
            return Err(self.refuse(format!("{shown} was changed since the fix, so undoing would overwrite your change")));
        }
        Ok(st)
    }

    fn expect_absent(&self, rel: &str) -> Result<()> {
        let p = fsops::new_path(self.guard, self.game, rel)?;
        if !fsops::is_absent(&p) {
            return Err(self.refuse(format!("{rel} exists again since the fix, and it is never overwritten")));
        }
        Ok(())
    }
}

fn after_of<'a>(files: &'a [FileChange], rel: &str) -> Option<&'a FileChange> {
    files.iter().find(|f| f.path == rel)
}

fn corrupt(snap: &Path) -> Error {
    Error::Corrupt { path: snap.join(manifest::MANIFEST).display().to_string(), reason: "an op record lacks its file hashes".into() }
}

/// Reverse ops (with preconditions) of one applied fix op.
fn reverse(cx: &Ctx, op: &FileOp, files: &[FileChange], out: &mut Vec<(FileOp, OpPlan)>) -> Result<()> {
    match op {
        FileOp::Rename { from, to } => {
            let sha = after_of(files, to).and_then(|f| f.after.clone()).ok_or_else(|| corrupt(cx.snap))?;
            let st = cx.expect_file(Loc::Game, to, &sha)?;
            cx.expect_absent(from)?;
            let checks = vec![
                Check { loc: Loc::Game, rel: to.clone(), expect: Expect::File(st) },
                Check { loc: Loc::Game, rel: from.clone(), expect: Expect::Absent },
            ];
            out.push((FileOp::Rename { from: to.clone(), to: from.clone() }, OpPlan { checks, expect_mod_ids: Vec::new() }));
        }
        FileOp::MoveToBackup { path } => {
            let f = after_of(files, path).ok_or_else(|| corrupt(cx.snap))?;
            let (Some(backup), Some(sha)) = (f.backup_path.clone(), f.before.clone()) else { return Err(corrupt(cx.snap)) };
            let st = cx.expect_file(Loc::Snapshot, &backup, &sha)?;
            cx.expect_absent(path)?;
            let checks = vec![
                Check { loc: Loc::Snapshot, rel: backup.clone(), expect: Expect::File(st) },
                Check { loc: Loc::Game, rel: path.clone(), expect: Expect::Absent },
            ];
            let op = FileOp::Restore { backup_path: backup, to: path.clone(), expect_absent_or_sha1: None };
            out.push((op, OpPlan { checks, expect_mod_ids: Vec::new() }));
        }
        FileOp::Download { dest, replaces, .. } => {
            let created = after_of(files, dest).and_then(|f| f.after.clone()).ok_or_else(|| corrupt(cx.snap))?;
            let st = cx.expect_file(Loc::Game, dest, &created)?;
            let checks = vec![Check { loc: Loc::Game, rel: dest.clone(), expect: Expect::File(st) }];
            out.push((FileOp::RemoveCreated { path: dest.clone(), expect_sha1: created }, OpPlan { checks, expect_mod_ids: Vec::new() }));
            if let Some(r) = replaces {
                let f = after_of(files, r).ok_or_else(|| corrupt(cx.snap))?;
                let (Some(backup), Some(sha)) = (f.backup_path.clone(), f.before.clone()) else { return Err(corrupt(cx.snap)) };
                let st = cx.expect_file(Loc::Snapshot, &backup, &sha)?;
                if fsops::fold(r) != fsops::fold(dest) {
                    cx.expect_absent(r)?;
                }
                let checks = vec![
                    Check { loc: Loc::Snapshot, rel: backup.clone(), expect: Expect::File(st) },
                    Check { loc: Loc::Game, rel: r.clone(), expect: Expect::Absent },
                ];
                let op = FileOp::Restore { backup_path: backup, to: r.clone(), expect_absent_or_sha1: None };
                out.push((op, OpPlan { checks, expect_mod_ids: Vec::new() }));
            }
        }
        FileOp::Restore { .. } | FileOp::RemoveCreated { .. } => return Err(corrupt(cx.snap)),
    }
    Ok(())
}

/// The actions to undo: the requested ones (each must be applied and not undone yet), or all
/// applied, not yet undone actions.
fn select(m: &Manifest, requested: Option<Vec<u32>>) -> Result<Vec<u32>> {
    let applied = |i: u32| {
        let recs: Vec<_> = m.records.iter().filter(|r| r.action_index == i).collect();
        !recs.is_empty() && recs.iter().all(|r| r.state.applied())
    };
    let n = u32::try_from(m.entry.actions.len()).unwrap_or(u32::MAX);
    match requested {
        Some(mut idx) => {
            idx.sort_unstable();
            idx.dedup();
            if idx.is_empty() {
                return Err(Error::Invalid("no actions were chosen to undo".into()));
            }
            for &i in &idx {
                let Some(a) = m.entry.actions.get(i as usize) else {
                    return Err(Error::Invalid(format!("this backup has no action {}", u64::from(i) + 1)));
                };
                let label = action_label(a);
                if m.entry.undone_actions.contains(&i) {
                    return Err(Error::Invalid(format!("Undo {}: it was already undone", decapitalize(&label))));
                }
                if matches!(a, FixAction::Manual { .. }) {
                    return Err(Error::Invalid(format!("Undo {}: manual steps changed no files", decapitalize(&label))));
                }
                if !applied(i) {
                    return Err(Error::Invalid(format!(
                        "Undo {}: this action did not complete, so there is nothing to undo (any files it moved are in the backup folder)",
                        decapitalize(&label)
                    )));
                }
            }
            Ok(idx)
        }
        None => {
            let idx: Vec<u32> = (0..n).filter(|i| !m.entry.undone_actions.contains(i) && applied(*i)).collect();
            if idx.is_empty() {
                return Err(Error::Invalid("everything in this backup is already undone".into()));
            }
            Ok(idx)
        }
    }
}

/// `plan_undo`. Stores the undo order and returns it.
pub fn plan_undo(st: &AppState, backup_id: &str, action_indexes: Option<Vec<u32>>) -> Result<WorkOrder> {
    let (instance_id, ms) = parse_backup_id(backup_id)?;
    let (_, game_dir) = instance_for(st, &instance_id)?;
    let root = st.fixes.backups_root()?;
    let snap = super::snapshot_dir(&root, &instance_id, ms);
    if fsops::is_absent(&snap) {
        return Err(Error::NotFound { path: format!("the backup {backup_id}") });
    }
    let snap = st.guard.check_existing(&snap)?;
    let m = manifest::load(&st.guard, &snap)?;
    let selected = select(&m, action_indexes)?;

    let mut ops: Vec<PlannedOp> = Vec::new();
    let mut plans: Vec<OpPlan> = Vec::new();
    // Reverse op order across the whole backup, keeping only the selected actions.
    for (op, rec) in m.entry.ops.iter().zip(&m.records).rev() {
        let Some(pos) = selected.iter().position(|i| *i == op.action_index) else { continue };
        let label = format!("Undo {}", decapitalize(&action_label(&m.entry.actions[op.action_index as usize])));
        let cx = Ctx { guard: &st.guard, game: &game_dir, snap: &snap, label };
        let mut out = Vec::new();
        reverse(&cx, &op.op, &rec.files, &mut out)?;
        for (fop, plan) in out {
            ops.push(PlannedOp { action_index: u32::try_from(pos).unwrap_or(u32::MAX), op: fop });
            plans.push(plan);
        }
    }

    let actions: Vec<FixAction> = selected.iter().map(|i| m.entry.actions[*i as usize].clone()).collect();
    let order = WorkOrder {
        id: fsops::random_hex(2),
        instance_id: instance_id.clone(),
        kind: WorkOrderKind::Undo,
        title: format!("Undo {}", decapitalize(&title_for(&actions))),
        actions,
        ops,
        notes: Vec::new(),
        backup_dir: snap.display().to_string(),
    };
    st.fixes.store(StoredOrder {
        order: order.clone(),
        plans,
        game_dir,
        snapshot_dir: snap,
        backup_id: format!("{instance_id}/{ms}"),
        created_ms: ms,
        undo: Some(UndoOf { original_actions: selected }),
        expires: Instant::now() + st.fixes.ttl(),
    });
    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_ids() {
        assert!(parse_backup_id("0123456789abcdef/1700000000000").is_ok());
        for bad in ["", "0123456789abcdef", "0123456789ABCDEF/1", "0123456789abcdef/", "0123456789abcdef/1a", "../x/1", "0123456789abcdef/01", "0123456789abcde/1"] {
            assert!(parse_backup_id(bad).is_err(), "{bad:?} accepted");
        }
    }
}
