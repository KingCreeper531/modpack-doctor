//! "Save fixed copy…" of an opened `.mrpack` (proposed CONTRACTS invariant 15 addition).
//!
//! The opened pack is never written. The UI sends `PackEdit` intents only (never URLs, hashes or
//! paths outside the pack); `plan_pack_fix` validates them against the opened pack and Modrinth
//! and stores a `PackFixPlan` in Rust; `save_fixed_pack(planId)` writes a NEW `.mrpack` where the
//! user picks in the native save dialog.

use serde::{Deserialize, Serialize};
use specta::Type;

/// One edit of the fixed copy. Paths are `files[].path` values of the pack's index, or zip entry
/// names of override jars, exactly as the scan reported them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PackEdit {
    /// Leave every `files[]` entry with this index path out of the copy's index.
    #[serde(rename_all = "camelCase")]
    RemoveDeclared { path: String },
    /// Leave this override jar (`overrides/mods/x.jar`, `client-overrides/mods/…`,
    /// `server-overrides/mods/…`) out of the copy.
    #[serde(rename_all = "camelCase")]
    RemoveOverride { entry: String },
    /// Replace the declared file at `path` with a Modrinth version of the same project.
    #[serde(rename_all = "camelCase")]
    ReplaceDeclared { path: String, version_id: String },
    /// Add a Modrinth version as a new `files[]` entry (`mods/<file name>`).
    #[serde(rename_all = "camelCase")]
    AddDependency { version_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PackFixOpKind {
    /// An index entry left out.
    Remove,
    /// An override jar left out.
    RemoveOverride,
    /// An index entry pointed at another Modrinth version of the same project.
    Replace,
    /// A new index entry.
    Add,
}

/// One planned change, in edit order (exactly one per `PackEdit`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PackFixOp {
    pub kind: PackFixOpKind,
    /// The index path or zip entry the op is about.
    pub subject: String,
    /// One readable sentence: what the copy gets instead.
    pub detail: String,
    /// Replace / Add: the `https://cdn.modrinth.com/…` URL written into the copy's index.
    pub url: Option<String>,
}

/// A validated, stored plan. Single use; expires 15 minutes after planning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PackFixPlan {
    /// 32 lower-case hex characters.
    pub id: String,
    pub instance_id: String,
    /// The opened pack's file name (the copy's default name is `<stem> (fixed).mrpack`).
    pub pack_file_name: String,
    pub ops: Vec<PackFixOp>,
    /// Things the copy changes besides the edits (e.g. unsafe entries left out), as sentences.
    pub warnings: Vec<String>,
}

/// Where `save_fixed_pack` wrote the copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedPack {
    /// Absolute path of the new file.
    pub path: String,
    pub file_name: String,
}
