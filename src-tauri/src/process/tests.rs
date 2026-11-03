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

#[cfg(windows)]
#[test]
fn locked_jar_is_reported_on_windows() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_t, game, _other) = setup();
    fs::create_dir_all(game.join("mods")).expect("mods");
    fs::write(game.join("mods").join("a.jar"), b"jar").expect("jar");
    fs::write(game.join("mods").join("b.jar"), b"jar").expect("jar");
    let guard = PathGuard::new();
    guard.add_root(&game).expect("root");
    assert_eq!(locked_mod_jar(&game, &guard), None);
    // Hold it the way the JVM does (shared read), which blocks an exclusive open.
    let _held = fs::OpenOptions::new().read(true).share_mode(1).open(game.join("mods").join("a.jar")).expect("open");
    let reason = locked_mod_jar(&game, &guard).expect("locked");
    assert!(reason.contains("mods/a.jar"), "{reason}");
    let status = game_status(&game, &FakeProcesses::default(), &guard);
    assert!(status.running && status.pids.is_empty());
}

#[test]
fn sysinfo_source_lists_only_java() {
    // Smoke test against the real OS: whatever it returns must be Java processes.
    let src = SysinfoSource::new();
    for p in src.java_processes() {
        assert!(is_java_name(&p.name), "{}", p.name);
    }
}
