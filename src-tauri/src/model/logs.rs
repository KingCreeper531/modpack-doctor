//! Crash reports and logs. FROZEN (M1).
//!
//! Rust streams files and returns a bounded digest. Classification happens in
//! `src/core/crash`, which owns the anchor list passed to both `read_log_digest` and
//! `set_watch`.
//!
//! Watch mode (Rust) *detects*; it never classifies. Per watched instance it:
//! - watches `crash-reports/` and the game dir for new `crash-reports/*.txt` / `hs_err_pid*.log`;
//! - tails `logs/latest.log` (resetting its offset when the file shrinks or is recreated on a
//!   new launch) and matches every new line against the TS anchor list;
//! - polls the shared process detection (the same code as the running-game guard) and treats
//!   the instance's Java process exiting as a trigger.
//!
//! Debounce: triggers are collected into one *episode*. The episode is emitted as exactly one
//! `CrashDetected` when the Java process exits, or 5 s after the last trigger if no process is
//! being tracked (hard cap 20 s after the first trigger). Further triggers are suppressed until
//! a new game process is seen or 60 s pass without a trigger. A process exit with no anchor hit
//! and no new crash/hs_err file is a normal quit and emits nothing.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogKind {
    /// `crash-reports/*.txt`
    CrashReport,
    /// `logs/latest.log`
    LatestLog,
    /// `logs/debug.log`
    DebugLog,
    /// `hs_err_pid*.log` in the game dir
    HsErr,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogSource {
    /// Path relative to the game dir with `/` separators; also the id. On input
    /// (`read_log_digest`) only ids returned by `list_log_sources` are accepted.
    pub id: String,
    pub kind: LogKind,
    #[specta(type = specta_typescript::Number)]
    pub modified_ms: u64,
    #[specta(type = specta_typescript::Number)]
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChunkReason {
    /// First N lines of the file.
    Head,
    /// Last N lines of the file.
    Tail,
    /// Context around a line containing `anchor`.
    Anchor { anchor: String },
    /// A structural block Rust recognises without classifying it.
    Block { block: LogBlock },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogBlock {
    /// Crash report header through the first stack trace (`---- Minecraft Crash Report ----`,
    /// `Description:`, exception + frames).
    CrashHead,
    /// Forge `Suspected Mod(s):` / NeoForge `-- Mod loading issue for:` sections.
    SuspectedMods,
    /// Every `Caused by:` line plus its frames, up to the next blank line / `Caused by:`.
    CausedByChain,
    /// `-- System Details --` to end of section.
    SystemDetails,
    /// `Mod List:` / `Fabric Mods:` / Quilt mod table.
    ModList,
    /// hs_err header (`# A fatal error…` through `# Problematic frame:` and the next lines).
    HsErrHeader,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    /// 1-based line number of `lines[0]` in the original file.
    pub start_line: u32,
    pub lines: Vec<String>,
    pub reasons: Vec<ChunkReason>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DigestOptions {
    /// Lines kept from the start (default 120).
    pub head: u32,
    /// Lines kept from the end (default 400).
    pub tail: u32,
    /// Context lines on each side of an anchor hit (default 12).
    pub context: u32,
    /// Hard cap on total lines returned (default 6000); `truncated` is set when hit.
    pub max_lines: u32,
    /// Lines longer than this (chars, default 2000) are cut and suffixed with
    /// ` …[+N chars]`. Anchors are matched against the full line before cutting.
    pub max_line_chars: u32,
}

/// Non-overlapping chunks sorted by `startLine`; overlapping windows are merged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogDigest {
    pub source: LogSource,
    pub total_lines: u32,
    pub truncated: bool,
    pub chunks: Vec<LogChunk>,
}

/// Why watch mode opened a crash episode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CrashTrigger {
    NewCrashReport { source_id: String },
    NewHsErr { source_id: String },
    /// A new `latest.log` line contained a TS anchor (first hit per anchor only).
    #[serde(rename_all = "camelCase")]
    LogAnchor { anchor: String, line: u32 },
    /// The instance's Java process exited (exit code is not observable for non-child processes).
    #[serde(rename_all = "camelCase")]
    ProcessExit { pid: u32 },
}

/// Event: one per crash episode for a watched instance (see module docs for debouncing).
/// The UI reads a digest of `source`, classifies it, and notifies only if `src/core` finds an
/// error-severity crash finding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CrashDetected {
    pub instance_id: String,
    /// Monotonic per app run; lets the UI drop duplicates.
    pub episode: u32,
    /// Best source to analyse: crash report > hs_err > latest.log.
    pub source: LogSource,
    pub triggers: Vec<CrashTrigger>,
}
