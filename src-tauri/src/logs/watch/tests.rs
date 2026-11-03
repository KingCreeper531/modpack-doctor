//! Real `notify` watchers on temp dirs, a fake process source and a channel sink. Timings are
//! shortened, and every wait is generous so slow CI machines still pass.

use std::fs;
use std::io::Write;
use std::sync::mpsc::{channel, Receiver};

use super::*;
use crate::model::CrashTrigger;
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
        timings: EpisodeTimings { settle_ms: 300, max_coalesce_ms: 2_000, context_window_ms: 3_000, quiet_ms: 5_000 },
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
        let spec = WatchSpec { instance_id: "0123456789abcdef".into(), game_dir: game.clone(), anchors: anchors() };
        let handle = WatchHandle::spawn(
            spec,
            procs.clone(),
            Arc::new(ChannelSink(Mutex::new(tx))),
            Arc::new(AtomicU32::new(0)),
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
    watchers.start("aaaaaaaaaaaaaaaa", t.path(), anchors(), procs.clone(), sink.clone()).expect("start");
    watchers.start("aaaaaaaaaaaaaaaa", t.path(), Vec::new(), procs.clone(), sink.clone()).expect("update");
    watchers.start("bbbbbbbbbbbbbbbb", t.path(), anchors(), procs, sink).expect("start b");
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
