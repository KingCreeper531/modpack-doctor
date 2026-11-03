//! The crash-episode state machine behind watch mode: pure, no I/O, driven by [`Input`]s with
//! an injected clock (`now`, monotonic milliseconds, passed to every call).
//!
//! Rules (owner decision 2026-11-03; see `model/logs.rs`):
//! - A **fatal** input (new crash report / hs_err file, `Fatal` anchor hit) opens an episode,
//!   folding in the contextual hits still inside the window. The episode emits once the inputs
//!   settle: `settle_ms` (FATAL_SETTLE_MS, 2 s) after the latest fatal input, but never later
//!   than `max_coalesce_ms` (10 s) after the first. It emits at once if the game process exits.
//! - A **contextual** hit is recorded silently (first hit per anchor; its time is refreshed by
//!   later hits of the same anchor). Hits older than `context_window_ms` (CONTEXT_WINDOW_MS,
//!   30 s) are discarded, and all hits are forgotten when `latest.log` is replaced
//!   ([`Input::LogReset`]: a new run, or log rotation). A process *start* does not clear them,
//!   because the first lines of a run are often read before its process is first seen. A
//!   process exit within the window of the latest contextual hit emits an episode; a process
//!   exit without a fatal event and without a hit in the window is a normal quit and emits
//!   nothing (and clears the hits).
//! - Without process tracking there are no exits, so contextual hits never emit.
//! - After an emission the crash is *suppressed*: fatal anchors, contextual hits (not even
//!   recorded) and process exits are dropped, and none of them extends the suppression.
//!   - With process tracking it lasts until every game process that was running at emission
//!     has exited, plus `exit_grace_ms` (5 s). If none was running, it lasts `exit_grace_ms`
//!     after an emission that included the exit, else `quiet_ms` (60 s).
//!   - Without process tracking it lasts `quiet_ms` from the emission.
//!   - A new game process (a pid not seen before) lifts it at once. So does a new
//!     `latest.log` (`LogReset`, written at launch) when no reported process is still running,
//!     which covers relaunches whose process cannot be matched or reuses a pid.
//!   - A **new crash file** that appears after the emitted episode's coalesce window
//!     (`max_coalesce_ms` after the episode opened, and at least `settle_ms` after the
//!     emission) lifts it and opens a new episode: a crash report or hs_err written that much
//!     later belongs to a later crash (for example an in-game crash after an error screen the
//!     game survived). Inside that window the file belongs to the emitted crash and is dropped,
//!     even if the suppression itself already ended.
//! - Within an episode only the first hit per anchor and the first sighting per file count.
//! - Source: newest crash report > newest hs_err > `logs/latest.log`.

use std::collections::HashSet;

use crate::logs::sources::LATEST_LOG;
use crate::model::{AnchorTier, CrashTrigger, LogKind, CONTEXT_WINDOW_MS, FATAL_SETTLE_MS};

/// Upper bound on how long fatal inputs keep extending the settle delay.
pub const MAX_COALESCE_MS: u64 = 10_000;
/// Post-emission suppression when no game process is tracked (see the module docs).
pub const QUIET_MS: u64 = 60_000;
/// Post-emission suppression left after the last tracked game process exited.
pub const EXIT_GRACE_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EpisodeTimings {
    pub settle_ms: u64,
    pub max_coalesce_ms: u64,
    pub context_window_ms: u64,
    pub quiet_ms: u64,
    pub exit_grace_ms: u64,
}

impl Default for EpisodeTimings {
    fn default() -> Self {
        Self {
            settle_ms: FATAL_SETTLE_MS,
            max_coalesce_ms: MAX_COALESCE_MS,
            context_window_ms: CONTEXT_WINDOW_MS,
            quiet_ms: QUIET_MS,
            exit_grace_ms: EXIT_GRACE_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    /// A new crash file appeared (`kind` = CrashReport or HsErr; `source_id` = its log source id).
    FatalFile { source_id: String, kind: LogKind },
    FatalAnchor { anchor: String, line: u32 },
    ContextualAnchor { anchor: String, line: u32 },
    ProcessStarted(u32),
    ProcessExited(u32),
    /// `latest.log` was replaced or truncated (a new run, or log rotation): forget the
    /// contextual hits recorded so far.
    LogReset,
    /// Time passes (lets settle deadlines and the suppression expire).
    Tick,
}

/// What an episode's analysis should read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceRef {
    pub id: String,
    pub kind: LogKind,
}

/// One crash episode, ready to become a `CrashDetected` (the watcher adds instance id, episode
/// number and the file's current size/mtime).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Emission {
    pub source: SourceRef,
    pub triggers: Vec<CrashTrigger>,
}

#[derive(Debug)]
struct Open {
    first_at: u64,
    last_fatal_at: u64,
    triggers: Vec<CrashTrigger>,
    anchors: HashSet<String>,
    files: HashSet<String>,
    /// (rank, source): crash report 2, hs_err 1.
    best: Option<(u8, SourceRef)>,
}

impl Open {
    fn new(now: u64) -> Self {
        Self { first_at: now, last_fatal_at: now, triggers: Vec::new(), anchors: HashSet::new(), files: HashSet::new(), best: None }
    }

    fn add_anchor(&mut self, anchor: String, tier: AnchorTier, line: u32) {
        if self.anchors.insert(anchor.clone()) {
            self.triggers.push(CrashTrigger::LogAnchor { anchor, tier, line });
        }
    }

    fn add_file(&mut self, source_id: String, kind: LogKind) {
        if !self.files.insert(source_id.clone()) {
            return;
        }
        let rank = match kind {
            LogKind::CrashReport => 2,
            LogKind::HsErr => 1,
            _ => 0,
        };
        // A later file of the same rank is the newer one.
        if self.best.as_ref().is_none_or(|(r, _)| rank >= *r) && rank > 0 {
            self.best = Some((rank, SourceRef { id: source_id.clone(), kind }));
        }
        self.triggers.push(match kind {
            LogKind::HsErr => CrashTrigger::NewHsErr { source_id },
            _ => CrashTrigger::NewCrashReport { source_id },
        });
    }

    fn has_exit(&self) -> bool {
        self.triggers.iter().any(|t| matches!(t, CrashTrigger::ProcessExit { .. }))
    }

    fn into_emission(self) -> Emission {
        let source = self.best.map(|(_, s)| s).unwrap_or(SourceRef { id: LATEST_LOG.to_string(), kind: LogKind::LatestLog });
        Emission { source, triggers: self.triggers }
    }
}

#[derive(Debug, Clone)]
struct Contextual {
    anchor: String,
    line: u32,
    first_at: u64,
    last_at: u64,
}

/// Post-emission state (see the module docs).
#[derive(Debug)]
struct Suppression {
    /// Tracked game processes that were running at emission and have not exited yet.
    pids: HashSet<u32>,
    /// When the suppression ends; `None` while `pids` is not empty.
    until: Option<u64>,
}

#[derive(Debug)]
pub struct EpisodeMachine {
    timings: EpisodeTimings,
    tracking: bool,
    running: HashSet<u32>,
    /// Pids ever seen (a pid seen again is not a *new* process).
    seen: HashSet<u32>,
    contextual: Vec<Contextual>,
    open: Option<Open>,
    suppressed: Option<Suppression>,
    /// A new crash file before this time belongs to the last emitted crash, even after the
    /// suppression itself ended (an exit-only emission ends it after `exit_grace_ms`).
    file_quiet_until: u64,
}

impl EpisodeMachine {
    /// `tracking`: whether process start/exit inputs will arrive.
    pub fn new(timings: EpisodeTimings, tracking: bool) -> Self {
        Self {
            timings,
            tracking,
            running: HashSet::new(),
            seen: HashSet::new(),
            contextual: Vec::new(),
            open: None,
            suppressed: None,
            file_quiet_until: 0,
        }
    }

    /// The next time a `Tick` could change something (settle deadline), if any.
    pub fn next_deadline(&self) -> Option<u64> {
        self.open.as_ref().map(|o| self.deadline(o))
    }

    pub fn is_suppressed(&self) -> bool {
        self.suppressed.is_some()
    }

    pub fn running(&self) -> &HashSet<u32> {
        &self.running
    }

    fn deadline(&self, o: &Open) -> u64 {
        (o.last_fatal_at + self.timings.settle_ms).min(o.first_at + self.timings.max_coalesce_ms)
    }

    /// Feed one input at time `now`. Returns the episodes that completed (at most one in
    /// practice; a settle deadline that passed before this input is honoured first).
    pub fn handle(&mut self, input: Input, now: u64) -> Vec<Emission> {
        let mut out = Vec::new();
        self.expire(now, &mut out);
        match input {
            Input::Tick => {}
            Input::LogReset => {
                self.contextual.clear();
                // `latest.log` is replaced at launch: with no reported process still running,
                // that is a new run, which the last crash must not keep quiet.
                if self.suppressed.as_ref().is_some_and(|s| s.pids.is_empty()) {
                    self.suppressed = None;
                    self.file_quiet_until = 0;
                }
            }
            Input::ProcessStarted(pid) => {
                self.running.insert(pid);
                if self.seen.insert(pid) {
                    // A new game process: a new run, so the last crash no longer suppresses.
                    self.suppressed = None;
                    self.file_quiet_until = 0;
                }
            }
            Input::ProcessExited(pid) => {
                self.running.remove(&pid);
                if let Some(s) = self.suppressed.as_mut() {
                    // The exit of the crash that was already reported.
                    s.pids.remove(&pid);
                    if s.pids.is_empty() && s.until.is_none() {
                        s.until = Some(now + self.timings.exit_grace_ms);
                    }
                    self.contextual.clear();
                    return out;
                }
                if let Some(mut open) = self.open.take() {
                    open.triggers.push(CrashTrigger::ProcessExit { pid });
                    self.emit(open, now, &mut out);
                } else if self.tracking && !self.contextual.is_empty() {
                    let mut open = Open::new(now);
                    self.fold_contextual(&mut open);
                    open.triggers.push(CrashTrigger::ProcessExit { pid });
                    self.emit(open, now, &mut out);
                }
                // Otherwise a normal quit.
                self.contextual.clear();
            }
            Input::ContextualAnchor { anchor, line } => {
                if self.suppressed.is_some() {
                    return out;
                }
                if let Some(open) = self.open.as_mut() {
                    open.add_anchor(anchor, AnchorTier::Contextual, line);
                } else if let Some(c) = self.contextual.iter_mut().find(|c| c.anchor == anchor) {
                    c.last_at = now;
                } else {
                    self.contextual.push(Contextual { anchor, line, first_at: now, last_at: now });
                }
            }
            Input::FatalAnchor { anchor, line } => {
                if self.suppressed.is_some() {
                    return out;
                }
                let open = self.open_episode(now);
                open.add_anchor(anchor, AnchorTier::Fatal, line);
            }
            Input::FatalFile { source_id, kind } => {
                if now < self.file_quiet_until {
                    return out;
                }
                // Written well after the reported crash: a new one.
                self.suppressed = None;
                let open = self.open_episode(now);
                open.add_file(source_id, kind);
            }
        }
        out
    }

    /// Drop expired contextual hits, end a suppression whose time is up, and emit an episode
    /// whose settle deadline passed.
    fn expire(&mut self, now: u64, out: &mut Vec<Emission>) {
        let window = self.timings.context_window_ms;
        self.contextual.retain(|c| now.saturating_sub(c.last_at) <= window);
        if self.suppressed.as_ref().and_then(|s| s.until).is_some_and(|until| now >= until) {
            self.suppressed = None;
        }
        if let Some(open) = &self.open {
            if now >= self.deadline(open) {
                if let Some(open) = self.open.take() {
                    self.emit(open, now, out);
                }
            }
        }
    }

    fn open_episode(&mut self, now: u64) -> &mut Open {
        if self.open.is_none() {
            let mut open = Open::new(now);
            self.fold_contextual(&mut open);
            self.open = Some(open);
        }
        let open = self.open.get_or_insert_with(|| Open::new(now));
        open.last_fatal_at = now;
        open
    }

    fn fold_contextual(&mut self, open: &mut Open) {
        let mut hits = std::mem::take(&mut self.contextual);
        hits.sort_by_key(|c| c.first_at);
        for c in hits {
            open.add_anchor(c.anchor, AnchorTier::Contextual, c.line);
        }
    }

    fn emit(&mut self, open: Open, now: u64, out: &mut Vec<Emission>) {
        self.contextual.clear();
        let t = &self.timings;
        let pids = if self.tracking { self.running.clone() } else { HashSet::new() };
        let until = if !pids.is_empty() {
            None
        } else if self.tracking && open.has_exit() {
            Some(now + t.exit_grace_ms)
        } else {
            Some(now + t.quiet_ms)
        };
        self.file_quiet_until = (open.first_at + t.max_coalesce_ms).max(now + t.settle_ms);
        self.suppressed = Some(Suppression { pids, until });
        out.push(open.into_emission());
    }
}

#[cfg(test)]
mod tests;
