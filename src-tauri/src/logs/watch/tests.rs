//! Real `notify` watchers on temp dirs, a fake process source and a channel sink. Timings are
//! shortened, and every wait is generous so slow CI machines still pass.

use std::fs;
use std::io::Write;
use std::sync::mpsc::{channel, Receiver};

use super::*;
use crate::model::{CrashTrigger, FATAL_SETTLE_MS};
use crate::process::{FakeProcesses, ProcInfo};

const WAIT: Duration = Duration::from_secs(15);

struct ChannelSink(Mutex<Sender<CrashDetected>>);

impl CrashSink for ChannelSink {
    fn crash_detected(&self, event: CrashDetected) {
        let _ = self.0.lock().expect("sink").send(event);
    }
}

fn fast() -> WatchConfig {
    WatchConfig {
        poll_interval: Duration::from_millis(50),
        debounce: Duration::from_millis(20),
        rescan_interval: Duration::from_millis(500),
        timings: EpisodeTimings {
            settle_ms: 300,
            max_coalesce_ms: 2_000,
            context_window_ms: 3_000,
            quiet_ms: 5_000,
            exit_grace_ms: 1_000,
        },
        track_processes: true,
    }
}

fn anchors() -> Vec<WatchAnchor> {
    vec![
        WatchAnchor { text: "Incompatible mods found!".into(), tier: AnchorTier::Fatal },
        WatchAnchor { text: "Caused by:".into(), tier: AnchorTier::Contextual },
    ]
}

struct Fixture {
    _t: tempfile::TempDir,
    game: PathBuf,
    procs: Arc<FakeProcesses>,
    rx: Receiver<CrashDetected>,
    handle: Option<WatchHandle>,
}

impl Fixture {
    fn start(prepare: impl FnOnce(&Path)) -> Self {
        let t = tempfile::tempdir().expect("tempdir");
        let game = dunce::canonicalize(t.path()).expect("canon").join("Pack");
        fs::create_dir_all(&game).expect("mkdir");
        prepare(&game);
        let procs = Arc::new(FakeProcesses::default());
        let (tx, rx) = channel();
        let spec = WatchSpec {
            instance_id: "0123456789abcdef".into(),
            game_dir: game.clone(),
            guard: guard_for(&[&game]),
            anchors: anchors(),
        };
        let handle = WatchHandle::spawn(
            spec,
            procs.clone(),
            Arc::new(ChannelSink(Mutex::new(tx))),
            WatchShared::default(),
            fast(),
            Arc::new(MonotonicClock::default()),
        )
        .expect("spawn");
        // Let the watcher take its baseline before the test changes anything.
        std::thread::sleep(Duration::from_millis(300));
        Self { _t: t, game, procs, rx, handle: Some(handle) }
    }

    fn game_proc(&self, pid: u32) -> ProcInfo {
        ProcInfo { pid, name: "javaw.exe".into(), cmd: vec!["javaw.exe".into(), "--gameDir".into(), self.game.display().to_string()], cwd: None }
    }

    fn append_log(&self, text: &str) {
        let mut f = fs::OpenOptions::new().create(true).append(true).open(self.game.join("logs/latest.log")).expect("open log");
        f.write_all(text.as_bytes()).expect("write log");
    }

    fn next(&self) -> CrashDetected {
        self.rx.recv_timeout(WAIT).expect("a CrashDetected event")
    }

    fn assert_quiet(&self, d: Duration) {
        if let Ok(e) = self.rx.recv_timeout(d) {
            panic!("unexpected extra event: {e:?}");
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(h) = self.handle.take() {
            h.stop_and_join();
        }
    }
}

#[test]
fn new_crash_report_emits_one_event() {
    let f = Fixture::start(|g| {
        // Old reports from before watch mode are not new.
        fs::create_dir_all(g.join("crash-reports")).expect("mkdir");
        fs::write(g.join("crash-reports/crash-old.txt"), "old").expect("old");
    });
    fs::write(f.game.join("crash-reports/crash-2026-11-03_12.00.00-client.txt"), "---- Minecraft Crash Report ----\n")
        .expect("write");
    let e = f.next();
    assert_eq!(e.instance_id, "0123456789abcdef");
    assert_eq!(e.episode, 1);
    assert_eq!(e.source.id, "crash-reports/crash-2026-11-03_12.00.00-client.txt");
    assert_eq!(e.source.kind, LogKind::CrashReport);
    assert!(e.source.size > 0);
    assert_eq!(
        e.triggers,
        vec![CrashTrigger::NewCrashReport { source_id: "crash-reports/crash-2026-11-03_12.00.00-client.txt".into() }]
    );
    f.assert_quiet(Duration::from_millis(1_500));
}

#[test]
fn crash_reports_folder_created_later_is_picked_up() {
    let f = Fixture::start(|_| {});
    fs::create_dir_all(f.game.join("crash-reports")).expect("mkdir");
    std::thread::sleep(Duration::from_millis(200));
    fs::write(f.game.join("crash-reports/crash-new-fml.txt"), "fml").expect("write");
    let e = f.next();
    assert_eq!(e.source.id, "crash-reports/crash-new-fml.txt");
}

#[test]
fn fatal_line_in_latest_log_then_exit_emits_one_event() {
    let f = Fixture::start(|g| {
        fs::create_dir_all(g.join("logs")).expect("mkdir");
        // A fatal line from a previous run must not count.
        fs::write(g.join("logs/latest.log"), "[old] Incompatible mods found!\n").expect("old log");
    });
    f.procs.set(vec![f.game_proc(4321)]);
    std::thread::sleep(Duration::from_millis(300));
    f.append_log("[main/INFO]: Loading 212 mods\n[main/ERROR]: Incompatible mods found!\n");
    f.procs.set(Vec::new());
    let e = f.next();
    assert_eq!(e.source.id, "logs/latest.log");
    assert_eq!(e.source.kind, LogKind::LatestLog);
    assert_eq!(
        e.triggers.first(),
        Some(&CrashTrigger::LogAnchor { anchor: "Incompatible mods found!".into(), tier: AnchorTier::Fatal, line: 3 })
    );
    f.assert_quiet(Duration::from_millis(1_500));
}

#[test]
fn contextual_lines_and_a_late_normal_quit_emit_nothing() {
    let f = Fixture::start(|g| {
        fs::create_dir_all(g.join("logs")).expect("mkdir");
    });
    f.procs.set(vec![f.game_proc(99)]);
    std::thread::sleep(Duration::from_millis(300));
    f.append_log("Caused by: java.lang.ClassNotFoundException: optional.Integration\n");
    // Quit after the (shortened, 3 s) context window.
    std::thread::sleep(Duration::from_millis(3_600));
    f.procs.set(Vec::new());
    f.assert_quiet(Duration::from_millis(1_500));
}

#[test]
fn contextual_line_then_exit_within_window_emits_one_event() {
    let f = Fixture::start(|g| {
        fs::create_dir_all(g.join("logs")).expect("mkdir");
    });
    f.procs.set(vec![f.game_proc(7)]);
    std::thread::sleep(Duration::from_millis(300));
    f.append_log("Exception in thread \"Render thread\"\nCaused by: java.lang.NoSuchMethodError: x\n");
    std::thread::sleep(Duration::from_millis(300));
    f.procs.set(Vec::new());
    let e = f.next();
    assert_eq!(e.source.id, "logs/latest.log");
    assert_eq!(e.triggers.last(), Some(&CrashTrigger::ProcessExit { pid: 7 }));
    f.assert_quiet(Duration::from_millis(1_000));
}

#[test]
fn registry_starts_updates_and_stops() {
    let t = tempfile::tempdir().expect("tempdir");
    let watchers = Watchers::with_config(fast());
    let procs: Arc<dyn ProcessSource> = Arc::new(FakeProcesses::default());
    let (tx, _rx) = channel();
    let sink: Arc<dyn CrashSink> = Arc::new(ChannelSink(Mutex::new(tx)));
    let g = guard_for(&[t.path()]);
    watchers.start("aaaaaaaaaaaaaaaa", t.path(), g.clone(), anchors(), procs.clone(), sink.clone()).expect("start");
    watchers.start("aaaaaaaaaaaaaaaa", t.path(), g.clone(), Vec::new(), procs.clone(), sink.clone()).expect("update");
    watchers.start("bbbbbbbbbbbbbbbb", t.path(), g, anchors(), procs, sink).expect("start b");
    assert_eq!(watchers.ids(), vec!["aaaaaaaaaaaaaaaa".to_string(), "bbbbbbbbbbbbbbbb".to_string()]);
    assert!(watchers.stop("aaaaaaaaaaaaaaaa"));
    assert!(!watchers.stop("aaaaaaaaaaaaaaaa"));
    watchers.stop_all();
    assert!(watchers.ids().is_empty());
}

#[test]
fn anchors_are_validated() {
    let many = vec![WatchAnchor { text: "x".into(), tier: AnchorTier::Fatal }; MAX_ANCHORS + 1];
    assert!(sanitize_anchors(many).is_err());
    let long = vec![WatchAnchor { text: "y".repeat(MAX_ANCHOR_CHARS + 1), tier: AnchorTier::Fatal }];
    assert!(sanitize_anchors(long).is_err());
    assert_eq!(sanitize_anchors(anchors()).expect("ok").len(), 2);
}

fn guard_for(roots: &[&Path]) -> Arc<PathGuard> {
    let g = PathGuard::new();
    for r in roots {
        g.add_root(r).expect("root");
    }
    Arc::new(g)
}

/// The registry: a replaced or stopped watcher emits nothing more, and takes no episode number.
#[test]
fn replaced_and_stopped_watchers_emit_nothing() {
    let t = tempfile::tempdir().expect("tempdir");
    let base = dunce::canonicalize(t.path()).expect("canon");
    let (old_dir, new_dir) = (base.join("Old"), base.join("New"));
    for d in [&old_dir, &new_dir] {
        fs::create_dir_all(d.join("crash-reports")).expect("mkdir");
    }
    let watchers = Watchers::with_config(fast());
    let procs: Arc<dyn ProcessSource> = Arc::new(FakeProcesses::default());
    let (tx, rx) = channel();
    let sink: Arc<dyn CrashSink> = Arc::new(ChannelSink(Mutex::new(tx)));
    let g = guard_for(&[&old_dir, &new_dir]);
    let id = "cccccccccccccccc";
    watchers.start(id, &old_dir, g.clone(), anchors(), procs.clone(), sink.clone()).expect("start");
    std::thread::sleep(Duration::from_millis(300));
    // The instance moved: the watcher is replaced.
    watchers.start(id, &new_dir, g, anchors(), procs, sink).expect("replace");
    std::thread::sleep(Duration::from_millis(300));
    fs::write(old_dir.join("crash-reports/crash-old-client.txt"), "x").expect("write");
    fs::write(new_dir.join("crash-reports/crash-new-client.txt"), "x").expect("write");
    let e = rx.recv_timeout(WAIT).expect("event from the new watcher");
    assert_eq!(e.source.id, "crash-reports/crash-new-client.txt");
    assert_eq!(e.episode, 1, "the old watcher took no episode number");
    if let Ok(extra) = rx.recv_timeout(Duration::from_millis(1_500)) {
        panic!("the replaced watcher emitted: {extra:?}");
    }
    assert!(watchers.stop(id));
    fs::write(new_dir.join("crash-reports/crash-after-stop-client.txt"), "x").expect("write");
    if let Ok(extra) = rx.recv_timeout(Duration::from_millis(1_500)) {
        panic!("a stopped watcher emitted: {extra:?}");
    }
}

// ── Step-driven (no threads, no notify, injected clock) ─────────────────────

#[derive(Default)]
struct ManualClock(std::sync::atomic::AtomicU64);

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// A [`WatchLoop`] driven step by step: `base/Pack` is the game dir, `base/.minecraft` the
/// launcher's working dir; both are guard roots.
struct Stepper {
    _t: tempfile::TempDir,
    base: PathBuf,
    game: PathBuf,
    mc: PathBuf,
    procs: Arc<FakeProcesses>,
    clock: Arc<ManualClock>,
    shared: WatchShared,
    active: Arc<Mutex<bool>>,
    rx: Receiver<CrashDetected>,
    w: WatchLoop,
}

impl Stepper {
    fn new(prepare: impl FnOnce(&Path, &Path)) -> Self {
        let t = tempfile::tempdir().expect("tempdir");
        let base = dunce::canonicalize(t.path()).expect("canon");
        let game = base.join("Pack");
        let mc = base.join(".minecraft");
        fs::create_dir_all(game.join("logs")).expect("mkdir");
        fs::create_dir_all(game.join("crash-reports")).expect("mkdir");
        fs::create_dir_all(&mc).expect("mkdir");
        prepare(&base, &game);
        let procs = Arc::new(FakeProcesses::default());
        let clock = Arc::new(ManualClock::default());
        let shared = WatchShared::default();
        let active = Arc::new(Mutex::new(true));
        let (tx, rx) = channel();
        let spec = WatchSpec {
            instance_id: "0123456789abcdef".into(),
            game_dir: game.clone(),
            guard: guard_for(&[&game, &mc]),
            anchors: anchors(),
        };
        let mut w = WatchLoop::new(
            spec,
            procs.clone(),
            Arc::new(ChannelSink(Mutex::new(tx))),
            shared.clone(),
            active.clone(),
            WatchConfig::default(),
            clock.clone(),
        );
        w.take_baseline();
        Self { _t: t, base, game, mc, procs, clock, shared, active, rx, w }
    }

    /// The game process: `--gameDir <game>`, running in `cwd`.
    fn run_game(&self, pid: u32, cwd: &Path) {
        self.procs.set(vec![ProcInfo {
            pid,
            name: "javaw.exe".into(),
            cmd: vec!["javaw.exe".into(), "--gameDir".into(), self.game.display().to_string()],
            cwd: Some(cwd.to_path_buf()),
        }]);
    }

    fn append_log(&self, text: &str) {
        let mut f = fs::OpenOptions::new().create(true).append(true).open(self.game.join("logs/latest.log")).expect("open");
        f.write_all(text.as_bytes()).expect("write");
    }

    /// Advance the clock and run one poll step (processes and log; files only if forced).
    fn step(&mut self, advance_ms: u64, scan_files: bool) -> Vec<CrashDetected> {
        self.clock.0.fetch_add(advance_ms, Ordering::SeqCst);
        self.w.step(scan_files, true, true);
        self.rx.try_iter().collect()
    }
}

#[test]
fn hs_err_in_the_launcher_working_dir_is_reported_on_exit() {
    let mut s = Stepper::new(|_, _| {});
    let mc = s.mc.clone();
    s.run_game(4242, &mc);
    assert!(s.step(0, true).is_empty());
    assert_eq!(s.shared.cwds.get("0123456789abcdef"), vec![(4242, mc.clone())]);
    // A native crash: the JVM writes hs_err into its working dir, then dies.
    fs::write(mc.join("hs_err_pid4242.log"), "#\n# A fatal error has been detected by the Java Runtime Environment:\n")
        .expect("hs_err");
    fs::write(mc.join("hs_err_pid9999.log"), "another process\n").expect("other");
    s.procs.set(Vec::new());
    let out = s.step(1_000, false);
    assert_eq!(out.len(), 1, "{out:?}");
    let e = &out[0];
    assert_eq!(e.source.id, "@cwd/hs_err_pid4242.log");
    assert_eq!(e.source.kind, LogKind::HsErr);
    assert!(e.source.size > 0 && e.source.modified_ms > 0);
    assert_eq!(
        e.triggers,
        vec![
            CrashTrigger::NewHsErr { source_id: "@cwd/hs_err_pid4242.log".into() },
            CrashTrigger::ProcessExit { pid: 4242 },
        ]
    );
    assert!(s.step(10_000, true).is_empty());
}

#[test]
fn hs_err_written_just_after_the_exit_is_still_found() {
    let mut s = Stepper::new(|_, _| {});
    let mc = s.mc.clone();
    s.run_game(7, &mc);
    s.step(0, true);
    s.procs.set(Vec::new());
    assert!(s.step(1_000, false).is_empty(), "a quit without hs_err is normal so far");
    fs::write(mc.join("hs_err_pid7.log"), "# A fatal error\n").expect("hs_err");
    assert!(s.step(1_000, false).is_empty(), "settling");
    let out = s.step(FATAL_SETTLE_MS, false);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].source.id, "@cwd/hs_err_pid7.log");
}

#[test]
fn hs_err_in_a_working_dir_outside_the_roots_is_ignored() {
    let mut s = Stepper::new(|base, _| fs::create_dir_all(base.join("Unscoped")).expect("mkdir"));
    let unscoped = s.base.join("Unscoped");
    s.run_game(8, &unscoped);
    s.step(0, true);
    fs::write(unscoped.join("hs_err_pid8.log"), "# A fatal error\n").expect("hs_err");
    s.procs.set(Vec::new());
    assert!(s.step(1_000, false).is_empty());
    assert!(s.step(10_000, true).is_empty());
}

/// Review finding 5: the exit step re-lists the crash files, so the crash report written just
/// before the exit is the source (not latest.log).
#[test]
fn exit_and_a_late_crash_report_in_one_step_make_the_report_the_source() {
    let mut s = Stepper::new(|_, _| {});
    let game = s.game.clone();
    s.run_game(5, &game);
    s.step(0, true);
    s.append_log("Caused by: java.lang.IllegalStateException: boom\n");
    assert!(s.step(1_000, false).is_empty());
    fs::write(game.join("crash-reports/crash-2026-11-03_12.00.00-client.txt"), "---- Minecraft Crash Report ----\n")
        .expect("report");
    s.procs.set(Vec::new());
    // No notify event and no rescan due: only the exit.
    let out = s.step(1_000, false);
    assert_eq!(out.len(), 1, "{out:?}");
    assert_eq!(out[0].source.id, "crash-reports/crash-2026-11-03_12.00.00-client.txt");
    assert_eq!(out[0].source.kind, LogKind::CrashReport);
    assert_eq!(out[0].triggers.last(), Some(&CrashTrigger::ProcessExit { pid: 5 }));
}

#[test]
fn other_txt_files_in_crash_reports_are_not_crashes() {
    let mut s = Stepper::new(|_, _| {});
    fs::write(s.game.join("crash-reports/readme.txt"), "not a crash").expect("write");
    assert!(s.step(1_000, true).is_empty());
    assert!(s.step(FATAL_SETTLE_MS + 1_000, true).is_empty());
}

/// Review finding 4, through the watcher: lines read before the process is first seen count.
#[test]
fn log_lines_before_the_first_process_sighting_count() {
    let mut s = Stepper::new(|_, _| {});
    s.append_log("Caused by: java.lang.NoSuchMethodError: x\n");
    assert!(s.step(500, false).is_empty());
    let game = s.game.clone();
    s.run_game(11, &game);
    assert!(s.step(500, false).is_empty());
    s.procs.set(Vec::new());
    let out = s.step(1_000, false);
    assert_eq!(out.len(), 1, "{out:?}");
    assert_eq!(out[0].source.id, "logs/latest.log");
}

/// Review finding 9: a `latest.log` symlink that resolves outside every root is not read.
#[test]
fn latest_log_symlink_escaping_the_roots_is_not_tailed() {
    let mut made = Ok(());
    let mut s = Stepper::new(|base, game| {
        let outside = base.join("outside.log");
        fs::write(&outside, "start\n").expect("outside");
        #[cfg(windows)]
        {
            made = std::os::windows::fs::symlink_file(&outside, game.join("logs/latest.log"));
        }
        #[cfg(unix)]
        {
            made = std::os::unix::fs::symlink(&outside, game.join("logs/latest.log"));
        }
    });
    if made.is_err() {
        eprintln!("skipped: creating symlinks needs a privilege here");
        return;
    }
    let game = s.game.clone();
    s.run_game(3, &game);
    s.step(0, true);
    let mut f = fs::OpenOptions::new().append(true).open(s.base.join("outside.log")).expect("open");
    f.write_all(b"[main/ERROR]: Incompatible mods found!\nCaused by: x\n").expect("write");
    drop(f);
    assert!(s.step(500, false).is_empty());
    assert!(s.step(FATAL_SETTLE_MS + 500, false).is_empty());
    s.procs.set(Vec::new());
    assert!(s.step(500, false).is_empty(), "nothing was read, so the exit is a normal quit");
}

/// Review finding 17, at the emission gate: a deactivated watcher emits nothing and takes no
/// episode number, even if its thread still finishes a step.
#[test]
fn a_deactivated_watcher_emits_nothing() {
    let mut s = Stepper::new(|_, _| {});
    *s.active.lock().expect("active") = false;
    fs::write(s.game.join("crash-reports/crash-2026-11-03_12.00.00-client.txt"), "x").expect("write");
    assert!(s.step(0, true).is_empty());
    assert!(s.step(FATAL_SETTLE_MS + 1, true).is_empty());
    assert_eq!(s.shared.episodes.load(Ordering::SeqCst), 0);
}
