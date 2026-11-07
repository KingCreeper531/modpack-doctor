use std::fs;
use std::path::{Path, PathBuf};

use super::*;

fn proc(pid: u32, cmd: &[&str], cwd: Option<&Path>) -> ProcInfo {
    ProcInfo {
        pid,
        name: "javaw.exe".into(),
        cmd: cmd.iter().map(|s| s.to_string()).collect(),
        cwd: cwd.map(Path::to_path_buf),
    }
}

fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let t = tempfile::tempdir().expect("tempdir");
    let game = t.path().join("Pack ü").join(".minecraft");
    let other = t.path().join("Other");
    fs::create_dir_all(&game).expect("mkdir");
    fs::create_dir_all(&other).expect("mkdir");
    (t, game, other)
}

fn pids(m: Vec<ProcMatch>) -> Vec<u32> {
    m.into_iter().map(|m| m.pid).collect()
}

#[test]
fn java_names() {
    for n in ["java", "javaw", "java.exe", "javaw.exe", "JAVAW.EXE"] {
        assert!(is_java_name(n), "{n}");
    }
    for n in ["explorer.exe", "prismlauncher", "node"] {
        assert!(!is_java_name(n), "{n}");
    }
}

#[test]
fn matches_game_dir_argument_in_both_spellings() {
    let (_t, game, other) = setup();
    let g = game.display().to_string();
    let procs = vec![
        proc(1, &["java", "-cp", "x", "net.minecraft.client.main.Main", "--gameDir", &g], Some(&other)),
        proc(2, &["java", &format!("--gameDir={g}")], None),
        proc(3, &["java", "--gameDir", &other.display().to_string()], Some(&game)),
        proc(4, &["java", "--version"], Some(&other)),
    ];
    let m = match_processes(&game, &procs, false);
    assert_eq!(pids(m.clone()), vec![1, 2]);
    assert!(m[0].reason.contains("--gameDir"), "{}", m[0].reason);
    // The working dir (where hs_err files go) is kept, also when it is not the game dir.
    assert_eq!(m[0].cwd.as_deref(), Some(other.as_path()));
    assert_eq!(m[1].cwd, None);
}

#[test]
fn same_dir_compares_like_process_paths() {
    let (_t, game, other) = setup();
    assert!(same_dir(&game, &game.join(".")));
    assert!(same_dir(&game, &other.join("..").join("Pack ü").join(".minecraft")));
    assert!(!same_dir(&game, &other));
}

#[test]
fn explicit_game_dir_elsewhere_ignores_cwd() {
    // Vanilla launcher: every profile runs in .minecraft but names its own --gameDir.
    let (_t, game, other) = setup();
    let procs = vec![proc(7, &["java", "--gameDir", &other.display().to_string()], Some(&game))];
    assert!(match_processes(&game, &procs, false).is_empty());
}

#[test]
fn relative_game_dir_resolves_against_cwd() {
    let (_t, game, _other) = setup();
    let parent = game.parent().expect("parent").to_path_buf();
    let procs = vec![proc(5, &["java", "--gameDir", "./.minecraft/"], Some(&parent))];
    assert_eq!(pids(match_processes(&game, &procs, false)), vec![5]);
}

#[test]
fn applet_target_directory() {
    let (_t, game, other) = setup();
    let arg = format!("-Dminecraft.applet.TargetDirectory={}", game.display());
    let procs = vec![proc(9, &["java", &arg, "net.minecraft.launchwrapper.Launch"], Some(&other))];
    let m = match_processes(&game, &procs, false);
    assert_eq!(pids(m.clone()), vec![9]);
    assert!(m[0].reason.contains("TargetDirectory"));
}

#[test]
fn wrapper_matched_by_cwd_game_dir_or_instance_folder() {
    let (_t, game, other) = setup();
    let instance = game.parent().expect("parent").to_path_buf();
    let procs = vec![
        proc(11, &["java", "org.prismlauncher.EntryPoint"], Some(&game)),
        proc(12, &["java", "org.multimc.EntryPoint"], Some(&instance)),
        proc(13, &["java", "org.prismlauncher.EntryPoint"], Some(&other)),
        proc(14, &[], None),
    ];
    assert_eq!(pids(match_processes(&game, &procs, false)), vec![11, 12]);
    // A game dir not named .minecraft/minecraft does not accept its parent.
    assert_eq!(pids(match_processes(&other, &[proc(15, &["java"], Some(other.parent().expect("p")))], false)), Vec::<u32>::new());
}

#[test]
fn case_folding_and_separators() {
    // Paths that don't exist are compared lexically; folding decides case sensitivity.
    let game = PathBuf::from("/Games/Prism/instances/My Pack/.minecraft");
    let procs = vec![proc(21, &["java", "--gameDir", "/games/prism/INSTANCES/my pack/.minecraft/"], None)];
    assert_eq!(pids(match_processes(&game, &procs, true)), vec![21]);
    assert!(match_processes(&game, &procs, false).is_empty());
    let dotted = vec![proc(22, &["java", "--gameDir", "/Games/Prism/instances/x/../My Pack/./.minecraft"], None)];
    assert_eq!(pids(match_processes(&game, &dotted, false)), vec![22]);
}

#[cfg(windows)]
#[test]
fn windows_backslashes_and_case_on_real_dirs() {
    let (_t, game, _other) = setup();
    let upper = game.display().to_string().to_uppercase().replace('\\', "/");
    let procs = vec![proc(31, &["javaw.exe", "--gameDir", &upper], None)];
    assert_eq!(pids(match_processes(&game, &procs, true)), vec![31]);
}

#[test]
fn fake_source_and_instance_processes() {
    let (_t, game, _other) = setup();
    let fake = FakeProcesses::default();
    assert!(instance_processes(&game, &fake).is_empty());
    fake.set(vec![proc(41, &["java"], Some(&game))]);
    assert_eq!(instance_processes(&game, &fake), vec![41]);
}

#[test]
fn game_status_reports_pids_and_reason() {
    let (_t, game, _other) = setup();
    let guard = PathGuard::new();
    guard.add_root(&game).expect("root");
    let fake = FakeProcesses::default();
    let idle = game_status(&game, &fake, &guard);
    assert!(!idle.running && idle.pids.is_empty() && idle.reason.is_none());
    fake.set(vec![proc(51, &["java", "--gameDir", &game.display().to_string()], None)]);
    let busy = game_status(&game, &fake, &guard);
    assert!(busy.running);
    assert_eq!(busy.pids, vec![51]);
    assert!(busy.reason.expect("reason").contains("pid 51"));
}

// ── Windows lock probe ───────────────────────────────────────────────────────

#[cfg(windows)]
mod lock_probe {
    use std::fs;
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use super::setup;
    use crate::guard::PathGuard;
    use crate::process::{game_status, locked_mod_jar, win_probe, FakeProcesses};

    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const FILE_SHARE_DELETE: u32 = 0x4;
    const DELETE: u32 = 0x0001_0000;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const HOLD_ENV: &str = "MPD_TEST_HOLD_JAR";
    const MARK_ENV: &str = "MPD_TEST_HOLD_MARKERS";

    /// Open `path` for reading the way the JVM's `ZipFile` does on Windows: `RandomAccessFile`
    /// → `winFileHandleOpen` (OpenJDK `io_util_md.c`) = `GENERIC_READ`,
    /// `FILE_SHARE_READ | FILE_SHARE_WRITE`, no `FILE_SHARE_DELETE`.
    fn open_like_jvm(path: &Path) -> std::io::Result<fs::File> {
        fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).open(path)
    }

    fn sharing_violation(r: std::io::Result<fs::File>) -> bool {
        matches!(r, Err(e) if e.raw_os_error() == Some(ERROR_SHARING_VIOLATION))
    }

    /// Child half of [`a_jar_held_by_another_process_is_detected`]: run as a separate process
    /// (this test binary re-executed with `--exact`), hold the jar like the JVM until released.
    /// A no-op in normal test runs.
    #[test]
    fn hold_jar_child() {
        let (Ok(jar), Ok(marks)) = (std::env::var(HOLD_ENV), std::env::var(MARK_ENV)) else { return };
        let marks = PathBuf::from(marks);
        let _held = open_like_jvm(Path::new(&jar)).expect("child: open the jar");
        fs::write(marks.join("ready"), b"1").expect("child: ready marker");
        let deadline = Instant::now() + Duration::from_secs(60);
        while !marks.join("release").exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    struct Holder {
        child: Child,
        marks: PathBuf,
    }

    impl Holder {
        fn spawn(jar: &Path, marks: &Path) -> Self {
            fs::create_dir_all(marks).expect("markers dir");
            let exe = std::env::current_exe().expect("test exe");
            let child = Command::new(exe)
                .args(["--exact", "process::tests::lock_probe::hold_jar_child", "--test-threads=1"])
                .env(HOLD_ENV, jar)
                .env(MARK_ENV, marks)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn the holder");
            let deadline = Instant::now() + Duration::from_secs(30);
            while !marks.join("ready").exists() {
                assert!(Instant::now() < deadline, "the holder process never opened the jar");
                std::thread::sleep(Duration::from_millis(20));
            }
            Self { child, marks: marks.to_path_buf() }
        }

        fn release(mut self) {
            fs::write(self.marks.join("release"), b"1").expect("release marker");
            let _ = self.child.wait();
        }
    }

    impl Drop for Holder {
        fn drop(&mut self) {
            let _ = fs::write(self.marks.join("release"), b"1");
        }
    }

    fn game_with_jars() -> (tempfile::TempDir, PathBuf, PathBuf, PathGuard) {
        let (t, game, _other) = setup();
        fs::create_dir_all(game.join("mods")).expect("mods");
        fs::write(game.join("mods").join("a.jar"), b"jar").expect("jar");
        fs::write(game.join("mods").join("b.jar"), b"jar").expect("jar");
        let guard = PathGuard::new();
        guard.add_root(&game).expect("root");
        let marks = t.path().join("markers");
        (t, game, marks, guard)
    }

    #[test]
    fn a_jar_held_by_another_process_is_detected() {
        let (_t, game, marks, guard) = game_with_jars();
        let jar = game.join("mods").join("a.jar");
        assert_eq!(locked_mod_jar(&game, &guard), None, "nobody holds it yet");
        // Our own handles never count (the scanner may have a jar open).
        let own = open_like_jvm(&jar).expect("own handle");
        assert_eq!(locked_mod_jar(&game, &guard), None);
        drop(own);

        let holder = Holder::spawn(&jar, &marks);
        let pid = holder.child.id();
        let reason = locked_mod_jar(&game, &guard).expect("detected");
        assert!(reason.contains("mods/a.jar") && reason.contains(&format!("pid {pid}")), "{reason}");
        let status = game_status(&game, &FakeProcesses::default(), &guard);
        assert!(status.running && status.pids.is_empty(), "{status:?}");
        assert!(status.reason.expect("reason").contains("mods/a.jar"));

        // While the probe's handle is open, nobody is blocked: the JVM-style open, a
        // read-only-sharing open and an open requesting delete access all succeed.
        let probe = win_probe::open_probe(&jar).expect("probe handle");
        assert!(win_probe::holders(&probe).expect("holders").contains(&pid));
        open_like_jvm(&jar).expect("JVM-style open while probing");
        fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(&jar).expect("FILE_SHARE_READ open while probing");
        holder.release();
        assert_eq!(locked_mod_jar(&game, &guard), None, "released");
        fs::OpenOptions::new().read(true).share_mode(0).open(&jar).expect("exclusive open while probing");
        fs::OpenOptions::new().access_mode(DELETE).share_mode(0).open(&jar).expect("delete open while probing");
        drop(probe);
    }

    #[test]
    fn the_probe_opens_even_against_an_exclusive_holder() {
        let (_t, game, _marks, _guard) = game_with_jars();
        let jar = game.join("mods").join("a.jar");
        let _exclusive = fs::OpenOptions::new().read(true).share_mode(0).open(&jar).expect("exclusive");
        let probe = win_probe::open_probe(&jar).expect("attribute-only open is never a sharing violation");
        assert!(win_probe::holders(&probe).expect("holders").contains(&std::process::id()));
    }

    /// Why the probe does not request `DELETE` access: such a handle (even with full sharing)
    /// makes a JVM-style open fail for as long as it is open.
    #[test]
    fn a_delete_access_probe_would_block_the_jvm() {
        let (_t, game, _marks, _guard) = game_with_jars();
        let jar = game.join("mods").join("a.jar");
        let share_all = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        let delete_probe = fs::OpenOptions::new().access_mode(DELETE).share_mode(share_all).open(&jar).expect("probe");
        assert!(sharing_violation(open_like_jvm(&jar)));
        assert!(sharing_violation(fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(&jar)));
        // Only openers that themselves share delete (java.nio channels) get through.
        fs::OpenOptions::new().read(true).share_mode(share_all).open(&jar).expect("nio-style open");
        drop(delete_probe);
        // And it detects a JVM-style holder only through the same conflict.
        let held = open_like_jvm(&jar).expect("held");
        assert!(sharing_violation(fs::OpenOptions::new().access_mode(DELETE).share_mode(share_all).open(&jar)));
        drop(held);
    }
}

#[test]
fn sysinfo_source_lists_only_java() {
    // Smoke test against the real OS: whatever it returns must be Java processes.
    let src = SysinfoSource::new();
    for p in src.java_processes() {
        assert!(is_java_name(&p.name), "{}", p.name);
    }
}
