//! Fix intents, work orders, backups. FROZEN (M1).
//!
//! The UI sends `FixAction` intents. Rust plans them into concrete `FileOp`s, stores the
//! `WorkOrder` under an id, and only ever executes stored orders. Versions to download are
//! chosen by `src/core` (which owns pack identity) and passed as Modrinth version ids; Rust
//! re-fetches `GET /v2/version/{id}` so every URL, size and hash comes from the API.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::instance::LoaderInfo;

/// The effective pack identity `src/core/pack` resolved (override > launcher/mrpack metadata >
/// jar majority). Sent with `plan_work_order` so Rust can re-validate chosen versions.
/// Rust rejects it if it contradicts launcher/mrpack metadata or a stored override.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PackIdentity {
    pub mc_version: String,
    pub loader: LoaderInfo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FixAction {
    /// Rename `<jar>` → `<jar>.disabled`.
    #[serde(rename_all = "camelCase")]
    Disable { jar_id: String },
    /// Rename `<jar>.disabled` → `<jar>`.
    #[serde(rename_all = "camelCase")]
    Enable { jar_id: String },
    /// Move `remove` into the backup snapshot (never deleted); `keep` stays.
    #[serde(rename_all = "camelCase")]
    RemoveDuplicate { keep: String, remove: String },
    /// Replace a jar with a specific Modrinth version (chosen by src/core from
    /// `modrinth_find_updates` / `modrinth_project_versions`).
    #[serde(rename_all = "camelCase")]
    Replace { jar_id: String, version_id: String },
    /// Install a missing dependency at a specific Modrinth version.
    #[serde(rename_all = "camelCase")]
    InstallDependency { mod_id: String, version_id: String },
    /// Advice only (Java version, memory); never produces file ops.
    #[serde(rename_all = "camelCase")]
    Manual { steps: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum FileOp {
    /// Paths relative to the game dir, `/` separators.
    Rename { from: String, to: String },
    /// Move into the backup snapshot (the "remove" operation).
    MoveToBackup { path: String },
    /// Download the version file chosen by the rule in CONTRACTS.md invariant 7.
    #[serde(rename_all = "camelCase")]
    Download {
        project_title: String,
        version_number: String,
        #[specta(type = specta_typescript::Number)]
        size_bytes: u64,
        /// `https://cdn.modrinth.com/...` taken from the API response.
        url: String,
        sha512: String,
        /// Destination relative to the game dir.
        dest: String,
        /// Jar being replaced (moved to backup after the download verifies), if any.
        replaces: Option<String>,
    },
    /// Undo only: copy a file back from a backup snapshot.
    #[serde(rename_all = "camelCase")]
    Restore {
        /// Relative to the backup dir.
        backup_path: String,
        /// Relative to the game dir.
        to: String,
        /// Current state undo expects at `to`: None = must be absent; Some(sha1) = must match.
        expect_absent_or_sha1: Option<String>,
    },
    /// Undo only: move a file that a fix created back out (e.g. an installed dependency) into
    /// the backup snapshot. Refused if its sha1 changed since the fix.
    #[serde(rename_all = "camelCase")]
    RemoveCreated { path: String, expect_sha1: String },
}

/// A file operation and the `FixAction` (index into `WorkOrder.actions`) it implements.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlannedOp {
    pub action_index: u32,
    pub op: FileOp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum WorkOrderKind {
    Fix,
    Undo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkOrder {
    pub id: String,
    pub instance_id: String,
    /// `undo` orders consisting of exactly one `rename` op may be confirmed with Enter
    /// (DESIGN.md §6.4); every other order requires clicking Execute.
    pub kind: WorkOrderKind,
    /// Human summary, e.g. "Disable 2 mods, replace sodium".
    pub title: String,
    pub actions: Vec<FixAction>,
    pub ops: Vec<PlannedOp>,
    /// Non-fatal planning notes (e.g. "manual step: install Java 21").
    pub notes: Vec<String>,
    /// Where the snapshot will be written (absolute), shown in the footer.
    pub backup_dir: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum OpState {
    Pending,
    Running,
    Done,
    Failed,
    Skipped,
}

/// Event and per-op result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct OpStatus {
    pub order_id: String,
    /// Index into `WorkOrder.ops`.
    pub index: u32,
    pub state: OpState,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkOrderResult {
    pub order_id: String,
    /// Set once a snapshot was written (even if a later op failed).
    pub backup_id: Option<String>,
    pub statuses: Vec<OpStatus>,
    /// True when a failure triggered automatic rollback of completed ops.
    pub rolled_back: bool,
}

/// One executed work order. Undo works per action (`plan_undo(backupId, actionIndexes)`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    /// `<instanceId>/<timestamp ms>` — validated as `^[0-9a-f]{16}/[0-9]+$` on input.
    pub id: String,
    pub instance_id: String,
    #[specta(type = specta_typescript::Number)]
    pub created_at_ms: u64,
    pub title: String,
    pub actions: Vec<FixAction>,
    pub ops: Vec<PlannedOp>,
    /// Indexes into `actions` already undone.
    pub undone_actions: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GameStatus {
    pub running: bool,
    pub pids: Vec<u32>,
    /// Why we think it's running ("java.exe pid 1234 with --gameDir …", "mods/x.jar is locked").
    pub reason: Option<String>,
}
