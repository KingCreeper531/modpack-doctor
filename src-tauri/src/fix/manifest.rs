//! Backup snapshots on disk (CONTRACTS.md invariant 14):
//! `<app data>/backups/<instanceId>/<created ms>/` holds `manifest.json` (the `BackupEntry`
//! plus, per op, every file's sha1 before and after), `files/` (jars moved out, at their
//! original relative paths) and `created/` (files a fix created, moved out by rollback, undo or
//! recovery, plus leftover `.part` downloads of an interrupted order).
//!
//! Write-ahead: the manifest is written before the first mutation; before every op (and every
//! rollback step) its record is saved as `running` (`rollingBack`) together with every intended
//! move (the file hashes, the `.part` name, the `created/` name), and after it the actual result.
//! A record still `running` / `rollingBack` on disk therefore means "interrupted here", and the
//! recorded hashes and places say where each file can be. Undo orders work inside the snapshot
//! they reverse and append an [`UndoSession`] to its manifest. Nothing under `backups/` is ever
//! deleted automatically.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::model::{BackupEntry, BackupStatus, FileOp, PlannedOp};

pub const MANIFEST: &str = "manifest.json";
pub const FORMAT: u32 = 1;
/// Manifests larger than this are treated as corrupt (a real one is a few KiB).
const MAX_MANIFEST: u64 = 8 * 1024 * 1024;

/// One file an op changed. Paths are relative to the game dir; `backup_path` relative to the
/// snapshot dir.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// sha1 at `path` before the op; None = absent.
    pub before: Option<String>,
    /// sha1 at `path` after the op; None = absent (or, while `running`, not known yet).
    pub after: Option<String>,
    /// Where the "before" content went inside the snapshot (`files/…`), if it was moved there.
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecState {
    Pending,
    /// Write-ahead: the op is about to run or running. Still `running` on disk = interrupted.
    Running,
    /// Applied (and still applied).
    Done,
    /// Failed, and nothing of it is applied (its own partial work was reverted).
    Failed,
    Skipped,
    /// Write-ahead: the automatic rollback of this (applied) op is about to run or running.
    RollingBack,
    /// Applied, then reverted by the automatic rollback.
    RolledBack,
    /// Applied; the automatic rollback could not revert it (still fully applied, consistently).
    RollbackFailed,
    /// Neither applied nor reverted: a step and its own revert both failed. The files are at the
    /// places the record names; recovery restores them.
    Partial,
}

impl RecState {
    /// The op's effect is fully in place.
    pub fn applied(self) -> bool {
        matches!(self, RecState::Done | RecState::RollbackFailed)
    }

    /// Nothing of the op is in place, for certain.
    pub fn clean(self) -> bool {
        matches!(self, RecState::Pending | RecState::Skipped | RecState::Failed | RecState::RolledBack)
    }

    /// Interrupted or half done: only the files themselves say what is in place.
    pub fn uncertain(self) -> bool {
        matches!(self, RecState::Running | RecState::RollingBack | RecState::Partial)
    }

    /// Something went wrong that needs a recovery (not merely "applied").
    pub fn broken(self) -> bool {
        self.uncertain() || self == RecState::RollbackFailed
    }
}

/// What happened to one op of an order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpRecord {
    pub index: u32,
    pub action_index: u32,
    pub state: RecState,
    pub message: Option<String>,
    pub files: Vec<FileChange>,
    /// Where rollback or undo moved a created file inside the snapshot (`created/…`); written
    /// ahead of the move.
    #[serde(default)]
    pub created_backup: Option<String>,
    /// Downloads: the temporary file (`mods/.<name>.<hex>.part`, game-relative), written ahead
    /// of the download.
    #[serde(default)]
    pub part: Option<String>,
    /// Where startup / list recovery moved a leftover `part` inside the snapshot.
    #[serde(default)]
    pub part_backup: Option<String>,
    /// The temporary copies (game-relative, `<dir>/.<name>.<hex>.part`) that a cross-volume
    /// move from the snapshot into the instance writes for this op or its rollback, named ahead.
    #[serde(default)]
    pub temps: Vec<TempFile>,
}

/// A temporary copy a cross-volume move may leave behind when the app dies mid-copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempFile {
    /// Game-relative.
    pub path: String,
    /// Where startup / list recovery moved a leftover inside the snapshot.
    #[serde(default)]
    pub backup: Option<String>,
}

impl OpRecord {
    pub fn pending(index: u32, action_index: u32) -> Self {
        OpRecord {
            index,
            action_index,
            state: RecState::Pending,
            message: None,
            files: Vec::new(),
            created_backup: None,
            part: None,
            part_backup: None,
            temps: Vec::new(),
        }
    }

    /// The recorded temporary copy for a move into the game path `to`.
    pub fn temp_for(&self, to: &str) -> Option<String> {
        self.temps.iter().map(|t| &t.path).find(|p| temp_target(p).as_deref() == Some(to)).cloned()
    }
}

/// The temporary copy's name for a move into the game path `to` (`<dir>/.<name>.<hex>.part`).
pub fn temp_name(to: &str) -> String {
    let hex = super::fsops::random_hex(1);
    match to.rsplit_once('/') {
        Some((dir, name)) => format!("{dir}/.{name}.{hex}.part"),
        None => format!(".{to}.{hex}.part"),
    }
}

/// The destination a temporary copy was named for (inverse of [`temp_name`]).
fn temp_target(temp: &str) -> Option<String> {
    let (dir, name) = match temp.rsplit_once('/') {
        Some((d, n)) => (Some(d), n),
        None => (None, temp),
    };
    let inner = name.strip_prefix('.')?.strip_suffix(".part")?;
    let (target, hex) = inner.rsplit_once('.')?;
    if target.is_empty() || hex.len() != 16 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(match dir {
        Some(d) => format!("{d}/{target}"),
        None => target.to_string(),
    })
}

/// A recorded temporary copy name: `<dir>/.<name>.<16 hex>.part`.
pub fn is_temp_rel(rel: &str) -> bool {
    temp_target(rel).is_some()
}

/// One executed (or attempted) undo order of this snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoSession {
    pub order_id: String,
    pub started_at_ms: u64,
    /// Indexes into the original `actions`.
    pub action_indexes: Vec<u32>,
    pub ops: Vec<PlannedOp>,
    pub records: Vec<OpRecord>,
    pub rolled_back: bool,
    pub finished: bool,
    /// A recovery of an incomplete backup (planned from the actual file locations).
    #[serde(default)]
    pub recovery: bool,
    /// Found unfinished after a restart (the app was closed or crashed while it ran).
    #[serde(default)]
    pub interrupted: bool,
    /// A recovery of an interrupted undo: the original actions it put back into their applied
    /// state (that undo was reverted, so they are not undone).
    #[serde(default)]
    pub reapplied: Vec<u32>,
    /// A recovery: files the fixes created that were changed since the crash and were left in
    /// place (game paths). The backup stays `incomplete`.
    #[serde(default)]
    pub left_in_place: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub entry: BackupEntry,
    pub order_id: String,
    pub game_dir: String,
    /// Parallel to `entry.ops`.
    pub records: Vec<OpRecord>,
    pub rolled_back: bool,
    pub finished: bool,
    #[serde(default)]
    pub undo_log: Vec<UndoSession>,
    /// Found unfinished after a restart (the app was closed or crashed while it ran).
    #[serde(default)]
    pub interrupted: bool,
}

impl Manifest {
    /// Marks as undone the actions whose effect is certainly not in place once the order
    /// finished: those the automatic rollback reverted, and those that failed or were skipped.
    /// Undo orders add theirs on success. Actions without ops (manual steps) are never listed.
    pub fn compute_undone(&mut self) {
        let mut undone: Vec<u32> = self.entry.undone_actions.clone();
        if self.finished {
            for i in 0..self.entry.actions.len() {
                let i = u32::try_from(i).unwrap_or(u32::MAX);
                let recs: Vec<&OpRecord> = self.records.iter().filter(|r| r.action_index == i).collect();
                if !recs.is_empty() && recs.iter().all(|r| r.state.clean()) && !undone.contains(&i) {
                    undone.push(i);
                }
            }
        }
        undone.sort_unstable();
        undone.dedup();
        self.entry.undone_actions = undone;
    }

    fn has_ops(&self, action: u32) -> bool {
        self.records.iter().any(|r| r.action_index == action)
    }

    /// Actions with ops that are not undone yet.
    fn open_actions(&self) -> impl Iterator<Item = u32> + '_ {
        let n = u32::try_from(self.entry.actions.len()).unwrap_or(u32::MAX);
        (0..n).filter(|i| !self.entry.undone_actions.contains(i) && self.has_ops(*i))
    }

    /// Actions (not undone yet) whose own fix records need a recovery: every action with
    /// anything in place when the order never finished (it was interrupted, so the whole order
    /// goes back), and an action whose op or automatic rollback broke.
    pub fn fix_needs_recovery(&self) -> Vec<u32> {
        self.open_actions()
            .filter(|&i| {
                let mut recs = self.records.iter().filter(|r| r.action_index == i);
                if self.finished {
                    recs.any(|r| r.state.broken())
                } else {
                    recs.any(|r| !r.state.clean())
                }
            })
            .collect()
    }

    /// Actions (not undone yet) of an undo session that was interrupted or whose rollback broke,
    /// unless a later recovery of that action finished.
    pub fn undo_needs_recovery(&self) -> Vec<u32> {
        self.open_actions()
            .filter(|&i| {
                self.undo_log.iter().enumerate().any(|(k, s)| {
                    let Some(pos) = s.action_indexes.iter().position(|a| *a == i) else { return false };
                    let pos = u32::try_from(pos).unwrap_or(u32::MAX);
                    let broken = !s.finished || s.records.iter().any(|r| r.action_index == pos && r.state.broken());
                    let resolved = self.undo_log[k + 1..]
                        .iter()
                        .any(|t| t.recovery && t.finished && !t.rolled_back && t.action_indexes.contains(&i));
                    broken && !resolved
                })
            })
            .collect()
    }

    /// Actions (not undone yet) whose files need a recovery from their actual locations.
    pub fn needs_recovery(&self) -> Vec<u32> {
        let mut out = self.fix_needs_recovery();
        out.extend(self.undo_needs_recovery());
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Files a finished recovery left in place because they changed since the crash.
    pub fn left_in_place(&self) -> Vec<String> {
        self.undo_log
            .iter()
            .filter(|s| s.recovery && s.finished && !s.rolled_back)
            .flat_map(|s| s.left_in_place.iter().cloned())
            .collect()
    }

    /// `BackupEntry.status`, derived from the records (never trusted from disk).
    pub fn derive_status(&self) -> BackupStatus {
        // A finished recovery that moved files back to their pre-order places (not one that only
        // reverted an interrupted undo).
        let recovered = self
            .undo_log
            .iter()
            .any(|s| s.recovery && s.finished && !s.rolled_back && s.reapplied.len() < s.action_indexes.len());
        if !self.needs_recovery().is_empty() || !self.left_in_place().is_empty() {
            // Something may still be out of place: interrupted, broken, or a recovery that had
            // to leave a changed file where it was (so the files are not as before the order).
            BackupStatus::Incomplete
        } else if !self.finished || self.rolled_back || (recovered && self.open_actions().next().is_none()) {
            // Interrupted before anything stayed applied, rolled back, or recovered back to the
            // pre-order state: the files are as they were before the order.
            BackupStatus::RolledBack
        } else {
            BackupStatus::Complete
        }
    }
}

pub fn manifest_path(snapshot: &Path) -> PathBuf {
    snapshot.join(MANIFEST)
}

/// Write the manifest atomically and durably (the snapshot dir must already be vetted by the
/// guard).
pub fn save(guard: &PathGuard, snapshot: &Path, m: &Manifest) -> Result<()> {
    let path = super::fsops::new_path(guard, snapshot, MANIFEST)?;
    let bytes = serde_json::to_vec_pretty(m).map_err(|e| Error::Internal(format!("could not encode the backup manifest: {e}")))?;
    super::fsops::write_atomic(&path, &bytes)
}

/// `mods/.<name>.part` exactly: one hidden file directly in `mods/`.
pub fn is_part_rel(rel: &str) -> bool {
    rel.strip_prefix("mods/.").is_some_and(|n| !n.is_empty() && !n.contains(['/', '\\']) && n.ends_with(".part"))
}

/// Read and sanity-check one manifest. `entry.status` is derived from the records.
pub fn load(guard: &PathGuard, snapshot: &Path) -> Result<Manifest> {
    let path = super::fsops::existing(guard, snapshot, MANIFEST)?;
    let meta = fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
    if meta.len() > MAX_MANIFEST {
        return Err(Error::Corrupt { path: path.display().to_string(), reason: "it is far too large".into() });
    }
    let bytes = fs::read(&path).map_err(|e| Error::io(&path, e))?;
    let corrupt_json = |e: serde_json::Error| Error::Corrupt { path: path.display().to_string(), reason: format!("it is not a valid backup manifest ({e})") };
    let mut raw: serde_json::Value = serde_json::from_slice(&bytes).map_err(corrupt_json)?;
    // Manifests written before `status` existed: derived below anyway.
    if let Some(entry) = raw.get_mut("entry").and_then(serde_json::Value::as_object_mut) {
        entry.entry("status").or_insert_with(|| serde_json::Value::String("incomplete".into()));
    }
    let mut m: Manifest = serde_json::from_value(raw).map_err(corrupt_json)?;
    let corrupt = |reason: &str| Error::Corrupt { path: path.display().to_string(), reason: reason.to_string() };
    if m.format != FORMAT {
        return Err(corrupt("it was written by an incompatible version of Modpack Doctor"));
    }
    if m.records.len() != m.entry.ops.len() {
        return Err(corrupt("its op records do not match its ops"));
    }
    let dir_ms = snapshot.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let dir_inst = snapshot.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("");
    if m.entry.id != format!("{dir_inst}/{dir_ms}") || m.entry.instance_id != dir_inst || m.entry.created_at_ms.to_string() != dir_ms {
        return Err(corrupt("it does not belong to this backup folder"));
    }
    // Every path must stay a plain relative path (it is joined onto the game / snapshot dir).
    let safe = |rel: &str| PathGuard::join_relative(Path::new("x"), rel).map(|_| ()).map_err(|_| corrupt("it names an unsafe path"));
    let check_record = |rec: &OpRecord| -> Result<()> {
        for f in &rec.files {
            safe(&f.path)?;
            if let Some(b) = &f.backup_path {
                safe(b)?;
            }
        }
        for p in [&rec.created_backup, &rec.part_backup].into_iter().flatten() {
            safe(p)?;
        }
        if let Some(p) = &rec.part {
            if !is_part_rel(p) {
                return Err(corrupt("it names an unsafe temporary file"));
            }
        }
        for t in &rec.temps {
            safe(&t.path)?;
            if !is_temp_rel(&t.path) {
                return Err(corrupt("it names an unsafe temporary file"));
            }
            if let Some(b) = &t.backup {
                safe(b)?;
            }
        }
        Ok(())
    };
    for (i, (op, rec)) in m.entry.ops.iter().zip(&m.records).enumerate() {
        if rec.index as usize != i || rec.action_index != op.action_index || op.action_index as usize >= m.entry.actions.len() {
            return Err(corrupt("its op records are inconsistent"));
        }
        check_record(rec)?;
        if !matches!(op.op, FileOp::Rename { .. } | FileOp::MoveToBackup { .. } | FileOp::Download { .. }) {
            return Err(corrupt("it contains an op a fix never produces"));
        }
    }
    for s in &m.undo_log {
        if s.records.len() != s.ops.len() || s.action_indexes.iter().any(|a| *a as usize >= m.entry.actions.len()) {
            return Err(corrupt("its undo records are inconsistent"));
        }
        for (i, (op, rec)) in s.ops.iter().zip(&s.records).enumerate() {
            if rec.index as usize != i || rec.action_index != op.action_index || op.action_index as usize >= s.action_indexes.len() {
                return Err(corrupt("its undo records are inconsistent"));
            }
            check_record(rec)?;
        }
        if s.reapplied.iter().any(|a| !s.action_indexes.contains(a)) {
            return Err(corrupt("its undo records are inconsistent"));
        }
        for p in &s.left_in_place {
            safe(p)?;
        }
    }
    m.entry.status = m.derive_status();
    Ok(m)
}

/// The snapshot folders of one instance (`<root>/<instanceId>/<digits>`), unsorted.
pub(crate) fn snapshot_dirs(guard: &PathGuard, backups_root: &Path, instance_id: &str) -> Result<Vec<PathBuf>> {
    let dir = backups_root.join(instance_id);
    let rd = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::io(&dir, e)),
    };
    guard.check_existing(&dir)?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if name.is_empty() || name.len() > 19 || !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let snap = dir.join(&name);
        if snap.is_dir() {
            out.push(snap);
        }
    }
    Ok(out)
}

/// `list_backups`: every readable manifest of the instance, newest first. A corrupt or
/// unreadable manifest is skipped with a logged line; it never fails the listing.
pub fn list_backups(guard: &PathGuard, backups_root: &Path, instance_id: &str) -> Result<Vec<BackupEntry>> {
    if !super::is_instance_id(instance_id) {
        return Err(Error::Invalid(format!("\"{instance_id}\" is not an instance id")));
    }
    let mut out = Vec::new();
    for snap in snapshot_dirs(guard, backups_root, instance_id)? {
        match load(guard, &snap) {
            Ok(m) => out.push(m.entry),
            Err(e) => eprintln!("backups: skipped {}: {e}", snap.display()),
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.created_at_ms));
    Ok(out)
}
