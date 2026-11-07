//! `execute_work_order`: game guard → snapshot manifest → ops in plan order (each re-checking
//! its preconditions right before it runs) → on the first failure, every completed op is
//! reversed in reverse order and the remaining ops are skipped.
//!
//! Nothing is ever deleted: a removed or replaced jar is moved into the snapshot's `files/`, a
//! file a fix created is moved into `created/` when it is rolled back or undone. The only files
//! this module removes are its own temporary `.part` downloads.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::model::{BackupEntry, FileOp, GameStatus, OpState, OpStatus, WorkOrderResult};
use crate::state::AppState;

use super::fsops::{self, existing, is_absent, move_file, new_path};
use super::manifest::{self, FileChange, Manifest, OpRecord, RecState, UndoSession};
use super::remote::Remote;
use super::{Check, Expect, Loc, OpPlan, StoredOrder};

/// What the executor needs from the outside world (injected, so tests run without Tauri).
pub struct ExecEnv<'a> {
    /// The shared Modrinth client for downloads; None = Modrinth is off (downloads fail).
    pub remote: Option<&'a dyn Remote>,
    /// The running-game guard for an instance id (`game_running`).
    pub game_status: &'a dyn Fn(&str) -> Result<GameStatus>,
    /// Receives every `OpStatus` (Tauri event in the app).
    pub emit: &'a dyn Fn(OpStatus),
}

/// `execute_work_order`. Errors returned here happen before anything was touched (unknown or
/// expired order, Conflict, GameRunning, snapshot not writable). Once the snapshot manifest is
/// written the result is always `Ok`, with per-op statuses and `rolled_back`.
pub fn execute_order(st: &AppState, order_id: &str, env: &ExecEnv) -> Result<WorkOrderResult> {
    if !super::is_order_id(order_id) {
        return Err(super::expired_error());
    }
    let instance_id = st.fixes.peek_instance(order_id)?;
    let label = st.instance(&instance_id).map(|r| r.instance.name).unwrap_or_else(|_| instance_id.clone());
    let _exec = st.fixes.claim(&instance_id, &label)?;
    let scanning = || Error::Conflict(format!("\"{label}\" is being scanned. Wait for the scan to finish, then apply the fixes."));
    if st.scans.is_running(&instance_id) {
        return Err(scanning());
    }
    // Held for the whole order, so no scan reads a half-applied mods folder.
    let _scan = st.scans.begin(&instance_id, &label).map_err(|_| scanning())?;
    let (_, game_dir) = super::plan::instance_for(st, &instance_id)?;
    let status = (env.game_status)(&instance_id)?;
    if status.running {
        let why = status.reason.unwrap_or_else(|| "a Java process uses this instance".into());
        return Err(Error::GameRunning(why));
    }
    let stored = st.fixes.take(order_id)?;
    if stored.game_dir != game_dir {
        return Err(Error::Conflict("The instance's folder changed since the fixes were reviewed. Review them again.".into()));
    }
    run(&st.guard, env, stored)
}

/// The manifest being written for this order (its own for a fix, the original for an undo).
struct Journal {
    manifest: Manifest,
    /// Index into `manifest.undo_log` for an undo order.
    session: Option<usize>,
    dir: PathBuf,
}

impl Journal {
    fn records(&mut self) -> &mut Vec<OpRecord> {
        match self.session {
            Some(s) => &mut self.manifest.undo_log[s].records,
            None => &mut self.manifest.records,
        }
    }

    fn save(&self, guard: &PathGuard) -> Result<()> {
        manifest::save(guard, &self.dir, &self.manifest)
    }
}

/// Create the snapshot folder and write the first manifest (fix), or open the original
/// snapshot and append an undo session (undo). Nothing in the instance is touched yet.
fn open_journal(guard: &PathGuard, o: &StoredOrder) -> Result<Journal> {
    let dir = o.snapshot_dir.clone();
    let records: Vec<OpRecord> = o
        .order
        .ops
        .iter()
        .enumerate()
        .map(|(i, op)| OpRecord::pending(u32::try_from(i).unwrap_or(u32::MAX), op.action_index))
        .collect();
    match &o.undo {
        None => {
            let inst_dir = dir.parent().ok_or_else(|| Error::Internal("the backup folder has no parent".into()))?;
            fs::create_dir_all(inst_dir).map_err(|e| Error::io(inst_dir, e))?;
            guard.check_existing(inst_dir)?;
            if let Err(e) = fs::create_dir(&dir) {
                return Err(if e.kind() == std::io::ErrorKind::AlreadyExists {
                    Error::Conflict(format!("The backup folder {} already exists. Review the fixes again.", dir.display()))
                } else {
                    Error::io(&dir, e)
                });
            }
            let dir = guard.check_existing(&dir)?;
            let manifest = Manifest {
                format: manifest::FORMAT,
                entry: BackupEntry {
                    id: o.backup_id.clone(),
                    instance_id: o.order.instance_id.clone(),
                    created_at_ms: o.created_ms,
                    title: o.order.title.clone(),
                    actions: o.order.actions.clone(),
                    ops: o.order.ops.clone(),
                    undone_actions: Vec::new(),
                    // Until the order finishes, a manifest on disk means "interrupted".
                    status: crate::model::BackupStatus::Incomplete,
                },
                order_id: o.order.id.clone(),
                game_dir: o.game_dir.display().to_string(),
                records,
                rolled_back: false,
                finished: false,
                undo_log: Vec::new(),
            };
            let j = Journal { manifest, session: None, dir: dir.clone() };
            if let Err(e) = j.save(guard) {
                // Our own empty folder; without a manifest it would only be skipped forever.
                let _ = fs::remove_dir(&dir);
                return Err(e);
            }
            Ok(j)
        }
        Some(undo) => {
            let dir = guard.check_existing(&dir)?;
            let mut m = manifest::load(guard, &dir)?;
            if let Some(i) = undo.original_actions.iter().find(|i| m.entry.undone_actions.contains(i)) {
                return Err(Error::Conflict(format!(
                    "Action {} of this backup was undone in the meantime. Review the undo again.",
                    i + 1
                )));
            }
            m.undo_log.push(UndoSession {
                order_id: o.order.id.clone(),
                started_at_ms: fsops::now_ms(),
                action_indexes: undo.original_actions.clone(),
                ops: o.order.ops.clone(),
                records,
                rolled_back: false,
                finished: false,
            });
            let session = Some(m.undo_log.len() - 1);
            let j = Journal { manifest: m, session, dir };
            j.save(guard)?;
            Ok(j)
        }
    }
}

struct Cx<'a> {
    guard: &'a PathGuard,
    game: &'a Path,
    snap: &'a Path,
    remote: Option<&'a dyn Remote>,
}

impl Cx<'_> {
    fn base(&self, loc: Loc) -> &Path {
        match loc {
            Loc::Game => self.game,
            Loc::Snapshot => self.snap,
        }
    }

    /// One precondition, right now.
    fn verify(&self, c: &Check) -> Result<()> {
        let base = self.base(c.loc);
        let shown = match c.loc {
            Loc::Game => c.rel.clone(),
            Loc::Snapshot => format!("{} in the backup", c.rel),
        };
        match &c.expect {
            Expect::Absent => {
                let p = PathGuard::join_relative(base, &c.rel)?;
                if !is_absent(&p) {
                    return Err(Error::Conflict(format!(
                        "{shown} appeared since the fixes were reviewed, and it is never overwritten. Review the fixes again."
                    )));
                }
            }
            Expect::File(want) => {
                let gone = || Error::Conflict(format!("{shown} is gone since the fixes were reviewed. Review the fixes again."));
                let p = match existing(self.guard, base, &c.rel) {
                    Ok(p) => p,
                    Err(Error::NotFound { .. }) => return Err(gone()),
                    Err(e) => return Err(e),
                };
                let changed = || Error::Conflict(format!("{shown} changed since the fixes were reviewed. Review the fixes again."));
                match fsops::quick_stat(&p) {
                    Ok((size, mtime, true)) if size == want.size && mtime == want.mtime_ms => {}
                    Ok(_) => return Err(changed()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(gone()),
                    Err(e) => return Err(Error::io(&p, e)),
                }
                if fsops::sha1_file(&p)? != want.sha1 {
                    return Err(changed());
                }
            }
        }
        Ok(())
    }

    fn verify_all(&self, plan: &OpPlan) -> Result<()> {
        plan.checks.iter().try_for_each(|c| self.verify(c))
    }

    /// Move a file between the game dir and the snapshot (either direction), creating the
    /// destination's parent folders inside the snapshot when needed.
    fn mv(&self, from: (Loc, &str), to: (Loc, &str)) -> Result<()> {
        let src = existing(self.guard, self.base(from.0), from.1)?;
        if to.0 == Loc::Snapshot {
            fsops::ensure_parent(self.guard, self.snap, to.1)?;
        }
        let dst = new_path(self.guard, self.base(to.0), to.1)?;
        move_file(&src, &dst)
    }
}

/// The sha1 a plan recorded for an existing file.
fn planned_sha(plan: &OpPlan, loc: Loc, rel: &str) -> Option<String> {
    plan.checks.iter().find_map(|c| match &c.expect {
        Expect::File(s) if c.loc == loc && c.rel == rel => Some(s.sha1.clone()),
        _ => None,
    })
}

fn missing_sha(rel: &str) -> Error {
    Error::Internal(format!("the plan for {rel} has no fingerprint"))
}

/// Run one op (preconditions already verified). On error the op has reverted its own partial
/// work, unless the error message says where a file was left (and `rec.files` records it).
fn run_op(cx: &Cx, op: &FileOp, plan: &OpPlan, rec: &mut OpRecord) -> Result<()> {
    match op {
        FileOp::Rename { from, to } => {
            let sha = planned_sha(plan, Loc::Game, from).ok_or_else(|| missing_sha(from))?;
            cx.mv((Loc::Game, from), (Loc::Game, to))?;
            rec.files = vec![
                FileChange { path: from.clone(), before: Some(sha.clone()), after: None, backup_path: None },
                FileChange { path: to.clone(), before: None, after: Some(sha), backup_path: None },
            ];
            Ok(())
        }
        FileOp::MoveToBackup { path } => {
            let sha = planned_sha(plan, Loc::Game, path).ok_or_else(|| missing_sha(path))?;
            let backup = format!("files/{path}");
            cx.mv((Loc::Game, path), (Loc::Snapshot, &backup))?;
            rec.files = vec![FileChange { path: path.clone(), before: Some(sha), after: None, backup_path: Some(backup) }];
            Ok(())
        }
        FileOp::Download { url, sha512, size_bytes, dest, replaces, .. } => download(cx, plan, rec, url, sha512, *size_bytes, dest, replaces.as_deref()),
        FileOp::Restore { backup_path, to, expect_absent_or_sha1 } => {
            if expect_absent_or_sha1.is_some() {
                return Err(Error::Internal("restoring over an existing file is not supported".into()));
            }
            let sha = planned_sha(plan, Loc::Snapshot, backup_path).ok_or_else(|| missing_sha(backup_path))?;
            cx.mv((Loc::Snapshot, backup_path), (Loc::Game, to))?;
            rec.files = vec![FileChange { path: to.clone(), before: None, after: Some(sha), backup_path: Some(backup_path.clone()) }];
            Ok(())
        }
        FileOp::RemoveCreated { path, expect_sha1 } => {
            let created = fsops::unique_rel(cx.snap, &format!("created/{path}"))?;
            cx.mv((Loc::Game, path), (Loc::Snapshot, &created))?;
            rec.files = vec![FileChange {
                path: path.clone(),
                before: Some(expect_sha1.clone()),
                after: None,
                backup_path: Some(created.clone()),
            }];
            rec.created_backup = Some(created);
            Ok(())
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn download(
    cx: &Cx,
    plan: &OpPlan,
    rec: &mut OpRecord,
    url: &str,
    sha512: &str,
    size: u64,
    dest: &str,
    replaces: Option<&str>,
) -> Result<()> {
    let remote = cx.remote.ok_or(Error::Offline)?;
    let mods = cx.guard.check_existing(&cx.game.join("mods"))?;
    let dest_name = fsops::file_name_of(dest);
    let temp_name = format!("{dest_name}.{}", fsops::random_hex(1));
    let part = remote.download(url, sha512, size, &mods, &temp_name)?;
    let expected_part = mods.join(format!(".{temp_name}.part"));
    let drop_part = || {
        if !is_absent(&part) {
            let _ = fs::remove_file(&part);
        }
    };
    if part != expected_part {
        drop_part();
        return Err(Error::Internal("the download landed in an unexpected place".into()));
    }
    let result = (|| {
        let bytes = fs::read(&part).map_err(|e| Error::io(&part, e))?;
        let new_sha = fsops::sha1_bytes(&bytes);
        let ids = super::plan::jar_mod_ids(&bytes, dest);
        if !plan.expect_mod_ids.iter().any(|want| ids.contains(want)) {
            let declared = if ids.is_empty() { "none".to_string() } else { ids.join(", ") };
            return Err(Error::Corrupt {
                path: dest_name.to_string(),
                reason: format!(
                    "it does not declare the expected mod id {} (it declares: {declared}), so it was not installed",
                    plan.expect_mod_ids.join(" or ")
                ),
            });
        }
        Ok(new_sha)
    })();
    let new_sha = match result {
        Ok(v) => v,
        Err(e) => {
            drop_part();
            return Err(e);
        }
    };

    // Move the replaced jar into the snapshot (re-checked right before).
    let mut moved: Option<(String, String, String)> = None;
    if let Some(r) = replaces {
        let sha = planned_sha(plan, Loc::Game, r).ok_or_else(|| missing_sha(r));
        let step = sha.and_then(|sha| {
            let check = plan.checks.iter().find(|c| c.loc == Loc::Game && c.rel == r).cloned().ok_or_else(|| missing_sha(r))?;
            cx.verify(&check)?;
            let backup = format!("files/{r}");
            cx.mv((Loc::Game, r), (Loc::Snapshot, &backup))?;
            Ok((r.to_string(), backup, sha))
        });
        match step {
            Ok(m) => moved = Some(m),
            Err(e) => {
                drop_part();
                return Err(e);
            }
        }
    }

    // Into place: the destination must still be absent, then rename (same folder).
    let placed = (|| {
        let dst = new_path(cx.guard, cx.game, dest)?;
        if !is_absent(&dst) {
            return Err(Error::Conflict(format!("{dest} appeared during the download, and it is never overwritten.")));
        }
        fs::rename(&part, &dst).map_err(|e| Error::io(&dst, e))
    })();
    if let Err(e) = placed {
        drop_part();
        if let Some((r, backup, sha)) = &moved {
            if let Err(back) = cx.mv((Loc::Snapshot, backup), (Loc::Game, r)) {
                rec.files = vec![FileChange { path: r.clone(), before: Some(sha.clone()), after: None, backup_path: Some(backup.clone()) }];
                return Err(Error::Conflict(format!(
                    "{e} Moving {r} back also failed ({back}); it is in the backup at {}.",
                    cx.snap.join(backup).display()
                )));
            }
        }
        return Err(e);
    }

    rec.files = match moved {
        Some((r, backup, sha)) if fsops::fold(&r) == fsops::fold(dest) => {
            vec![FileChange { path: dest.to_string(), before: Some(sha), after: Some(new_sha), backup_path: Some(backup) }]
        }
        Some((r, backup, sha)) => vec![
            FileChange { path: r, before: Some(sha), after: None, backup_path: Some(backup) },
            FileChange { path: dest.to_string(), before: None, after: Some(new_sha), backup_path: None },
        ],
        None => vec![FileChange { path: dest.to_string(), before: None, after: Some(new_sha), backup_path: None }],
    };
    Ok(())
}

/// Reverse one completed op (automatic rollback).
fn rollback_op(cx: &Cx, op: &FileOp, rec: &mut OpRecord) -> Result<()> {
    match op {
        FileOp::Rename { from, to } => cx.mv((Loc::Game, to), (Loc::Game, from)),
        FileOp::MoveToBackup { path } => cx.mv((Loc::Snapshot, &format!("files/{path}")), (Loc::Game, path)),
        FileOp::Download { dest, replaces, .. } => {
            let created = fsops::unique_rel(cx.snap, &format!("created/{dest}"))?;
            cx.mv((Loc::Game, dest), (Loc::Snapshot, &created))?;
            rec.created_backup = Some(created);
            if let Some(r) = replaces {
                cx.mv((Loc::Snapshot, &format!("files/{r}")), (Loc::Game, r))?;
            }
            Ok(())
        }
        FileOp::Restore { backup_path, to, .. } => cx.mv((Loc::Game, to), (Loc::Snapshot, backup_path)),
        FileOp::RemoveCreated { path, .. } => {
            let created = rec.created_backup.clone().ok_or_else(|| missing_sha(path))?;
            cx.mv((Loc::Snapshot, &created), (Loc::Game, path))
        }
    }
}

fn status(order_id: &str, index: usize, state: OpState, message: Option<String>) -> OpStatus {
    OpStatus { order_id: order_id.to_string(), index: u32::try_from(index).unwrap_or(u32::MAX), state, message }
}

/// Run a stored order end to end. See the module docs.
#[allow(clippy::needless_range_loop)] // ops, plans, statuses and records are parallel vectors
pub(crate) fn run(guard: &PathGuard, env: &ExecEnv, o: StoredOrder) -> Result<WorkOrderResult> {
    let mut journal = open_journal(guard, &o)?;
    let id = o.order.id.as_str();
    let cx = Cx { guard, game: &o.game_dir, snap: &journal.dir.clone(), remote: env.remote };
    let n = o.order.ops.len();
    let mut statuses: Vec<OpStatus> = (0..n).map(|i| status(id, i, OpState::Pending, None)).collect();
    let mut failed_at: Option<usize> = None;

    for i in 0..n {
        let op = &o.order.ops[i].op;
        let plan = &o.plans[i];
        journal.records()[i].state = RecState::Running;
        statuses[i] = status(id, i, OpState::Running, None);
        (env.emit)(statuses[i].clone());

        let mut rec = journal.records()[i].clone();
        let outcome = cx.verify_all(plan).and_then(|()| run_op(&cx, op, plan, &mut rec));
        match outcome {
            Ok(()) => {
                rec.state = RecState::Done;
                statuses[i] = status(id, i, OpState::Done, None);
            }
            Err(e) => {
                rec.state = RecState::Failed;
                rec.message = Some(e.to_string());
                statuses[i] = status(id, i, OpState::Failed, Some(e.to_string()));
                failed_at = Some(i);
            }
        }
        journal.records()[i] = rec;
        if let Err(e) = journal.save(guard) {
            // The op may be applied but is not recorded: treat it as failed and roll it back.
            let msg = format!("The backup record could not be saved ({e}), so the fixes were stopped.");
            statuses[i] = status(id, i, OpState::Failed, Some(msg.clone()));
            journal.records()[i].message = Some(msg);
            failed_at.get_or_insert(i);
        }
        if failed_at.is_some() {
            if journal.records()[i].state == RecState::Done {
                // Reported after the rollback below.
            } else {
                (env.emit)(statuses[i].clone());
            }
            break;
        }
        (env.emit)(statuses[i].clone());
    }

    if let Some(fail) = failed_at {
        for j in fail + 1..n {
            journal.records()[j].state = RecState::Skipped;
            statuses[j] = status(id, j, OpState::Skipped, Some("Not started because an earlier step failed.".into()));
            (env.emit)(statuses[j].clone());
        }
        for j in (0..=fail).rev() {
            if journal.records()[j].state != RecState::Done {
                continue;
            }
            let mut rec = journal.records()[j].clone();
            match rollback_op(&cx, &o.order.ops[j].op, &mut rec) {
                Ok(()) => {
                    rec.state = RecState::RolledBack;
                    if j == fail {
                        let msg = statuses[j].message.clone().unwrap_or_default();
                        statuses[j] = status(id, j, OpState::Failed, Some(format!("{msg} This step was rolled back.")));
                    } else {
                        statuses[j] = status(id, j, OpState::Skipped, Some(format!("Rolled back because step {} failed.", fail + 1)));
                    }
                }
                Err(e) => {
                    let msg = format!(
                        "Done, but the automatic rollback failed: {e} The backup in {} is kept so this can still be undone.",
                        journal.dir.display()
                    );
                    rec.state = RecState::RollbackFailed;
                    rec.message = Some(msg.clone());
                    statuses[j] = status(id, j, OpState::Failed, Some(msg));
                }
            }
            journal.records()[j] = rec;
            if let Err(e) = journal.save(guard) {
                eprintln!("fixes: could not update the backup manifest in {}: {e}", journal.dir.display());
            }
            (env.emit)(statuses[j].clone());
        }
    }

    // Finish the record.
    let rolled_back = failed_at.is_some();
    match journal.session {
        None => {
            journal.manifest.rolled_back = rolled_back;
            journal.manifest.finished = true;
            journal.manifest.compute_undone();
        }
        Some(s) => {
            let session = &mut journal.manifest.undo_log[s];
            session.rolled_back = rolled_back;
            session.finished = true;
            if !rolled_back {
                let done = session.action_indexes.clone();
                let undone = &mut journal.manifest.entry.undone_actions;
                undone.extend(done);
                undone.sort_unstable();
                undone.dedup();
            }
        }
    }
    if let Err(e) = journal.save(guard) {
        eprintln!("fixes: could not finish the backup manifest in {}: {e}", journal.dir.display());
    }

    Ok(WorkOrderResult { order_id: id.to_string(), backup_id: Some(o.backup_id.clone()), statuses, rolled_back })
}
