//! Live watch mode: one background thread per watched instance that detects crash episodes
//! and emits `CrashDetected` (it never classifies; see `model/logs.rs`).
//!
//! Each watcher thread owns:
//! - a `notify` watcher on the game dir (new `hs_err_pid*.log`, and `crash-reports/` / `logs/`
//!   being created), `crash-reports/` (new reports) and `logs/` (latest.log written or
//!   recreated). Folders that don't exist yet are picked up when they appear; a folder that
//!   cannot be watched (permissions, network share) is logged once and covered by polling;
//! - a [`LogTail`] on `logs/latest.log`, started at its current end;
//! - the instance's Java processes (`process::instance_processes`), polled every
//!   `poll_interval` (1 s);
//! - an [`EpisodeMachine`] fed in a fixed order per step: process starts, new crash files,
//!   new log lines, process exits, tick. Processes are listed *before* the log is read, so every
//!   line a process wrote before exiting is seen before its exit.
//!
//! Notify bursts are debounced (`debounce`, 150 ms) into one step. Crash files are found by
//! diffing directory listings (on every relevant notify event, and every `rescan_interval` as a
//! fallback for missed events), so the event kind a platform reports does not matter.
//! `latest.log` is also read on every poll tick, because Windows reports writes to a file held
//! open by another process late or not at all.

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
use crate::logs::episode::{Emission, EpisodeMachine, EpisodeTimings, Input};
use crate::logs::sources::{self, CRASH_DIR, LOGS_DIR};
use crate::logs::tail::{clean_anchors, LogTail};
use crate::model::{AnchorTier, CrashDetected, LogKind, LogSource, WatchAnchor};
use crate::process::{self, ProcessSource};

/// Most anchors accepted by `set_watch`, and longest anchor text (chars).
pub const MAX_ANCHORS: usize = 2_000;
pub const MAX_ANCHOR_CHARS: usize = 1_000;

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

// ── Registry ─────────────────────────────────────────────────────────────────

/// Running watchers by instance id (`AppState.watchers`), plus the app-wide episode counter.
pub struct Watchers {
    map: Mutex<HashMap<String, WatchHandle>>,
    episodes: Arc<AtomicU32>,
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
        Self { map: Mutex::new(HashMap::new()), episodes: Arc::new(AtomicU32::new(0)), config }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, WatchHandle>> {
        self.map.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Start watching `game_dir` for `instance_id`, or, if it is already watched there, replace
    /// its anchors. A watcher for a different game dir is restarted.
    pub fn start(
        &self,
        instance_id: &str,
        game_dir: &Path,
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
        let spec = WatchSpec { instance_id: instance_id.to_string(), game_dir: game_dir.to_path_buf(), anchors };
        let handle = WatchHandle::spawn(
            spec,
            procs,
            sink,
            self.episodes.clone(),
            self.config.clone(),
            Arc::new(MonotonicClock::default()),
        )?;
        map.insert(instance_id.to_string(), handle);
        Ok(())
    }

    /// Stop the watcher for `instance_id`. True if one was running.
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
}

// ── One watcher ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct WatchSpec {
    pub instance_id: String,
    pub game_dir: PathBuf,
    pub anchors: Vec<WatchAnchor>,
}

enum Msg {
    Fs(Vec<PathBuf>),
    Anchors(Vec<WatchAnchor>),
    Stop,
}

/// Owner of one watcher thread. Dropping it stops the thread (without waiting for it).
pub struct WatchHandle {
    tx: Sender<Msg>,
    thread: Option<JoinHandle<()>>,
    game_dir: PathBuf,
}

impl WatchHandle {
    pub fn spawn(
        spec: WatchSpec,
        procs: Arc<dyn ProcessSource>,
        sink: Arc<dyn CrashSink>,
        episodes: Arc<AtomicU32>,
        config: WatchConfig,
        clock: Arc<dyn Clock>,
    ) -> Result<Self> {
        let (tx, rx) = mpsc::channel();
        let game_dir = spec.game_dir.clone();
        let fs_tx = tx.clone();
        let name = format!("watch-{}", spec.instance_id);
        let thread = std::thread::Builder::new()
            .name(name)
            .spawn(move || {
                let mut w = WatchLoop::new(spec, procs, sink, episodes, config, clock);
                w.run(rx, fs_tx);
            })
            .map_err(|e| Error::Internal(format!("could not start the crash watcher: {e}")))?;
        Ok(Self { tx, thread: Some(thread), game_dir })
    }

    pub fn set_anchors(&self, anchors: Vec<WatchAnchor>) {
        let _ = self.tx.send(Msg::Anchors(anchors));
    }

    fn is_alive(&self) -> bool {
        self.thread.as_ref().is_some_and(|t| !t.is_finished())
    }

    /// Signal the thread to stop; does not wait.
    pub fn stop(mut self) {
        let _ = self.tx.send(Msg::Stop);
        self.thread.take();
    }

    /// Signal the thread to stop and wait for it (tests).
    pub fn stop_and_join(mut self) {
        let _ = self.tx.send(Msg::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
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
    procs: Arc<dyn ProcessSource>,
    sink: Arc<dyn CrashSink>,
    episodes: Arc<AtomicU32>,
    config: WatchConfig,
    clock: Arc<dyn Clock>,
    machine: EpisodeMachine,
    tail: LogTail,
    known_files: BTreeMap<String, LogKind>,
    pids: HashSet<u32>,
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
        episodes: Arc<AtomicU32>,
        config: WatchConfig,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let crash_dir = spec.game_dir.join(CRASH_DIR);
        let logs_dir = spec.game_dir.join(LOGS_DIR);
        let tail = LogTail::new(spec.game_dir.join("logs").join("latest.log"), spec.anchors.clone());
        let machine = EpisodeMachine::new(config.timings, config.track_processes);
        Self {
            spec,
            crash_dir,
            logs_dir,
            procs,
            sink,
            episodes,
            config,
            clock,
            machine,
            tail,
            known_files: BTreeMap::new(),
            pids: HashSet::new(),
            notify: None,
            watched: HashSet::new(),
            failed: HashSet::new(),
        }
    }

    fn run(&mut self, rx: Receiver<Msg>, fs_tx: Sender<Msg>) {
        self.notify = make_notify(fs_tx, &self.spec.instance_id);
        self.sync_watches();
        // Baseline: files and log content from before watch mode started are not new.
        self.known_files = sources::crash_file_ids(&self.spec.game_dir);
        self.tail.start_at_end();
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

    fn step(&mut self, scan_files: bool, read_log: bool, poll_procs: bool) {
        self.sync_watches();
        let mut started = Vec::new();
        let mut exited = Vec::new();
        if poll_procs && self.config.track_processes {
            let now: HashSet<u32> = process::instance_processes(&self.spec.game_dir, &*self.procs).into_iter().collect();
            started = now.difference(&self.pids).copied().collect::<Vec<_>>();
            exited = self.pids.difference(&now).copied().collect::<Vec<_>>();
            started.sort_unstable();
            exited.sort_unstable();
            self.pids = now;
        }
        let mut inputs: Vec<Input> = started.into_iter().map(Input::ProcessStarted).collect();
        if scan_files {
            let current = sources::crash_file_ids(&self.spec.game_dir);
            for (id, kind) in &current {
                if !self.known_files.contains_key(id) {
                    inputs.push(Input::FatalFile { source_id: id.clone(), kind: *kind });
                }
            }
            self.known_files = current;
        }
        if read_log {
            // Bounded: a few capped reads per step; the rest waits for the next step.
            for _ in 0..4 {
                let r = self.tail.poll();
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
        inputs.extend(exited.into_iter().map(Input::ProcessExited));
        inputs.push(Input::Tick);
        let now = self.clock.now_ms();
        for input in inputs {
            for e in self.machine.handle(input, now) {
                self.emit(e);
            }
        }
    }

    fn emit(&self, e: Emission) {
        let game_dir = &self.spec.game_dir;
        // Stat at emission time so size/mtime describe the finished file.
        let source = sources::source_for(game_dir, &e.source.id, e.source.kind)
            .unwrap_or(LogSource { id: e.source.id.clone(), kind: e.source.kind, modified_ms: 0, size: 0 });
        let episode = self.episodes.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
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
