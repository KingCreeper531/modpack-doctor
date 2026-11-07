//! `execute_work_order`: game guard → snapshot manifest → ops in plan order (each re-checking
//! its preconditions right before it runs) → on the first failure, every completed op is
//! reversed in reverse order and the remaining ops are skipped.
//!
//! Write-ahead (CONTRACTS.md invariant 14): before an op mutates anything its record is saved
//! (fsynced) as `running` with every intended move — the files and their sha1s, the `.part`
//! name, the `created/` name — and after it the actual result. Rollback steps are recorded the
//! same way (`rollingBack`). Each op and each rollback step is all-or-nothing: when a step and
//! its own revert both fail, the record says `partial` and names where each file is, and the
//! backup becomes `incomplete` so `plan_undo` can recover it from the actual locations.
//!
//! Nothing is ever deleted: a removed or replaced jar is moved into the snapshot's `files/`, a
//! file a fix created is moved into `created/` when it is rolled back or undone. The only files
//! this module removes are its own temporary `.part` downloads. A move from the snapshot into
//! the instance that has to copy across volumes writes its temporary copy under a name recorded
//! ahead in the op's record (`temps`), so a copy left by a crash is found and moved away.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::model::{BackupEntry, BackupStatus, FileOp, GameStatus, OpState, OpStatus, WorkOrderResult};
use crate::state::AppState;

use super::fsops::{self, existing, is_absent, move_file, move_file_named, new_path};
use super::manifest::{self, FileChange, Manifest, OpRecord, RecState, TempFile, UndoSession};
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
    {
        // Leftovers of an interrupted earlier order go into its snapshot first (we hold the
        // claim, so no other order of this instance runs), then this order's backup is bound to
        // the claim, so later recovery passes leave its manifest alone. Both under the recovery
        // lock, so no pass is halfway through that manifest when this order opens it.
        let _recovery = st.fixes.recovery_lock();
        if let Ok(root) = st.fixes.backups_root() {
            let busy = st.fixes.busy_backups();
            super::recover::recover_instance(&st.guard, &root, &instance_id, Some(&game_dir), &busy);
        }
        _exec.bind(&stored.backup_id);
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

    fn save(&mut self, guard: &PathGuard) -> Result<()> {
        self.manifest.entry.status = self.manifest.derive_status();
        manifest::save(guard, &self.dir, &self.manifest)
    }

    /// Record `rec` as op `i` and save it durably (write-ahead or result).
    fn put(&mut self, guard: &PathGuard, i: usize, rec: &OpRecord) -> Result<()> {
        self.records()[i] = rec.clone();
        self.save(guard)
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
                    status: BackupStatus::Incomplete,
                },
                order_id: o.order.id.clone(),
                game_dir: o.game_dir.display().to_string(),
                records,
                rolled_back: false,
                finished: false,
                undo_log: Vec::new(),
                interrupted: false,
            };
            let mut j = Journal { manifest, session: None, dir: dir.clone() };
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
            if undo.recovery != (m.entry.status == BackupStatus::Incomplete) {
                return Err(Error::Conflict("This backup changed since the undo was reviewed. Review the undo again.".into()));
            }
            m.undo_log.push(UndoSession {
                order_id: o.order.id.clone(),
                started_at_ms: fsops::now_ms(),
                action_indexes: undo.original_actions.clone(),
                ops: o.order.ops.clone(),
                records,
                rolled_back: false,
                finished: false,
                recovery: undo.recovery,
                interrupted: false,
                reapplied: undo.reapplied.clone(),
                left_in_place: undo.left_in_place.clone(),
            });
            let session = Some(m.undo_log.len() - 1);
            let mut j = Journal { manifest: m, session, dir };
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
    /// destination's parent folders inside the snapshot when needed. Never replaces anything.
    /// From the snapshot into the instance, a cross-volume copy uses the temporary name `rec`
    /// recorded ahead for that destination (and the move is refused without one).
    fn mv(&self, rec: &OpRecord, from: (Loc, &str), to: (Loc, &str)) -> Result<()> {
        let src = existing(self.guard, self.base(from.0), from.1)?;
        if to.0 == Loc::Snapshot {
            fsops::ensure_parent(self.guard, self.snap, to.1)?;
        }
        let dst = new_path(self.guard, self.base(to.0), to.1)?;
        if from.0 == Loc::Snapshot && to.0 == Loc::Game {
            let temp = rec
                .temp_for(to.1)
                .ok_or_else(|| Error::Internal(format!("no temporary copy name was recorded for {}", to.1)))?;
            let temp = new_path(self.guard, self.game, &temp)?;
            return move_file_named(&src, &dst, &temp);
        }
        move_file(&src, &dst)
    }

    fn shown(&self, loc: Loc, rel: &str) -> String {
        match loc {
            Loc::Game => rel.to_string(),
            Loc::Snapshot => self.snap.join(rel).display().to_string(),
        }
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

/// The game paths a file can be moved to from the snapshot by this op or by its rollback (each
/// gets a recorded temporary copy name for a cross-volume move).
fn snapshot_to_game(op: &FileOp) -> Vec<&str> {
    match op {
        FileOp::Rename { .. } => Vec::new(),
        FileOp::MoveToBackup { path } | FileOp::RemoveCreated { path, .. } => vec![path.as_str()],
        FileOp::Download { dest, replaces, .. } => {
            // A case-only replace moves the old jar back to its own spelling: both get a name.
            let mut v = vec![dest.as_str()];
            if let Some(r) = replaces {
                if r != dest {
                    v.push(r.as_str());
                }
            }
            v
        }
        FileOp::Restore { to, .. } => vec![to.as_str()],
    }
}

/// The record of an op about to run: every intended move with its hashes, the `.part` name, the
/// `created/` name and the temporary copy names, all known before anything is touched
/// (write-ahead).
fn intent(cx: &Cx, op: &FileOp, plan: &OpPlan, rec: &mut OpRecord) -> Result<()> {
    rec.state = RecState::Running;
    rec.message = None;
    rec.temps = snapshot_to_game(op).into_iter().map(|to| TempFile { path: manifest::temp_name(to), backup: None }).collect();
    rec.files = match op {
        FileOp::Rename { from, to } => {
            let sha = planned_sha(plan, Loc::Game, from).ok_or_else(|| missing_sha(from))?;
            vec![
                FileChange { path: from.clone(), before: Some(sha.clone()), after: None, backup_path: None },
                FileChange { path: to.clone(), before: None, after: Some(sha), backup_path: None },
            ]
        }
        FileOp::MoveToBackup { path } => {
            let sha = planned_sha(plan, Loc::Game, path).ok_or_else(|| missing_sha(path))?;
            vec![FileChange { path: path.clone(), before: Some(sha), after: None, backup_path: Some(format!("files/{path}")) }]
        }
        FileOp::Download { dest, replaces, .. } => {
            let name = fsops::file_name_of(dest);
            rec.part = Some(format!("mods/.{name}.{}.part", fsops::random_hex(1)));
            match replaces {
                Some(r) => {
                    let sha = planned_sha(plan, Loc::Game, r).ok_or_else(|| missing_sha(r))?;
                    let backup = Some(format!("files/{r}"));
                    if fsops::fold(r) == fsops::fold(dest) {
                        vec![FileChange { path: dest.clone(), before: Some(sha), after: None, backup_path: backup }]
                    } else {
                        vec![
                            FileChange { path: r.clone(), before: Some(sha), after: None, backup_path: backup },
                            FileChange { path: dest.clone(), before: None, after: None, backup_path: None },
                        ]
                    }
                }
                None => vec![FileChange { path: dest.clone(), before: None, after: None, backup_path: None }],
            }
        }
        FileOp::Restore { backup_path, to, expect_absent_or_sha1 } => {
            if expect_absent_or_sha1.is_some() {
                return Err(Error::Internal("restoring over an existing file is not supported".into()));
            }
            let sha = planned_sha(plan, Loc::Snapshot, backup_path).ok_or_else(|| missing_sha(backup_path))?;
            vec![FileChange { path: to.clone(), before: None, after: Some(sha), backup_path: Some(backup_path.clone()) }]
        }
        FileOp::RemoveCreated { path, expect_sha1 } => {
            let created = fsops::unique_rel(cx.snap, &format!("created/{path}"))?;
            rec.created_backup = Some(created.clone());
            vec![FileChange { path: path.clone(), before: Some(expect_sha1.clone()), after: None, backup_path: Some(created) }]
        }
    };
    Ok(())
}

/// What an op that failed left behind.
enum Fail {
    /// Nothing of the op is in place.
    Clean(Error),
    /// A step and its own revert both failed; the record names where the files are.
    Partial(Error),
}

impl From<Error> for Fail {
    fn from(e: Error) -> Self {
        Fail::Clean(e)
    }
}

/// Run one op (preconditions verified, intent saved). `Err(Fail::Clean)` = nothing applied.
fn run_op(cx: &Cx, j: &mut Journal, i: usize, op: &FileOp, plan: &OpPlan, rec: &mut OpRecord) -> std::result::Result<(), Fail> {
    match op {
        FileOp::Rename { from, to } => Ok(cx.mv(rec, (Loc::Game, from), (Loc::Game, to))?),
        FileOp::MoveToBackup { path } => Ok(cx.mv(rec, (Loc::Game, path), (Loc::Snapshot, &format!("files/{path}")))?),
        FileOp::Download { url, sha512, size_bytes, dest, replaces, .. } => {
            download(cx, j, i, plan, rec, url, sha512, *size_bytes, dest, replaces.as_deref())
        }
        FileOp::Restore { backup_path, to, .. } => Ok(cx.mv(rec, (Loc::Snapshot, backup_path), (Loc::Game, to))?),
        FileOp::RemoveCreated { path, .. } => {
            let created = rec.created_backup.clone().ok_or_else(|| missing_sha(path))?;
            Ok(cx.mv(rec, (Loc::Game, path), (Loc::Snapshot, &created))?)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn download(
    cx: &Cx,
    j: &mut Journal,
    i: usize,
    plan: &OpPlan,
    rec: &mut OpRecord,
    url: &str,
    sha512: &str,
    size: u64,
    dest: &str,
    replaces: Option<&str>,
) -> std::result::Result<(), Fail> {
    let remote = cx.remote.ok_or(Error::Offline)?;
    let mods = cx.guard.check_existing(&cx.game.join("mods"))?;
    let part_rel = rec.part.clone().ok_or_else(|| missing_sha(dest))?;
    // `mods/.<temp_name>.part`: the client adds the dot and the suffix.
    let temp_name = part_rel
        .strip_prefix("mods/.")
        .and_then(|n| n.strip_suffix(".part"))
        .ok_or_else(|| Error::Internal("the temporary download name is malformed".into()))?
        .to_string();
    let part = remote.download(url, sha512, size, &mods, &temp_name)?;
    let expected_part = mods.join(format!(".{temp_name}.part"));
    // Only ever our own temp file (the client creates it with `create_new`).
    let drop_part = || {
        if !is_absent(&expected_part) {
            let _ = fs::remove_file(&expected_part);
        }
    };
    if part != expected_part {
        return Err(Fail::Clean(Error::Internal("the download landed in an unexpected place".into())));
    }
    let dest_name = fsops::file_name_of(dest);
    let checked = (|| {
        let bytes = fs::read(&part).map_err(|e| Error::io(&part, e))?;
        let new_sha = fsops::sha1_bytes(&bytes);
        let ids = super::plan::jar_mod_ids(&bytes, dest);
        // Case-insensitive, like planning (`InstallDependency` requirements and `provides`).
        if !plan.expect_mod_ids.iter().any(|want| ids.iter().any(|id| id.eq_ignore_ascii_case(want))) {
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
    let new_sha = match checked {
        Ok(v) => v,
        Err(e) => {
            drop_part();
            return Err(Fail::Clean(e));
        }
    };
    // Write-ahead: the new jar's sha1, before it can reach `dest`.
    if let Some(f) = rec.files.iter_mut().find(|f| fsops::fold(&f.path) == fsops::fold(dest)) {
        f.after = Some(new_sha.clone());
    }
    if let Err(e) = j.put(cx.guard, i, rec) {
        drop_part();
        return Err(Fail::Clean(e));
    }

    // Move the replaced jar into the snapshot (re-checked right before).
    if let Some(r) = replaces {
        let step = (|| {
            let check = plan.checks.iter().find(|c| c.loc == Loc::Game && c.rel == r).cloned().ok_or_else(|| missing_sha(r))?;
            cx.verify(&check)?;
            cx.mv(rec, (Loc::Game, r), (Loc::Snapshot, &format!("files/{r}")))
        })();
        if let Err(e) = step {
            drop_part();
            return Err(Fail::Clean(e));
        }
    }

    // Into place: an atomic no-replace rename in the same folder.
    let placed = new_path(cx.guard, cx.game, dest).and_then(|dst| move_file(&part, &dst));
    if let Err(e) = placed {
        drop_part();
        let Some(r) = replaces else { return Err(Fail::Clean(e)) };
        let backup = format!("files/{r}");
        return match cx.mv(rec, (Loc::Snapshot, &backup), (Loc::Game, r)) {
            Ok(()) => Err(Fail::Clean(e)),
            Err(back) => {
                // The old jar stays in the snapshot (recorded in `files`), the new one was not
                // placed (its `.part` was removed).
                for f in &mut rec.files {
                    f.after = None;
                }
                Err(Fail::Partial(Error::Conflict(format!(
                    "{e} Moving {r} back also failed ({back}); it is in the backup at {}.",
                    cx.snap.join(&backup).display()
                ))))
            }
        };
    }
    Ok(())
}

/// What a rollback step left behind.
enum Back {
    /// Fully reverted.
    Reverted,
    /// Not reverted, and still fully applied (consistent).
    StillApplied(Error),
    /// Neither (a step and its own revert failed); the record names where the files are.
    Partial(Error),
}

/// Reverse one completed op (automatic rollback). All-or-nothing per op.
fn rollback_op(cx: &Cx, op: &FileOp, rec: &mut OpRecord) -> Back {
    let one = |r: Result<()>| match r {
        Ok(()) => Back::Reverted,
        Err(e) => Back::StillApplied(e),
    };
    // The record as written ahead of this step (its temporary copy names).
    let ahead = rec.clone();
    match op {
        FileOp::Rename { from, to } => one(cx.mv(&ahead, (Loc::Game, to), (Loc::Game, from))),
        FileOp::MoveToBackup { path } => one(cx.mv(&ahead, (Loc::Snapshot, &format!("files/{path}")), (Loc::Game, path))),
        FileOp::Download { dest, replaces, .. } => {
            let Some(created) = rec.created_backup.clone() else {
                return Back::StillApplied(missing_sha(dest));
            };
            if let Err(e) = cx.mv(&ahead, (Loc::Game, dest), (Loc::Snapshot, &created)) {
                rec.created_backup = None;
                return Back::StillApplied(e);
            }
            let Some(r) = replaces else { return Back::Reverted };
            let backup = format!("files/{r}");
            match cx.mv(&ahead, (Loc::Snapshot, &backup), (Loc::Game, r)) {
                Ok(()) => Back::Reverted,
                // Keep the order consistently applied: the new jar goes back to `dest`.
                Err(e) => match cx.mv(&ahead, (Loc::Snapshot, &created), (Loc::Game, dest)) {
                    Ok(()) => {
                        rec.created_backup = None;
                        Back::StillApplied(e)
                    }
                    Err(again) => Back::Partial(Error::Conflict(format!(
                        "{e} Putting {dest} back also failed ({again}); the old jar is at {} and the new one at {}.",
                        cx.shown(Loc::Snapshot, &backup),
                        cx.shown(Loc::Snapshot, &created)
                    ))),
                },
            }
        }
        FileOp::Restore { backup_path, to, .. } => one(cx.mv(&ahead, (Loc::Game, to), (Loc::Snapshot, backup_path))),
        FileOp::RemoveCreated { path, .. } => match rec.created_backup.clone() {
            Some(created) => one(cx.mv(&ahead, (Loc::Snapshot, &created), (Loc::Game, path))),
            None => Back::StillApplied(missing_sha(path)),
        },
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
    let snap = journal.dir.clone();
    let cx = Cx { guard, game: &o.game_dir, snap: &snap, remote: env.remote };
    let n = o.order.ops.len();
    let mut statuses: Vec<OpStatus> = (0..n).map(|i| status(id, i, OpState::Pending, None)).collect();
    let mut failed_at: Option<usize> = None;

    for i in 0..n {
        let op = &o.order.ops[i].op;
        let plan = &o.plans[i];
        statuses[i] = status(id, i, OpState::Running, None);
        (env.emit)(statuses[i].clone());

        let mut rec = journal.records()[i].clone();
        // Preconditions (read-only), then the write-ahead record, then the op.
        let prepared = cx.verify_all(plan).and_then(|()| intent(&cx, op, plan, &mut rec));
        let outcome = match prepared {
            Err(e) => Err(Fail::Clean(e)),
            Ok(()) => match journal.put(guard, i, &rec) {
                Err(e) => Err(Fail::Clean(Error::Internal(format!(
                    "the backup record could not be saved ({e}), so nothing was changed and the fixes were stopped"
                )))),
                Ok(()) => run_op(&cx, &mut journal, i, op, plan, &mut rec),
            },
        };
        match outcome {
            Ok(()) => {
                rec.state = RecState::Done;
                statuses[i] = status(id, i, OpState::Done, None);
            }
            Err(Fail::Clean(e)) => {
                rec.state = RecState::Failed;
                rec.message = Some(e.to_string());
                statuses[i] = status(id, i, OpState::Failed, Some(e.to_string()));
                failed_at = Some(i);
            }
            Err(Fail::Partial(e)) => {
                let msg = format!("{e} The backup in {} is kept so this can be recovered with Undo.", journal.dir.display());
                rec.state = RecState::Partial;
                rec.message = Some(msg.clone());
                statuses[i] = status(id, i, OpState::Failed, Some(msg));
                failed_at = Some(i);
            }
        }
        if let Err(e) = journal.put(guard, i, &rec) {
            // The op may be applied but its result is not recorded: stop and roll it back.
            let msg = format!("The backup record could not be saved ({e}), so the fixes were stopped.");
            statuses[i] = status(id, i, OpState::Failed, Some(msg.clone()));
            journal.records()[i].message = Some(msg);
            failed_at.get_or_insert(i);
        }
        if failed_at.is_some() {
            if journal.records()[i].state != RecState::Done {
                (env.emit)(statuses[i].clone());
            }
            // A `done` op is reported after its rollback below.
            break;
        }
        (env.emit)(statuses[i].clone());
    }

    if let Some(fail) = failed_at {
        for k in fail + 1..n {
            journal.records()[k].state = RecState::Skipped;
            statuses[k] = status(id, k, OpState::Skipped, Some("Not started because an earlier step failed.".into()));
            (env.emit)(statuses[k].clone());
        }
        if let Err(e) = journal.save(guard) {
            eprintln!("fixes: could not update the backup manifest in {}: {e}", journal.dir.display());
        }
        for k in (0..=fail).rev() {
            if journal.records()[k].state != RecState::Done {
                continue;
            }
            let op = &o.order.ops[k].op;
            let mut rec = journal.records()[k].clone();
            // Write-ahead for the rollback step, including where a created file will go.
            rec.state = RecState::RollingBack;
            let named = match op {
                FileOp::Download { dest, .. } => fsops::unique_rel(cx.snap, &format!("created/{dest}")).map(|c| rec.created_backup = Some(c)),
                _ => Ok(()),
            };
            let back = match named.and_then(|()| journal.put(guard, k, &rec)) {
                // Not recorded: do not touch anything; the op stays applied.
                Err(e) => Back::StillApplied(e),
                Ok(()) => rollback_op(&cx, op, &mut rec),
            };
            match back {
                Back::Reverted => {
                    rec.state = RecState::RolledBack;
                    if k == fail {
                        let msg = statuses[k].message.clone().unwrap_or_default();
                        statuses[k] = status(id, k, OpState::Failed, Some(format!("{msg} This step was rolled back.")));
                    } else {
                        statuses[k] = status(id, k, OpState::Skipped, Some(format!("Rolled back because step {} failed.", fail + 1)));
                    }
                }
                Back::StillApplied(e) => {
                    let msg = format!(
                        "Done, but the automatic rollback failed: {e} The backup in {} is kept so this can still be undone.",
                        journal.dir.display()
                    );
                    rec.state = RecState::RollbackFailed;
                    rec.message = Some(msg.clone());
                    statuses[k] = status(id, k, OpState::Failed, Some(msg));
                }
                Back::Partial(e) => {
                    let msg = format!(
                        "The automatic rollback failed halfway: {e} The backup in {} is kept so this can be recovered with Undo.",
                        journal.dir.display()
                    );
                    rec.state = RecState::Partial;
                    rec.message = Some(msg.clone());
                    statuses[k] = status(id, k, OpState::Failed, Some(msg));
                }
            }
            if let Err(e) = journal.put(guard, k, &rec) {
                eprintln!("fixes: could not update the backup manifest in {}: {e}", journal.dir.display());
            }
            (env.emit)(statuses[k].clone());
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
                // A recovery that reverted an interrupted undo leaves those actions applied.
                let reapplied = session.reapplied.clone();
                let done: Vec<u32> = session.action_indexes.iter().copied().filter(|a| !reapplied.contains(a)).collect();
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
