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
//! **Recovery.** For an `incomplete` backup (interrupted, or a rollback broke) the records no
//! longer say where each file is, so the plan comes from the *actual* locations instead
//! ([`plan_recovery`]): every file an op touched is looked for, by its recorded sha1, at every
//! place the op could have left it, and moved back to where it was before the order. A file the
//! order created that changed since (the user edited it) is left in place with a note, and the
//! backup stays `incomplete` after the recovery.
//!
//! When only an undo of a completed order broke (interrupted, or its rollback failed), recovery
//! is limited to that undo's actions and never touches the others: it reverts the undo (every
//! file back where the fixes had put it, [`plan_reapply`]) when the files allow it, else it
//! finishes the undo (those actions back to their pre-order state).
//!
//! Undo orders work inside the original snapshot: `Restore` moves files back out of `files/`,
//! `RemoveCreated` moves the created file into `created/`. On success the original manifest's
//! `undoneActions` gains the undone actions.

use std::collections::HashSet;
use std::path::Path;
use std::time::Instant;

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::model::{BackupStatus, FileOp, FixAction, PlannedOp, WorkOrder, WorkOrderKind};
use crate::state::AppState;

use super::fsops::{self, Stamp};
use super::manifest::{self, FileChange, Manifest, OpRecord};
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

/// What is at one place right now.
enum Here {
    Absent,
    File(Stamp),
    /// A folder, a link to one, or something unreadable.
    Other,
}

impl Ctx<'_> {
    fn refuse(&self, msg: impl std::fmt::Display) -> Error {
        Error::Invalid(format!("{}: {msg}", self.label))
    }

    fn base(&self, loc: Loc) -> &Path {
        match loc {
            Loc::Game => self.game,
            Loc::Snapshot => self.snap,
        }
    }

    /// The current file at `rel` must exist with `sha`; returns its fingerprint.
    fn expect_file(&self, loc: Loc, rel: &str, sha: &str) -> Result<Stamp> {
        let shown = match loc {
            Loc::Game => rel.to_string(),
            Loc::Snapshot => format!("the backup copy {rel}"),
        };
        let path = match fsops::existing(self.guard, self.base(loc), rel) {
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

    /// Look at one place (through the guard). Errors other than "outside the roots" become
    /// `Other` (refuse rather than guess).
    fn here(&self, loc: Loc, rel: &str) -> Result<Here> {
        let joined = PathGuard::join_relative(self.base(loc), rel)?;
        if fsops::is_absent(&joined) {
            return Ok(Here::Absent);
        }
        let path = fsops::existing(self.guard, self.base(loc), rel)?;
        match std::fs::metadata(&path) {
            Ok(m) if m.is_file() => Ok(fsops::stamp(&path).map_or(Here::Other, Here::File)),
            _ => Ok(Here::Other),
        }
    }
}

/// The recorded change at `rel`, compared with the case folding used everywhere else (a
/// case-only `Replace` records `dest` once, which is also the replaced jar's path).
fn change_at<'a>(files: &'a [FileChange], rel: &str) -> Option<&'a FileChange> {
    let key = fsops::fold(rel);
    files.iter().find(|f| fsops::fold(&f.path) == key)
}

fn corrupt(snap: &Path) -> Error {
    Error::Corrupt { path: snap.join(manifest::MANIFEST).display().to_string(), reason: "an op record lacks its file hashes".into() }
}

/// Reverse ops (with preconditions) of one applied fix op.
fn reverse(cx: &Ctx, op: &FileOp, files: &[FileChange], out: &mut Vec<(FileOp, OpPlan)>) -> Result<()> {
    match op {
        FileOp::Rename { from, to } => {
            let sha = change_at(files, to).and_then(|f| f.after.clone()).ok_or_else(|| corrupt(cx.snap))?;
            let st = cx.expect_file(Loc::Game, to, &sha)?;
            cx.expect_absent(from)?;
            let checks = vec![
                Check { loc: Loc::Game, rel: to.clone(), expect: Expect::File(st) },
                Check { loc: Loc::Game, rel: from.clone(), expect: Expect::Absent },
            ];
            out.push((FileOp::Rename { from: to.clone(), to: from.clone() }, OpPlan { checks, expect_mod_ids: Vec::new() }));
        }
        FileOp::MoveToBackup { path } => {
            let f = change_at(files, path).ok_or_else(|| corrupt(cx.snap))?;
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
            let created = change_at(files, dest).and_then(|f| f.after.clone()).ok_or_else(|| corrupt(cx.snap))?;
            let st = cx.expect_file(Loc::Game, dest, &created)?;
            let checks = vec![Check { loc: Loc::Game, rel: dest.clone(), expect: Expect::File(st) }];
            out.push((FileOp::RemoveCreated { path: dest.clone(), expect_sha1: created }, OpPlan { checks, expect_mod_ids: Vec::new() }));
            if let Some(r) = replaces {
                let f = change_at(files, r).ok_or_else(|| corrupt(cx.snap))?;
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

// ── Recovery of an incomplete backup ─────────────────────────────────────────

/// A file that was in the instance before the order: its pre-order path, its sha1, and every
/// other place the order (or a rollback / undo of it) can have moved it to.
struct Original {
    home: String,
    sha1: String,
    elsewhere: Vec<(Loc, String)>,
}

/// What one op may have changed, from its record (written ahead of the op).
struct Touched {
    originals: Vec<Original>,
    /// A file the op created at this game path, with its sha1 when it was known.
    created: Option<(String, Option<String>)>,
    /// The op's temporary download, if still in the instance.
    part: Option<String>,
}

fn touched(snap: &Path, op: &FileOp, rec: &OpRecord) -> Result<Touched> {
    let before = |rel: &str| change_at(&rec.files, rel).and_then(|f| f.before.clone()).ok_or_else(|| corrupt(snap));
    let backup_of = |rel: &str| change_at(&rec.files, rel).and_then(|f| f.backup_path.clone()).unwrap_or_else(|| format!("files/{rel}"));
    let part = if rec.part_backup.is_none() { rec.part.clone() } else { None };
    Ok(match op {
        FileOp::Rename { from, to } => Touched {
            originals: vec![Original { home: from.clone(), sha1: before(from)?, elsewhere: vec![(Loc::Game, to.clone())] }],
            created: None,
            part: None,
        },
        FileOp::MoveToBackup { path } => Touched {
            originals: vec![Original { home: path.clone(), sha1: before(path)?, elsewhere: vec![(Loc::Snapshot, backup_of(path))] }],
            created: None,
            part: None,
        },
        FileOp::Download { dest, replaces, .. } => {
            let mut originals = Vec::new();
            if let Some(r) = replaces {
                originals.push(Original { home: r.clone(), sha1: before(r)?, elsewhere: vec![(Loc::Snapshot, backup_of(r))] });
            }
            let new_sha = change_at(&rec.files, dest).and_then(|f| f.after.clone());
            Touched { originals, created: Some((dest.clone(), new_sha)), part }
        }
        FileOp::Restore { .. } | FileOp::RemoveCreated { .. } => return Err(corrupt(snap)),
    })
}

/// A planned recovery: its ops, and the created files it leaves in place (changed since).
struct Recovery {
    ops: Vec<(u32, FileOp, OpPlan)>,
    left_in_place: Vec<String>,
    notes: Vec<String>,
}

/// Recovery ops for the selected actions: first every created file (and leftover `.part`) still
/// in the instance goes into the snapshot's `created/`, then every original file that is not at
/// its pre-order path is moved back there from wherever it is now (found by sha1). A file that
/// is nowhere to be found, or a pre-order path now taken by something else, refuses the plan. A
/// created file that changed since is left in place, named in a note and in `left_in_place`.
fn plan_recovery(st: &AppState, game: &Path, snap: &Path, m: &Manifest, selected: &[u32]) -> Result<Recovery> {
    let mut out_created: Vec<(u32, FileOp, OpPlan)> = Vec::new();
    let mut out_back: Vec<(u32, FileOp, OpPlan)> = Vec::new();
    let mut leaving: HashSet<String> = HashSet::new();
    let mut pending: Vec<(u32, String, Original)> = Vec::new();
    let mut left_in_place: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    for (op, rec) in m.entry.ops.iter().zip(&m.records).rev() {
        let Some(pos) = selected.iter().position(|i| *i == op.action_index) else { continue };
        let pos = u32::try_from(pos).unwrap_or(u32::MAX);
        if rec.state.clean() {
            continue; // never started, or certainly reverted: nothing of it is in place
        }
        let label = format!("Recover {}", decapitalize(&action_label(&m.entry.actions[op.action_index as usize])));
        let cx = Ctx { guard: &st.guard, game, snap, label: label.clone() };
        let t = touched(snap, &op.op, rec)?;
        // Created files still in the instance → `created/`. One that changed since the crash
        // (not the created file, nor an original of this op at its home) stays where it is.
        if let Some((dest, Some(sha))) = &t.created {
            let here = cx.here(Loc::Game, dest)?;
            let is_original = |s: &Stamp| t.originals.iter().any(|o| fsops::fold(&o.home) == fsops::fold(dest) && o.sha1 == s.sha1);
            match here {
                Here::Absent => {}
                Here::File(stamp) if stamp.sha1 == *sha => {
                    leaving.insert(fsops::fold(dest));
                    let checks = vec![Check { loc: Loc::Game, rel: dest.clone(), expect: Expect::File(stamp) }];
                    out_created.push((pos, FileOp::RemoveCreated { path: dest.clone(), expect_sha1: sha.clone() }, OpPlan { checks, expect_mod_ids: Vec::new() }));
                }
                Here::File(stamp) if is_original(&stamp) => {}
                Here::File(_) | Here::Other => {
                    let restored = t.originals.iter().map(|o| o.home.as_str()).find(|h| fsops::fold(h) != fsops::fold(dest));
                    notes.push(match restored {
                        Some(r) => format!("{dest} was changed since the crash and was left in place; it may duplicate {r}."),
                        None => format!("{dest} was changed since the crash and was left in place."),
                    });
                    left_in_place.push(dest.clone());
                }
            }
        }
        if let Some(part) = &t.part {
            match cx.here(Loc::Game, part)? {
                Here::Absent => {}
                Here::File(stamp) => {
                    let sha = stamp.sha1.clone();
                    let checks = vec![Check { loc: Loc::Game, rel: part.clone(), expect: Expect::File(stamp) }];
                    out_created.push((pos, FileOp::RemoveCreated { path: part.clone(), expect_sha1: sha }, OpPlan { checks, expect_mod_ids: Vec::new() }));
                }
                Here::Other => return Err(cx.refuse(format!("{part} is not a regular file, so it is left alone"))),
            }
        }
        for o in t.originals {
            pending.push((pos, label.clone(), o));
        }
    }
    for (pos, label, o) in pending {
        let cx = Ctx { guard: &st.guard, game, snap, label };
        let at_home = cx.here(Loc::Game, &o.home)?;
        if matches!(&at_home, Here::File(s) if s.sha1 == o.sha1) {
            continue; // already where it was before the order
        }
        let mut found = None;
        for (loc, rel) in &o.elsewhere {
            if let Here::File(s) = cx.here(*loc, rel)? {
                if s.sha1 == o.sha1 {
                    found = Some((*loc, rel.clone(), s));
                    break;
                }
            }
        }
        let Some((loc, rel, stamp)) = found else {
            return Err(cx.refuse(format!(
                "{} is neither at its place nor in the backup with the content it had before the fixes (it was changed or removed since), so it cannot be recovered safely",
                o.home
            )));
        };
        let home_free = matches!(at_home, Here::Absent) || leaving.contains(&fsops::fold(&o.home));
        if !home_free {
            return Err(cx.refuse(format!("{} exists and is never overwritten; move it away first, then recover again", o.home)));
        }
        let checks = vec![
            Check { loc, rel: rel.clone(), expect: Expect::File(stamp) },
            Check { loc: Loc::Game, rel: o.home.clone(), expect: Expect::Absent },
        ];
        let op = match loc {
            Loc::Game => FileOp::Rename { from: rel, to: o.home },
            Loc::Snapshot => FileOp::Restore { backup_path: rel, to: o.home, expect_absent_or_sha1: None },
        };
        out_back.push((pos, op, OpPlan { checks, expect_mod_ids: Vec::new() }));
    }
    out_created.extend(out_back);
    Ok(Recovery { ops: out_created, left_in_place, notes })
}

/// A file in the state right after the fixes: its sha1, where the fixes put it, and every other
/// place an undo (or a recovery) of it can have moved it to.
struct Applied {
    sha1: String,
    at: (Loc, String),
    elsewhere: Vec<(Loc, String)>,
}

/// The applied state of one completed fix op, from its record.
fn applied_files(m: &Manifest, snap: &Path, op: &FileOp, rec: &OpRecord) -> Result<Vec<Applied>> {
    let ch = |rel: &str| change_at(&rec.files, rel).ok_or_else(|| corrupt(snap));
    let backup = |rel: &str| -> Result<(String, String)> {
        let f = ch(rel)?;
        match (f.backup_path.clone(), f.before.clone()) {
            (Some(b), Some(s)) => Ok((b, s)),
            _ => Err(corrupt(snap)),
        }
    };
    Ok(match op {
        FileOp::Rename { from, to } => {
            let sha = ch(to)?.after.clone().ok_or_else(|| corrupt(snap))?;
            vec![Applied { sha1: sha, at: (Loc::Game, to.clone()), elsewhere: vec![(Loc::Game, from.clone())] }]
        }
        FileOp::MoveToBackup { path } => {
            let (b, sha) = backup(path)?;
            vec![Applied { sha1: sha, at: (Loc::Snapshot, b), elsewhere: vec![(Loc::Game, path.clone())] }]
        }
        FileOp::Download { dest, replaces, .. } => {
            let mut out = Vec::new();
            if let Some(r) = replaces {
                let (b, sha) = backup(r)?;
                out.push(Applied { sha1: sha, at: (Loc::Snapshot, b), elsewhere: vec![(Loc::Game, r.clone())] });
            }
            let sha = ch(dest)?.after.clone().ok_or_else(|| corrupt(snap))?;
            // Where undos (and their recoveries) moved the created jar inside the snapshot.
            let key = fsops::fold(dest);
            let mut created: Vec<(Loc, String)> = Vec::new();
            for s in &m.undo_log {
                for (uop, urec) in s.ops.iter().zip(&s.records) {
                    if matches!(&uop.op, FileOp::RemoveCreated { path, .. } if fsops::fold(path) == key) {
                        if let Some(c) = &urec.created_backup {
                            if !created.iter().any(|(_, x)| x == c) {
                                created.push((Loc::Snapshot, c.clone()));
                            }
                        }
                    }
                }
            }
            out.push(Applied { sha1: sha, at: (Loc::Game, dest.clone()), elsewhere: created });
            out
        }
        FileOp::Restore { .. } | FileOp::RemoveCreated { .. } => return Err(corrupt(snap)),
    })
}

/// Reverting an interrupted undo of completed fixes: every file of the selected actions goes
/// back to where the fixes had put it (found by sha1 at its applied place, or where the undo can
/// have moved it). Files leave the instance first, then renames, then files come back from the
/// snapshot. A file that is nowhere to be found, or a place taken by something else, refuses.
fn plan_reapply(st: &AppState, game: &Path, snap: &Path, m: &Manifest, selected: &[u32]) -> Result<Vec<(u32, FileOp, OpPlan)>> {
    /// One file to move back: phase 0 = into the snapshot, 1 = a rename, 2 = out of it.
    struct Move {
        phase: u8,
        pos: u32,
        loc: Loc,
        rel: String,
        stamp: Stamp,
        at: (Loc, String),
        label: String,
    }
    let mut moves: Vec<Move> = Vec::new();
    for (op, rec) in m.entry.ops.iter().zip(&m.records) {
        let Some(pos) = selected.iter().position(|i| *i == op.action_index) else { continue };
        let pos = u32::try_from(pos).unwrap_or(u32::MAX);
        let label = format!("Recover {}", decapitalize(&action_label(&m.entry.actions[op.action_index as usize])));
        let cx = Ctx { guard: &st.guard, game, snap, label: label.clone() };
        if !rec.state.applied() {
            return Err(cx.refuse("the fix did not complete, so it cannot be put back"));
        }
        for a in applied_files(m, snap, &op.op, rec)? {
            if matches!(cx.here(a.at.0, &a.at.1)?, Here::File(s) if s.sha1 == a.sha1) {
                continue; // already where the fixes put it
            }
            let mut found = None;
            for (loc, rel) in &a.elsewhere {
                if let Here::File(s) = cx.here(*loc, rel)? {
                    if s.sha1 == a.sha1 {
                        found = Some((*loc, rel.clone(), s));
                        break;
                    }
                }
            }
            let Some((loc, rel, stamp)) = found else {
                let shown = match a.at.0 {
                    Loc::Game => a.at.1.clone(),
                    Loc::Snapshot => format!("the backup copy {}", a.at.1),
                };
                return Err(cx.refuse(format!(
                    "{shown} is neither where the fixes put it nor where the undo moved it, with the content it had (it was changed or removed since)"
                )));
            };
            let phase = match (loc, a.at.0) {
                (Loc::Game, Loc::Snapshot) => 0,
                (Loc::Game, Loc::Game) => 1,
                (Loc::Snapshot, Loc::Game) => 2,
                (Loc::Snapshot, Loc::Snapshot) => return Err(corrupt(snap)),
            };
            moves.push(Move { phase, pos, loc, rel, stamp, at: a.at, label: label.clone() });
        }
    }
    moves.sort_by_key(|m| m.phase);
    let mut leaving: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for Move { phase, pos, loc, rel, stamp, at, label } in moves {
        let cx = Ctx { guard: &st.guard, game, snap, label };
        let (to_loc, to) = at;
        match cx.here(to_loc, &to)? {
            Here::Absent => {}
            _ if to_loc == Loc::Game && leaving.contains(&fsops::fold(&to)) => {}
            _ => {
                let shown = if to_loc == Loc::Game { to.clone() } else { format!("the backup copy {to}") };
                return Err(cx.refuse(format!("{shown} exists and is never overwritten; move it away first, then recover again")));
            }
        }
        if loc == Loc::Game {
            leaving.insert(fsops::fold(&rel));
        }
        let checks = vec![Check { loc, rel: rel.clone(), expect: Expect::File(stamp) }, Check { loc: to_loc, rel: to.clone(), expect: Expect::Absent }];
        let op = match phase {
            0 => {
                // `MoveToBackup` always moves to `files/<path>`.
                if to != format!("files/{rel}") {
                    return Err(corrupt(snap));
                }
                FileOp::MoveToBackup { path: rel }
            }
            1 => FileOp::Rename { from: rel, to },
            _ => FileOp::Restore { backup_path: rel, to, expect_absent_or_sha1: None },
        };
        out.push((pos, op, OpPlan { checks, expect_mod_ids: Vec::new() }));
    }
    Ok(out)
}

/// The actions to undo: the requested ones (each must be applied and not undone yet), or all
/// applied, not yet undone actions.
fn select(m: &Manifest, requested: Option<Vec<u32>>) -> Result<Vec<u32>> {
    let applied = |i: u32| {
        let recs: Vec<_> = m.records.iter().filter(|r| r.action_index == i).collect();
        !recs.is_empty() && recs.iter().all(|r| r.state.applied())
    };
    pick(m, requested, &applied, "this action did not complete, so there is nothing to undo (any files it moved are in the backup folder)")
}

/// Recovery of an incomplete backup (always as a whole): every action not undone yet that may
/// have anything in place, so the whole order goes back to its pre-order state.
fn select_recovery(m: &Manifest) -> Result<Vec<u32>> {
    let needs = m.needs_recovery();
    let open = |i: u32| m.records.iter().any(|r| r.action_index == i && !r.state.clean()) || needs.contains(&i);
    pick(m, None, &open, "nothing of this action is in place, so there is nothing to recover")
}

fn pick(m: &Manifest, requested: Option<Vec<u32>>, eligible: &dyn Fn(u32) -> bool, not_eligible: &str) -> Result<Vec<u32>> {
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
                if !eligible(i) {
                    return Err(Error::Invalid(format!("Undo {}: {not_eligible}", decapitalize(&label))));
                }
            }
            Ok(idx)
        }
        None => {
            let idx: Vec<u32> = (0..n).filter(|i| !m.entry.undone_actions.contains(i) && eligible(*i)).collect();
            if idx.is_empty() {
                return Err(Error::Invalid("everything in this backup is already undone".into()));
            }
            Ok(idx)
        }
    }
}

/// `plan_undo`. Stores the undo order and returns it. For an `incomplete` backup the order is
/// a recovery planned from the actual file locations (title "Recover …").
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
    let recovery = m.entry.status == BackupStatus::Incomplete;
    // Per-action undo only for a complete order; an incomplete one is recovered as a whole.
    match (m.entry.status, &action_indexes) {
        (BackupStatus::Incomplete, Some(_)) => {
            return Err(Error::Invalid(
                "these fixes were interrupted or could not be rolled back completely, so single actions cannot be undone; recover the whole backup instead".into(),
            ))
        }
        (BackupStatus::RolledBack, Some(_)) => {
            return Err(Error::Invalid("these fixes were rolled back, so the files are already as they were before them".into()))
        }
        _ => {}
    }

    let mut ops: Vec<PlannedOp> = Vec::new();
    let mut plans: Vec<OpPlan> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut reapplied: Vec<u32> = Vec::new();
    let mut left_in_place: Vec<String> = Vec::new();
    let selected = if recovery {
        if fsops::fold(&m.game_dir) != fsops::fold(&game_dir.display().to_string()) {
            return Err(Error::Conflict(format!(
                "This backup was made for the folder {}, but the instance is now at {}, so it cannot be recovered safely.",
                m.game_dir,
                game_dir.display()
            )));
        }
        let fix_broken = m.fix_needs_recovery();
        let undo_broken = m.undo_needs_recovery();
        if fix_broken.is_empty() && undo_broken.is_empty() {
            let left = m.left_in_place();
            return Err(Error::Invalid(format!(
                "these fixes were already recovered, but {} changed since the crash and was left in place; check it by hand",
                left.join(", ")
            )));
        }
        let found: Vec<(u32, FileOp, OpPlan)>;
        let selected = if fix_broken.is_empty() {
            // Only an undo of completed fixes broke: recover just that undo's actions, preferring
            // to revert it (back to the state right after the fixes).
            match plan_reapply(st, &game_dir, &snap, &m, &undo_broken) {
                Ok(planned) => {
                    found = planned;
                    reapplied = undo_broken.clone();
                    notes.push("An undo of these fixes was interrupted or could not be rolled back completely. Recovering puts its files back where the fixes had put them (as before that undo); the other fixes are not touched.".into());
                    if found.is_empty() {
                        notes.push("Every file is already where the fixes put it; executing only records that.".into());
                    }
                }
                Err(revert) => {
                    let why = revert.to_string();
                    let r = plan_recovery(st, &game_dir, &snap, &m, &undo_broken).map_err(|_| revert)?;
                    found = r.ops;
                    left_in_place = r.left_in_place;
                    notes.push(format!(
                        "An undo of these fixes was interrupted or could not be rolled back completely, and it cannot be reverted ({why}). Recovering finishes that undo: its files go back where they were before the fixes; the other fixes are not touched."
                    ));
                    notes.extend(r.notes);
                    if found.is_empty() {
                        notes.push("Every file is already where it was before the fixes; executing only records that.".into());
                    }
                }
            }
            undo_broken
        } else {
            let selected = select_recovery(&m)?;
            let r = plan_recovery(st, &game_dir, &snap, &m, &selected)?;
            found = r.ops;
            left_in_place = r.left_in_place;
            notes.push("These fixes were interrupted or could not be rolled back completely. Recovering puts every file back where it was before them; files the fixes created go into the backup folder.".into());
            notes.extend(r.notes);
            if found.is_empty() {
                notes.push("Every file is already where it was before the fixes; executing only records that.".into());
            }
            selected
        };
        for (pos, op, plan) in found {
            ops.push(PlannedOp { action_index: pos, op });
            plans.push(plan);
        }
        selected
    } else {
        let selected = select(&m, action_indexes)?;
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
        selected
    };

    let actions: Vec<FixAction> = selected.iter().map(|i| m.entry.actions[*i as usize].clone()).collect();
    let verb = if recovery { "Recover" } else { "Undo" };
    let order = WorkOrder {
        id: fsops::random_hex(2),
        instance_id: instance_id.clone(),
        kind: WorkOrderKind::Undo,
        title: format!("{verb} {}", decapitalize(&title_for(&actions))),
        actions,
        ops,
        notes,
        backup_dir: snap.display().to_string(),
    };
    st.fixes.store(StoredOrder {
        order: order.clone(),
        plans,
        game_dir,
        snapshot_dir: snap,
        backup_id: format!("{instance_id}/{ms}"),
        created_ms: ms,
        undo: Some(UndoOf { original_actions: selected, recovery, reapplied, left_in_place }),
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
