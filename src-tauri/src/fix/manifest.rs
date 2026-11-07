//! Backup snapshots on disk (CONTRACTS.md invariant 14):
//! `<app data>/backups/<instanceId>/<created ms>/` holds `manifest.json` (the `BackupEntry`
//! plus, per op, every file's sha1 before and after), `files/` (jars moved out, at their
//! original relative paths) and `created/` (files a fix created, moved out by rollback or undo).
//!
//! The manifest is written before the first mutation and rewritten (atomically) after every op
//! and rollback step. Undo orders work inside the snapshot they reverse and append an
//! [`UndoSession`] to its manifest. Nothing under `backups/` is ever deleted automatically.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::model::{BackupEntry, FileOp, PlannedOp};

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
    /// sha1 at `path` after the op; None = absent.
    pub after: Option<String>,
    /// Where the "before" content went inside the snapshot (`files/…`), if it was moved there.
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecState {
    Pending,
    Running,
    /// Applied (and still applied).
    Done,
    /// Failed; any partial work was reverted unless `message` says otherwise.
    Failed,
    Skipped,
    /// Applied, then reverted by the automatic rollback.
    RolledBack,
    /// Applied; the automatic rollback could not revert it (still applied, undo can recover).
    RollbackFailed,
}

impl RecState {
    /// The op's effect is currently in place.
    pub fn applied(self) -> bool {
        matches!(self, RecState::Done | RecState::RollbackFailed)
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
    /// Where rollback or undo moved a created file inside the snapshot (`created/…`).
    #[serde(default)]
    pub created_backup: Option<String>,
}

impl OpRecord {
    pub fn pending(index: u32, action_index: u32) -> Self {
        OpRecord { index, action_index, state: RecState::Pending, message: None, files: Vec::new(), created_backup: None }
    }
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
}

impl Manifest {
    /// Marks as undone the actions whose effect is not in place once the order finished: those
    /// the automatic rollback reverted, and those that failed or were skipped (nothing of them
    /// is applied, so there is nothing to undo). Undo orders add theirs on success. Actions
    /// without ops (manual steps) are never listed.
    pub fn compute_undone(&mut self) {
        let mut undone: Vec<u32> = self.entry.undone_actions.clone();
        if self.finished {
            for i in 0..self.entry.actions.len() {
                let i = u32::try_from(i).unwrap_or(u32::MAX);
                let recs: Vec<&OpRecord> = self.records.iter().filter(|r| r.action_index == i).collect();
                if !recs.is_empty() && recs.iter().all(|r| !r.state.applied()) && !undone.contains(&i) {
                    undone.push(i);
                }
            }
        }
        undone.sort_unstable();
        undone.dedup();
        self.entry.undone_actions = undone;
    }
}

pub fn manifest_path(snapshot: &Path) -> PathBuf {
    snapshot.join(MANIFEST)
}

/// Write the manifest atomically (the snapshot dir must already be vetted by the guard).
pub fn save(guard: &PathGuard, snapshot: &Path, m: &Manifest) -> Result<()> {
    let path = super::fsops::new_path(guard, snapshot, MANIFEST)?;
    let bytes = serde_json::to_vec_pretty(m).map_err(|e| Error::Internal(format!("could not encode the backup manifest: {e}")))?;
    super::fsops::write_atomic(&path, &bytes)
}

/// Read and sanity-check one manifest.
pub fn load(guard: &PathGuard, snapshot: &Path) -> Result<Manifest> {
    let path = super::fsops::existing(guard, snapshot, MANIFEST)?;
    let meta = fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
    if meta.len() > MAX_MANIFEST {
        return Err(Error::Corrupt { path: path.display().to_string(), reason: "it is far too large".into() });
    }
    let bytes = fs::read(&path).map_err(|e| Error::io(&path, e))?;
    let m: Manifest = serde_json::from_slice(&bytes)
        .map_err(|e| Error::Corrupt { path: path.display().to_string(), reason: format!("it is not a valid backup manifest ({e})") })?;
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
    for (i, (op, rec)) in m.entry.ops.iter().zip(&m.records).enumerate() {
        if rec.index as usize != i || rec.action_index != op.action_index || op.action_index as usize >= m.entry.actions.len() {
            return Err(corrupt("its op records are inconsistent"));
        }
        // Every path must stay a plain relative path (it is joined onto the game / snapshot dir).
        for f in &rec.files {
            PathGuard::join_relative(Path::new("x"), &f.path).map_err(|_| corrupt("it names an unsafe path"))?;
            if let Some(b) = &f.backup_path {
                PathGuard::join_relative(Path::new("x"), b).map_err(|_| corrupt("it names an unsafe path"))?;
            }
        }
        if !matches!(op.op, FileOp::Rename { .. } | FileOp::MoveToBackup { .. } | FileOp::Download { .. }) {
            return Err(corrupt("it contains an op a fix never produces"));
        }
    }
    Ok(m)
}

/// `list_backups`: every readable manifest of the instance, newest first. A corrupt or
/// unreadable manifest is skipped with a logged line; it never fails the listing.
pub fn list_backups(guard: &PathGuard, backups_root: &Path, instance_id: &str) -> Result<Vec<BackupEntry>> {
    if !super::is_instance_id(instance_id) {
        return Err(Error::Invalid(format!("\"{instance_id}\" is not an instance id")));
    }
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
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let snap = dir.join(&name);
        if !snap.is_dir() {
            continue;
        }
        match load(guard, &snap) {
            Ok(m) => out.push(m.entry),
            Err(e) => eprintln!("backups: skipped {}: {e}", snap.display()),
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.created_at_ms));
    Ok(out)
}
