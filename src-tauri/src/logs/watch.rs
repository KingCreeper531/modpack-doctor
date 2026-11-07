//! Live watch mode: one background thread per watched instance that detects crash episodes
//! and emits `CrashDetected` (it never classifies; see `model/logs.rs`).
//!
//! Each watcher thread owns:
//! - a `notify` watcher on the game dir (new `hs_err_pid*.log`, and `crash-reports/` / `logs/`
//!   being created), `crash-reports/` (new reports) and `logs/` (latest.log written or
//!   recreated). Folders that don't exist yet are picked up when they appear; a folder that
//!   cannot be watched (permissions, network share) is logged once and covered by polling;
//! - a [`LogTail`] on `logs/latest.log`, started at its current end. The file is resolved
//!   through the PathGuard before every read, so a `latest.log` that is missing or resolves
//!   outside every root (a symlink escaping the roots, CONTRACTS invariant 2) is not read;
//! - the instance's Java processes (`process::instance_matches`), polled every
//!   `poll_interval` (1 s). The working dir of each process is recorded when it is first seen
//!   (in this watcher and in the shared [`CwdLog`]), because the JVM writes
//!   `hs_err_pid<pid>.log` there and that is not always the game dir. When the process exits,
//!   `<cwd>/hs_err_pid<pid>.log` is looked for (for `CWD_HS_ERR_WAIT_MS`) and, if the PathGuard
//!   accepts it (inside a root, or directly in a read-only hs_err dir such as CurseForge's
//!   `Install`), reported as a new hs_err file with the id `@cwd/hs_err_pid<pid>.log`;
//! - an [`EpisodeMachine`] fed in a fixed order per step: process starts, new crash files,
//!   new log lines (a replaced `latest.log` first feeds `LogReset`), process exits, tick.
//!   Processes are listed *before* the log is read, so every line a process wrote before
//!   exiting is seen before its exit, and crash files are always re-listed in a step that sees
//!   an exit, so a crash report written just before the exit is the episode's source.
//!
//! Notify bursts are debounced (`debounce`, 150 ms) into one step. Crash files are found by
//! diffing directory listings (on every relevant notify event, on every process exit, and every
//! `rescan_interval` as a fallback for missed events), so the event kind a platform reports does
//! not matter. `latest.log` is also read on every poll tick, because Windows reports writes to a
//! file held open by another process late or not at all.
//!
//! Stopping is deterministic without waiting for the thread: [`WatchHandle::stop`] clears the
//! handle's `active` flag under the same lock the thread holds while it emits, so once `stop`
//! returns that watcher emits nothing (and takes no episode number), even if its thread is still
//! finishing a step.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use tauri::{AppHandle, Runtime};
use tauri_specta::Event as _;

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::logs::episode::{Emission, EpisodeMachine, EpisodeTimings, Input};
use crate::logs::sources::{self, CRASH_DIR, LOGS_DIR};
use crate::logs::tail::{clean_anchors, LogTail};
use crate::model::{AnchorTier, CrashDetected, LogKind, LogSource, WatchAnchor};
use crate::process::{self, ProcessSource};

/// Most anchors accepted by `set_watch`, and longest anchor text (chars).
pub const MAX_ANCHORS: usize = 2_000;
pub const MAX_ANCHOR_CHARS: usize = 1_000;
/// How long after a process exit its working dir is checked for `hs_err_pid<pid>.log`.
pub const CWD_HS_ERR_WAIT_MS: u64 = 3_000;
/// Working dirs remembered per instance in the [`CwdLog`].
const MAX_CWDS_PER_INSTANCE: usize = 32;

// ── Seams ────────────────────────────────────────────────────────────────────

/// Receives detected episodes (Tauri event in the app, a channel in tests).
pub trait CrashSink: Send + Sync {
    fn crash_detected(&self, event: CrashDetected);
}

/// Emits the typed `CrashDetected` event to every webview.
pub struct TauriCrashSink<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriCrashSink<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> CrashSink for TauriCrashSink<R> {
    fn crash_detected(&self, event: CrashDetected) {
        if let Err(e) = event.emit(&self.app) {
            eprintln!("watch: could not emit CrashDetected: {e}");
        }
    }
}

/// Monotonic milliseconds.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

#[derive(Debug)]
pub struct MonotonicClock(Instant);

impl Default for MonotonicClock {
    fn default() -> Self {
        Self(Instant::now())
    }
}

impl Clock for MonotonicClock {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.0.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

#[derive(Debug, Clone)]
pub struct WatchConfig {
    pub poll_interval: Duration,
    pub debounce: Duration,
    pub rescan_interval: Duration,
    pub timings: EpisodeTimings,
    pub track_processes: bool,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(1),
            debounce: Duration::from_millis(150),
            rescan_interval: Duration::from_secs(5),
            timings: EpisodeTimings::default(),
            track_processes: true,
        }
    }
}

/// Validate `set_watch` anchors: drop empty texts and duplicates (fatal wins), bound the list.
pub fn sanitize_anchors(anchors: Vec<WatchAnchor>) -> Result<Vec<WatchAnchor>> {
    if anchors.len() > MAX_ANCHORS {
        return Err(Error::Invalid(format!("at most {MAX_ANCHORS} watch anchors are accepted, got {}", anchors.len())));
    }
    if let Some(a) = anchors.iter().find(|a| a.text.chars().count() > MAX_ANCHOR_CHARS) {
        let start: String = a.text.chars().take(40).collect();
        return Err(Error::Invalid(format!("the watch anchor \"{start}…\" is longer than {MAX_ANCHOR_CHARS} characters")));
    }
    Ok(clean_anchors(anchors))
}

// ── Recorded working dirs ────────────────────────────────────────────────────

/// Working dirs (outside the game dir) of the Java processes watch mode saw per instance, by
/// pid. `list_log_sources` / `read_log_digest` use them to offer `@cwd/hs_err_pid<pid>.log`
/// (see `logs::sources`). In memory only; kept after a watcher stops, bounded per instance.
#[derive(Debug, Default)]
pub struct CwdLog {
    map: Mutex<HashMap<String, Vec<(u32, PathBuf)>>>,
}

impl CwdLog {
    pub fn record(&self, instance_id: &str, pid: u32, dir: PathBuf) {
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        let list = map.entry(instance_id.to_string()).or_default();
        list.retain(|(p, _)| *p != pid);
        list.push((pid, dir));
        if list.len() > MAX_CWDS_PER_INSTANCE {
            list.remove(0);
        }
    }

    /// (pid, working dir) pairs recorded for `instance_id`, oldest first.
    pub fn get(&self, instance_id: &str) -> Vec<(u32, PathBuf)> {
        let map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        map.get(instance_id).cloned().unwrap_or_default()
    }
}

/// What every watcher of one [`Watchers`] registry shares.
#[derive(Debug, Clone, Default)]
pub struct WatchShared {
    /// App-wide episode counter.
    pub episodes: Arc<AtomicU32>,
    pub cwds: Arc<CwdLog>,
}

// ── Registry ─────────────────────────────────────────────────────────────────

/// Running watchers by instance id (`AppState.watchers`), plus the app-wide episode counter and
/// the recorded working dirs.
pub struct Watchers {
    map: Mutex<HashMap<String, WatchHandle>>,
    shared: WatchShared,
    config: WatchConfig,
}

impl Default for Watchers {
    fn default() -> Self {
        Self::with_config(WatchConfig::default())
    }
}

impl std::fmt::Debug for Watchers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Watchers").field("ids", &self.ids()).finish_non_exhaustive()
    }
}

impl Watchers {
    pub fn with_config(config: WatchConfig) -> Self {
        Self { map: Mutex::new(HashMap::new()), shared: WatchShared::default(), config }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, WatchHandle>> {
        self.map.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Start watching `game_dir` for `instance_id`, or, if it is already watched there, replace
    /// its anchors. A watcher for a different game dir is restarted; the old one emits nothing
    /// once this returns. Never waits for a thread.
    pub fn start(
        &self,
        instance_id: &str,
        game_dir: &Path,
        guard: Arc<PathGuard>,
        anchors: Vec<WatchAnchor>,
        procs: Arc<dyn ProcessSource>,
        sink: Arc<dyn CrashSink>,
    ) -> Result<()> {
        let mut map = self.lock();
        if let Some(h) = map.get(instance_id) {
            if h.game_dir == game_dir && h.is_alive() {
                h.set_anchors(anchors);
                return Ok(());
            }
        }
        if let Some(old) = map.remove(instance_id) {
            old.stop();
        }
        let spec = WatchSpec { instance_id: instance_id.to_string(), game_dir: game_dir.to_path_buf(), guard, anchors };
        let handle = WatchHandle::spawn(
            spec,
            procs,
            sink,
            self.shared.clone(),
            self.config.clone(),
            Arc::new(MonotonicClock::default()),
        )?;
        map.insert(instance_id.to_string(), handle);
        Ok(())
    }

    /// Stop the watcher for `instance_id`. True if one was running. Once this returns the
    /// watcher emits nothing more; its thread finishes on its own.
    pub fn stop(&self, instance_id: &str) -> bool {
        let handle = self.lock().remove(instance_id);
        handle.map(WatchHandle::stop).is_some()
    }

    pub fn stop_all(&self) {
        let all: Vec<WatchHandle> = self.lock().drain().map(|(_, h)| h).collect();
        for h in all {
            h.stop();
        }
    }

    pub fn is_watching(&self, instance_id: &str) -> bool {
        self.lock().contains_key(instance_id)
    }

    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.lock().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Working dirs (outside the game dir) of this instance's Java processes, by pid, as watch
    /// mode recorded them (also after the watcher stopped).
    pub fn recorded_cwds(&self, instance_id: &str) -> Vec<(u32, PathBuf)> {
        self.shared.cwds.get(instance_id)
    }
}

// ── One watcher ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct WatchSpec {
    pub instance_id: String,
    pub game_dir: PathBuf,
    /// Every file the watcher reads or reports must resolve inside its roots.
    pub guard: Arc<PathGuard>,
    pub anchors: Vec<WatchAnchor>,
}

enum Msg {
    Fs(Vec<PathBuf>),
    Anchors(Vec<WatchAnchor>),
    Stop,
}

/// Owner of one watcher thread. Stopping or dropping it silences the thread at once (see the
/// module docs) and signals it to finish, without waiting for it.
pub struct WatchHandle {
    tx: Sender<Msg>,
    thread: Option<JoinHandle<()>>,
    game_dir: PathBuf,
    /// False once stopped; the thread checks it under this lock right before every emission.
    active: Arc<Mutex<bool>>,
}

impl WatchHandle {
    pub fn spawn(
        spec: WatchSpec,
        procs: Arc<dyn ProcessSource>,
        sink: Arc<dyn CrashSink>,
        shared: WatchShared,
        config: WatchConfig,
        clock: Arc<dyn Clock>,
    ) -> Result<Self> {
        let (tx, rx) = mpsc::channel();
        let game_dir = spec.game_dir.clone();
        let fs_tx = tx.clone();
        let name = format!("watch-{}", spec.instance_id);
        let active = Arc::new(Mutex::new(true));
        let thread_active = active.clone();
        let thread = std::thread::Builder::new()
            .name(name)
            .spawn(move || {
                let mut w = WatchLoop::new(spec, procs, sink, shared, thread_active, config, clock);
                w.run(rx, fs_tx);
            })
            .map_err(|e| Error::Internal(format!("could not start the crash watcher: {e}")))?;
        Ok(Self { tx, thread: Some(thread), game_dir, active })
    }

    pub fn set_anchors(&self, anchors: Vec<WatchAnchor>) {
        let _ = self.tx.send(Msg::Anchors(anchors));
    }

    fn is_alive(&self) -> bool {
        self.thread.as_ref().is_some_and(|t| !t.is_finished())
    }

    /// Silence the watcher (waits at most for an emission in progress) and signal its thread to
    /// finish; does not wait for the thread.
    fn deactivate(&self) {
        *self.active.lock().unwrap_or_else(|p| p.into_inner()) = false;
        let _ = self.tx.send(Msg::Stop);
    }

    /// Silence the watcher and signal its thread to stop; does not wait for the thread.
    pub fn stop(mut self) {
        self.deactivate();
        self.thread.take();
    }

    /// Like [`WatchHandle::stop`], then wait for the thread (tests).
    pub fn stop_and_join(mut self) {
        self.deactivate();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.deactivate();
    }
}

/// What a batch of notify events asks for.
#[derive(Debug, Default, Clone, Copy)]
struct Dirty {
    files: bool,
    log: bool,
}

struct WatchLoop {
    spec: WatchSpec,
    crash_dir: PathBuf,
    logs_dir: PathBuf,
    /// `<game dir>/logs/latest.log` before resolution.
    log_path: PathBuf,
    procs: Arc<dyn ProcessSource>,
    sink: Arc<dyn CrashSink>,
    shared: WatchShared,
    active: Arc<Mutex<bool>>,
    config: WatchConfig,
    clock: Arc<dyn Clock>,
    machine: EpisodeMachine,
    tail: LogTail,
    known_files: BTreeMap<String, LogKind>,
    pids: HashSet<u32>,
    /// Working dir (outside the game dir) of each running process.
    cwd_of: HashMap<u32, PathBuf>,
    /// (pid, working dir, give up at ms): exited processes whose hs_err file is looked for.
    pending_cwd: Vec<(u32, PathBuf, u64)>,
    /// `@cwd/` ids reported by this watcher → their resolved path (for the emission's stat).
    cwd_files: HashMap<String, PathBuf>,
    notify: Option<RecommendedWatcher>,
    watched: HashSet<PathBuf>,
    /// Folders whose watch failed (logged once; polling covers them).
    failed: HashSet<PathBuf>,
}

impl WatchLoop {
    fn new(
        spec: WatchSpec,
        procs: Arc<dyn ProcessSource>,
        sink: Arc<dyn CrashSink>,
        shared: WatchShared,
        active: Arc<Mutex<bool>>,
        config: WatchConfig,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let crash_dir = spec.game_dir.join(CRASH_DIR);
        let logs_dir = spec.game_dir.join(LOGS_DIR);
        let log_path = spec.game_dir.join(LOGS_DIR).join("latest.log");
        let tail = LogTail::new(log_path.clone(), spec.anchors.clone());
        let machine = EpisodeMachine::new(config.timings, config.track_processes);
        Self {
            spec,
            crash_dir,
            logs_dir,
            log_path,
            procs,
            sink,
            shared,
            active,
            config,
            clock,
            machine,
            tail,
            known_files: BTreeMap::new(),
            pids: HashSet::new(),
            cwd_of: HashMap::new(),
            pending_cwd: Vec::new(),
            cwd_files: HashMap::new(),
            notify: None,
            watched: HashSet::new(),
            failed: HashSet::new(),
        }
    }

    fn run(&mut self, rx: Receiver<Msg>, fs_tx: Sender<Msg>) {
        self.notify = make_notify(fs_tx, &self.spec.instance_id);
        self.sync_watches();
        self.take_baseline();
        let mut next_poll = Instant::now();
        let mut next_rescan = Instant::now() + self.config.rescan_interval;
        loop {
            let wake = self.next_wake(next_poll);
            let mut dirty = Dirty::default();
            match rx.recv_timeout(wake.saturating_duration_since(Instant::now())) {
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Ok(Msg::Anchors(a)) => self.tail.set_anchors(a),
                Ok(Msg::Fs(paths)) => {
                    self.classify(&paths, &mut dirty);
                    if !self.debounce(&rx, &mut dirty) {
                        return;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            let now = Instant::now();
            let poll_due = now >= next_poll;
            if poll_due {
                next_poll = now + self.config.poll_interval;
            }
            if now >= next_rescan {
                next_rescan = now + self.config.rescan_interval;
                dirty.files = true;
            }
            self.step(dirty.files, dirty.log || poll_due, poll_due);
        }
    }

    /// Files and log content from before watch mode started are not new.
    fn take_baseline(&mut self) {
        self.known_files = sources::crash_file_ids(&self.spec.game_dir);
        if let Some(resolved) = self.resolve_log() {
            self.tail.set_path(resolved);
            self.tail.start_at_end();
        }
    }

    /// The next time the loop must wake on its own: the poll tick or an episode deadline.
    fn next_wake(&self, next_poll: Instant) -> Instant {
        match self.machine.next_deadline() {
            Some(deadline) => {
                let wait = deadline.saturating_sub(self.clock.now_ms());
                next_poll.min(Instant::now() + Duration::from_millis(wait))
            }
            None => next_poll,
        }
    }

    /// Absorb the rest of a notify burst. False if the watcher was stopped meanwhile.
    fn debounce(&mut self, rx: &Receiver<Msg>, dirty: &mut Dirty) -> bool {
        let until = Instant::now() + self.config.debounce;
        loop {
            match rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
                Ok(Msg::Fs(paths)) => self.classify(&paths, dirty),
                Ok(Msg::Anchors(a)) => self.tail.set_anchors(a),
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return false,
                Err(RecvTimeoutError::Timeout) => return true,
            }
        }
    }

    fn classify(&self, paths: &[PathBuf], dirty: &mut Dirty) {
        for p in paths {
            if p.starts_with(&self.logs_dir) {
                dirty.log = true;
            } else {
                // crash-reports/…, hs_err files, or crash-reports/ and logs/ themselves appearing.
                dirty.files = true;
                if p == &self.logs_dir {
                    dirty.log = true;
                }
            }
        }
    }

    /// Watch the game dir, crash-reports/ and logs/ when they exist; forget vanished ones.
    fn sync_watches(&mut self) {
        let Some(w) = self.notify.as_mut() else { return };
        for dir in [&self.spec.game_dir, &self.crash_dir, &self.logs_dir] {
            let exists = dir.is_dir();
            if exists && !self.watched.contains(dir) && !self.failed.contains(dir) {
                match w.watch(dir, RecursiveMode::NonRecursive) {
                    Ok(()) => {
                        self.watched.insert(dir.clone());
                    }
                    Err(e) => {
                        eprintln!("watch: cannot watch {} ({e}); checking it by polling instead", dir.display());
                        self.failed.insert(dir.clone());
                    }
                }
            } else if !exists && self.watched.remove(dir) {
                let _ = w.unwatch(dir);
            } else if !exists {
                // Retry a failed folder once it is recreated.
                self.failed.remove(dir);
            }
        }
    }

    /// `latest.log` resolved through the PathGuard; `None` if it is missing or resolves outside
    /// every root (it is then not read at all).
    fn resolve_log(&self) -> Option<PathBuf> {
        self.spec.guard.check_existing(&self.log_path).ok()
    }

    fn step(&mut self, mut scan_files: bool, read_log: bool, poll_procs: bool) {
        self.sync_watches();
        let now_ms = self.clock.now_ms();
        let mut started = Vec::new();
        let mut exited = Vec::new();
        if poll_procs && self.config.track_processes {
            let matches = process::instance_matches(&self.spec.game_dir, &*self.procs);
            let now: HashSet<u32> = matches.iter().map(|m| m.pid).collect();
            started = now.difference(&self.pids).copied().collect::<Vec<_>>();
            exited = self.pids.difference(&now).copied().collect::<Vec<_>>();
            started.sort_unstable();
            exited.sort_unstable();
            // Recorded once known: sysinfo may not report a just-spawned JVM's working dir.
            for m in matches {
                if self.cwd_of.contains_key(&m.pid) {
                    continue;
                }
                if let Some(cwd) = m.cwd.filter(|c| !process::same_dir(c, &self.spec.game_dir)) {
                    self.shared.cwds.record(&self.spec.instance_id, m.pid, cwd.clone());
                    self.cwd_of.insert(m.pid, cwd);
                }
            }
            for pid in &exited {
                if let Some(cwd) = self.cwd_of.remove(pid) {
                    self.pending_cwd.push((*pid, cwd, now_ms + CWD_HS_ERR_WAIT_MS));
                }
            }
            self.pids = now;
        }
        // A crash report is usually written just before the exit: list the files now so it is
        // part of the episode the exit completes (and becomes its source).
        if !exited.is_empty() {
            scan_files = true;
        }
        let mut inputs: Vec<Input> = started.into_iter().map(Input::ProcessStarted).collect();
        if scan_files {
            let current = sources::crash_file_ids(&self.spec.game_dir);
            for (id, kind) in &current {
                if !self.known_files.contains_key(id) && self.in_scope(id) {
                    inputs.push(Input::FatalFile { source_id: id.clone(), kind: *kind });
                }
            }
            self.known_files = current;
        }
        inputs.extend(self.cwd_hs_errs(now_ms));
        if read_log {
            if let Some(resolved) = self.resolve_log() {
                if self.tail.path() != resolved.as_path() {
                    self.tail.set_path(resolved);
                }
                // Bounded: a few capped reads per step; the rest waits for the next step.
                for _ in 0..4 {
                    let r = self.tail.poll();
                    if r.reset {
                        inputs.push(Input::LogReset);
                    }
                    for h in r.hits {
                        inputs.push(match h.tier {
                            AnchorTier::Fatal => Input::FatalAnchor { anchor: h.anchor, line: h.line },
                            AnchorTier::Contextual => Input::ContextualAnchor { anchor: h.anchor, line: h.line },
                        });
                    }
                    if !r.more {
                        break;
                    }
                }
            }
        }
        inputs.extend(exited.into_iter().map(Input::ProcessExited));
        inputs.push(Input::Tick);
        for input in inputs {
            for e in self.machine.handle(input, now_ms) {
                self.emit(e);
            }
        }
    }

    /// Whether a game-dir source id resolves inside the PathGuard roots.
    fn in_scope(&self, id: &str) -> bool {
        PathGuard::join_relative(&self.spec.game_dir, id).and_then(|p| self.spec.guard.check_existing(&p)).is_ok()
    }

    /// `hs_err_pid<pid>.log` files that appeared in the working dirs of exited processes.
    fn cwd_hs_errs(&mut self, now_ms: u64) -> Vec<Input> {
        let mut out = Vec::new();
        let guard = self.spec.guard.clone();
        let mut found = HashMap::new();
        self.pending_cwd.retain(|(pid, dir, give_up)| {
            let path = dir.join(format!("hs_err_pid{pid}.log"));
            match guard.check_existing(&path) {
                Ok(resolved) if resolved.is_file() => {
                    let id = sources::cwd_hs_err_id(*pid);
                    out.push(Input::FatalFile { source_id: id.clone(), kind: LogKind::HsErr });
                    found.insert(id, resolved);
                    false
                }
                // Not there (yet), or outside every root.
                _ => now_ms < *give_up,
            }
        });
        self.cwd_files.extend(found);
        out
    }

    /// Stat a source for the event: game-dir ids and this watcher's `@cwd/` ids, guarded.
    fn stat(&self, id: &str, kind: LogKind) -> Option<LogSource> {
        let path = match self.cwd_files.get(id) {
            Some(p) => p.clone(),
            None => PathGuard::join_relative(&self.spec.game_dir, id).ok()?,
        };
        let resolved = self.spec.guard.check_existing(&path).ok()?;
        sources::source_at(&resolved, id, kind)
    }

    fn emit(&self, e: Emission) {
        // Stat at emission time so size/mtime describe the finished file.
        let source = self
            .stat(&e.source.id, e.source.kind)
            .unwrap_or(LogSource { id: e.source.id.clone(), kind: e.source.kind, modified_ms: 0, size: 0 });
        let active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        if !*active {
            // Stopped or replaced: a watcher that was asked to stop never emits again.
            return;
        }
        let episode = self.shared.episodes.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        self.sink.crash_detected(CrashDetected {
            instance_id: self.spec.instance_id.clone(),
            episode,
            source,
            triggers: e.triggers,
        });
    }
}

fn make_notify(tx: Sender<Msg>, id: &str) -> Option<RecommendedWatcher> {
    let id_for_log = id.to_string();
    let logged = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let handler = move |res: notify::Result<notify::Event>| match res {
        Ok(ev) => {
            if matches!(ev.kind, EventKind::Access(_)) {
                return;
            }
            let _ = tx.send(Msg::Fs(ev.paths));
        }
        Err(e) => {
            if !logged.swap(true, Ordering::Relaxed) {
                eprintln!("watch {id_for_log}: file watching reported an error ({e}); polling continues");
            }
        }
    };
    match notify::recommended_watcher(handler) {
        Ok(w) => Some(w),
        Err(e) => {
            eprintln!("watch {id}: file watching is unavailable ({e}); falling back to polling");
            None
        }
    }
}

#[cfg(test)]
mod tests;
