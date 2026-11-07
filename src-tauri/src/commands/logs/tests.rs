use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::discovery::{self, Discovered, Os};
use crate::logs::episode::EpisodeTimings;
use crate::logs::watch::{WatchConfig, Watchers};
use crate::model::{
    AnchorTier, CrashDetected, DiscoveryReport, Instance, MetadataSource, PackOverride, Side, WatchAnchor,
};
use crate::process::{FakeProcesses, ProcInfo, Processes};

struct ChannelSink(Mutex<Sender<CrashDetected>>);

impl CrashSink for ChannelSink {
    fn crash_detected(&self, event: CrashDetected) {
        let _ = self.0.lock().expect("sink").send(event);
    }
}

fn instance(launcher: Launcher, dir: &Path) -> Instance {
    Instance {
        id: discovery::instance_id(dir, Os::current()),
        name: "Pack".into(),
        launcher,
        root: dir.display().to_string(),
        game_dir: dir.display().to_string(),
        mc_version: None,
        loader: None,
        side: Side::Client,
        metadata_source: MetadataSource::Inferred,
        mod_count: 0,
    }
}

struct Fx {
    _t: tempfile::TempDir,
    st: AppState,
    fake: Arc<FakeProcesses>,
    manual: Instance,
    prism: Instance,
}

fn fixture() -> Fx {
    let t = tempfile::tempdir().expect("tempdir");
    let base = dunce::canonicalize(t.path()).expect("canon");
    let manual_dir = base.join("Manual Pack");
    let prism_dir = base.join("Prism Pack");
    for d in [&manual_dir, &prism_dir] {
        fs::create_dir_all(d.join("logs")).expect("mkdir");
        fs::write(d.join("logs/latest.log"), "[main/INFO]: hello\n").expect("log");
    }
    let fake = Arc::new(FakeProcesses::default());
    let config = WatchConfig {
        poll_interval: Duration::from_millis(50),
        debounce: Duration::from_millis(20),
        rescan_interval: Duration::from_millis(300),
        timings: EpisodeTimings {
            settle_ms: 200,
            max_coalesce_ms: 1_000,
            context_window_ms: 2_000,
            quiet_ms: 5_000,
            exit_grace_ms: 1_000,
        },
        track_processes: true,
    };
    let st = AppState {
        processes: Processes(fake.clone()),
        watchers: Arc::new(Watchers::with_config(config)),
        ..AppState::default()
    };
    let manual = instance(Launcher::Manual, &manual_dir);
    let prism = instance(Launcher::Prism, &prism_dir);
    st.settings
        .update(|s| {
            s.manual_folders.push(manual_dir.display().to_string());
            Ok(())
        })
        .expect("settings");
    let instances = vec![manual.clone(), prism.clone()];
    let mut roots: Vec<PathBuf> = Vec::new();
    for i in &instances {
        roots.extend(discovery::guard_roots(Path::new(&i.root), Path::new(&i.game_dir)));
    }
    st.apply_discovery(Discovered { report: DiscoveryReport { instances, probes: Vec::new() }, roots }).expect("apply");
    Fx { _t: t, st, fake, manual, prism }
}

fn anchors() -> Vec<WatchAnchor> {
    vec![WatchAnchor { text: "Incompatible mods found!".into(), tier: AnchorTier::Fatal }]
}

fn sink() -> (Arc<dyn CrashSink>, std::sync::mpsc::Receiver<CrashDetected>) {
    let (tx, rx) = channel();
    (Arc::new(ChannelSink(Mutex::new(tx))), rx)
}

#[test]
fn set_watch_persists_and_stops() {
    let fx = fixture();
    let (s, _rx) = sink();
    enable_watch(&fx.st, &fx.prism.id, anchors(), s.clone()).expect("enable");
    enable_watch(&fx.st, &fx.prism.id, anchors(), s.clone()).expect("re-arm");
    assert_eq!(fx.st.settings.get().watched, vec![fx.prism.id.clone()]);
    assert!(fx.st.watchers.is_watching(&fx.prism.id));

    disable_watch(&fx.st, &fx.prism.id).expect("disable");
    assert!(fx.st.settings.get().watched.is_empty());
    assert!(!fx.st.watchers.is_watching(&fx.prism.id));

    // Unknown ids: enabling fails readably, disabling always clears.
    let err = enable_watch(&fx.st, "ffffffffffffffff", anchors(), s).expect_err("unknown");
    assert!(matches!(err, Error::NotFound { .. }), "{err}");
    fx.st
        .settings
        .update(|s| {
            s.watched.push("ffffffffffffffff".into());
            Ok(())
        })
        .expect("stale");
    disable_watch(&fx.st, "ffffffffffffffff").expect("disable stale");
    assert!(fx.st.settings.get().watched.is_empty());
}

#[test]
fn watching_through_state_emits_for_a_fatal_line() {
    let fx = fixture();
    let (s, rx) = sink();
    enable_watch(&fx.st, &fx.prism.id, anchors(), s).expect("enable");
    std::thread::sleep(Duration::from_millis(300));
    let log = PathBuf::from(&fx.prism.game_dir).join("logs/latest.log");
    let mut body = fs::read_to_string(&log).expect("read");
    body.push_str("[main/ERROR]: Incompatible mods found!\n");
    fs::write(&log, body).expect("append");
    let e = rx.recv_timeout(Duration::from_secs(15)).expect("event");
    assert_eq!(e.instance_id, fx.prism.id);
    assert_eq!(e.source.id, "logs/latest.log");
    fx.st.watchers.stop_all();
}

#[test]
fn remove_manual_instance_cleans_watched_and_overrides() {
    let fx = fixture();
    let (s, _rx) = sink();
    enable_watch(&fx.st, &fx.manual.id, anchors(), s.clone()).expect("enable manual");
    enable_watch(&fx.st, &fx.prism.id, anchors(), s).expect("enable prism");
    fx.st
        .settings
        .update(|s| {
            for id in [&fx.manual.id, &fx.prism.id] {
                s.overrides.insert(id.clone(), PackOverride { mc_version: Some("1.20.1".into()), loader: None, side: None });
            }
            Ok(())
        })
        .expect("overrides");

    remove_manual_and_forget(&fx.st, &fx.manual.id).expect("remove");
    let settings = fx.st.settings.get();
    assert_eq!(settings.watched, vec![fx.prism.id.clone()]);
    assert_eq!(settings.overrides.keys().cloned().collect::<Vec<_>>(), vec![fx.prism.id.clone()]);
    assert!(settings.manual_folders.is_empty());
    assert!(!fx.st.watchers.is_watching(&fx.manual.id));
    assert!(fx.st.watchers.is_watching(&fx.prism.id));

    // A launcher instance cannot be removed, and nothing is forgotten for it.
    assert!(remove_manual_and_forget(&fx.st, &fx.prism.id).is_err());
    assert_eq!(fx.st.settings.get().watched, vec![fx.prism.id.clone()]);
    fx.st.watchers.stop_all();
}

#[test]
fn log_commands_go_through_the_registry() {
    let fx = fixture();
    let list = list_sources_blocking(&fx.st, &fx.prism.id).expect("list");
    assert_eq!(list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["logs/latest.log"]);
    let d = read_digest_blocking(&fx.st, &fx.prism.id, "logs/latest.log", &[], None).expect("digest");
    assert_eq!(d.total_lines, 1);
    assert!(matches!(
        read_digest_blocking(&fx.st, &fx.prism.id, "../Manual Pack/logs/latest.log", &[], None),
        Err(Error::OutsideScope { .. })
    ));
    assert!(matches!(list_sources_blocking(&fx.st, "0000000000000000"), Err(Error::NotFound { .. })));
}

#[test]
fn game_running_uses_the_shared_process_source() {
    let fx = fixture();
    let idle = game_status_blocking(&fx.st, &fx.prism.id).expect("status");
    assert!(!idle.running);
    fx.fake.set(vec![ProcInfo {
        pid: 1234,
        name: "javaw.exe".into(),
        cmd: vec!["javaw.exe".into(), "--gameDir".into(), fx.prism.game_dir.clone()],
        cwd: None,
    }]);
    let busy = game_status_blocking(&fx.st, &fx.prism.id).expect("status");
    assert!(busy.running);
    assert_eq!(busy.pids, vec![1234]);
    assert!(busy.reason.expect("reason").contains("--gameDir"));
    assert!(!game_status_blocking(&fx.st, &fx.manual.id).expect("other").running);
}

// ── hs_err in the JVM working dir (vanilla launcher) ─────────────────────────

struct VanillaFx {
    _t: tempfile::TempDir,
    st: AppState,
    fake: Arc<FakeProcesses>,
    mc_dir: PathBuf,
    mc: Instance,
    profile: Instance,
}

/// `.minecraft` (the launcher's working dir, also the instance of profiles without a gameDir)
/// and a profile with its own game dir, both discovered as vanilla instances.
fn vanilla_fixture() -> VanillaFx {
    let t = tempfile::tempdir().expect("tempdir");
    let base = dunce::canonicalize(t.path()).expect("canon");
    let mc_dir = base.join(".minecraft");
    let profile_dir = base.join("Profiles").join("Modded 1.20.1");
    for d in [&mc_dir, &profile_dir] {
        fs::create_dir_all(d.join("logs")).expect("mkdir");
        fs::write(d.join("logs/latest.log"), "[main/INFO]: hello\n").expect("log");
    }
    fs::write(mc_dir.join("launcher_profiles.json"), "{\"profiles\":{}}").expect("profiles");
    let fake = Arc::new(FakeProcesses::default());
    let config = WatchConfig {
        poll_interval: Duration::from_millis(50),
        debounce: Duration::from_millis(20),
        rescan_interval: Duration::from_millis(300),
        timings: EpisodeTimings {
            settle_ms: 200,
            max_coalesce_ms: 1_000,
            context_window_ms: 2_000,
            quiet_ms: 5_000,
            exit_grace_ms: 1_000,
        },
        track_processes: true,
    };
    let st = AppState {
        processes: Processes(fake.clone()),
        watchers: Arc::new(Watchers::with_config(config)),
        ..AppState::default()
    };
    let mc = instance(Launcher::Vanilla, &mc_dir);
    let profile = instance(Launcher::Vanilla, &profile_dir);
    let instances = vec![mc.clone(), profile.clone()];
    let mut roots: Vec<PathBuf> = Vec::new();
    for i in &instances {
        roots.extend(discovery::guard_roots(Path::new(&i.root), Path::new(&i.game_dir)));
    }
    st.apply_discovery(Discovered { report: DiscoveryReport { instances, probes: Vec::new() }, roots }).expect("apply");
    VanillaFx { _t: t, st, fake, mc_dir, mc, profile }
}

fn hs_err_naming(game_dir: &str) -> String {
    format!(
        "#\n# A fatal error has been detected by the Java Runtime Environment:\n#\n\
         ---------------  S U M M A R Y ------------\n\n\
         Command Line: -Xmx6G net.minecraft.client.main.Main --username Steve --gameDir {game_dir} --assetsDir a\n"
    )
}

#[test]
fn hs_err_in_the_launcher_dir_is_listed_for_the_profile_it_names() {
    let fx = vanilla_fixture();
    fs::write(fx.mc_dir.join("hs_err_pid77.log"), hs_err_naming(&fx.profile.game_dir)).expect("hs_err");
    let ids = |id: &str| -> Vec<String> {
        list_sources_blocking(&fx.st, id).expect("list").into_iter().map(|s| s.id).collect()
    };
    assert!(ids(&fx.profile.id).contains(&"@cwd/hs_err_pid77.log".to_string()), "{:?}", ids(&fx.profile.id));
    let d = read_digest_blocking(&fx.st, &fx.profile.id, "@cwd/hs_err_pid77.log", &[], None).expect("digest");
    assert_eq!(d.source.id, "@cwd/hs_err_pid77.log");
    // In `.minecraft` itself it is an ordinary game-dir file.
    let mc_ids = ids(&fx.mc.id);
    assert!(mc_ids.contains(&"hs_err_pid77.log".to_string()) && mc_ids.iter().all(|i| !i.starts_with('@')), "{mc_ids:?}");
    // Forged and traversal ids are refused.
    for bad in ["@cwd/../.minecraft/hs_err_pid77.log", "@cwd/launcher_profiles.json", "@cwd/hs_err_pid077.log"] {
        let err = read_digest_blocking(&fx.st, &fx.profile.id, bad, &[], None).expect_err(bad);
        assert!(matches!(err, Error::OutsideScope { .. }), "{bad}: {err}");
    }
    let err = read_digest_blocking(&fx.st, &fx.profile.id, "@cwd/hs_err_pid78.log", &[], None).expect_err("unlisted");
    assert!(matches!(err, Error::NotFound { .. }), "{err}");
}

#[test]
fn watch_picks_up_hs_err_in_the_working_dir_on_exit_and_it_is_readable() {
    let fx = vanilla_fixture();
    let (s, rx) = sink();
    enable_watch(&fx.st, &fx.profile.id, anchors(), s).expect("enable");
    // The vanilla launcher runs the profile in .minecraft with --gameDir pointing at it.
    fx.fake.set(vec![ProcInfo {
        pid: 4321,
        name: "javaw.exe".into(),
        cmd: vec!["javaw.exe".into(), "--gameDir".into(), fx.profile.game_dir.clone()],
        cwd: Some(fx.mc_dir.clone()),
    }]);
    std::thread::sleep(Duration::from_millis(300));
    // A native crash without a usable command line in the file: the recorded pid is enough.
    fs::write(fx.mc_dir.join("hs_err_pid4321.log"), "#\n# A fatal error has been detected\n").expect("hs_err");
    fx.fake.set(Vec::new());
    let e = rx.recv_timeout(Duration::from_secs(15)).expect("event");
    assert_eq!(e.instance_id, fx.profile.id);
    assert_eq!(e.source.id, "@cwd/hs_err_pid4321.log");
    assert_eq!(e.source.kind, crate::model::LogKind::HsErr);
    let list = list_sources_blocking(&fx.st, &fx.profile.id).expect("list");
    assert!(list.iter().any(|s| s.id == "@cwd/hs_err_pid4321.log"), "{list:?}");
    let d = read_digest_blocking(&fx.st, &fx.profile.id, "@cwd/hs_err_pid4321.log", &[], None).expect("digest");
    assert_eq!(d.total_lines, 2);
    // Listing works after the watcher is gone too.
    disable_watch(&fx.st, &fx.profile.id).expect("disable");
    assert!(list_sources_blocking(&fx.st, &fx.profile.id).expect("list").iter().any(|s| s.id == "@cwd/hs_err_pid4321.log"));
    // Another instance never sees it.
    assert!(list_sources_blocking(&fx.st, &fx.mc.id).expect("list").iter().all(|s| !s.id.starts_with('@')));
}

// ── hs_err in CurseForge's shared Install folder ─────────────────────────────

struct CurseFx {
    t: tempfile::TempDir,
    st: AppState,
    fake: Arc<FakeProcesses>,
    install: PathBuf,
    a: Instance,
    b: Instance,
    prism: Instance,
}

/// `<base>/curseforge/minecraft/{Install, Instances/Pack A, Instances/Pack B}` with the files the
/// real `Install` holds, plus an unrelated Prism instance. Discovers the CurseForge instances
/// and the Prism one.
fn curseforge_fixture() -> CurseFx {
    let t = tempfile::tempdir().expect("tempdir");
    let base = dunce::canonicalize(t.path()).expect("canon");
    let mc = base.join("curseforge").join("minecraft");
    let install = mc.join("Install");
    let a_dir = mc.join("Instances").join("Pack A");
    let b_dir = mc.join("Instances").join("Pack B");
    let prism_dir = base.join("Prism Pack");
    for d in [&a_dir, &b_dir, &prism_dir] {
        fs::create_dir_all(d.join("logs")).expect("mkdir");
        fs::write(d.join("logs/latest.log"), "[main/INFO]: hello\n").expect("log");
    }
    fs::create_dir_all(install.join("sub")).expect("install");
    for f in ["launcher_log.txt", "launcher_profiles.json", "launcher_msa_credentials.bin", "crash.txt"] {
        fs::write(install.join(f), "secret").expect("install file");
    }
    let fake = Arc::new(FakeProcesses::default());
    let config = WatchConfig {
        poll_interval: Duration::from_millis(50),
        debounce: Duration::from_millis(20),
        rescan_interval: Duration::from_millis(300),
        timings: EpisodeTimings {
            settle_ms: 200,
            max_coalesce_ms: 1_000,
            context_window_ms: 2_000,
            quiet_ms: 5_000,
            exit_grace_ms: 1_000,
        },
        track_processes: true,
    };
    let st = AppState {
        processes: Processes(fake.clone()),
        watchers: Arc::new(Watchers::with_config(config)),
        ..AppState::default()
    };
    let a = instance(Launcher::Curseforge, &a_dir);
    let b = instance(Launcher::Curseforge, &b_dir);
    let prism = instance(Launcher::Prism, &prism_dir);
    let fx = CurseFx { t, st, fake, install, a, b, prism };
    discover(&fx.st, vec![fx.a.clone(), fx.b.clone(), fx.prism.clone()]);
    fx
}

fn discover(st: &AppState, instances: Vec<Instance>) {
    let mut roots: Vec<PathBuf> = Vec::new();
    for i in &instances {
        roots.extend(discovery::guard_roots(Path::new(&i.root), Path::new(&i.game_dir)));
    }
    st.apply_discovery(Discovered { report: DiscoveryReport { instances, probes: Vec::new() }, roots }).expect("apply");
}

fn ids_of(st: &AppState, id: &str) -> Vec<String> {
    list_sources_blocking(st, id).expect("list").into_iter().map(|s| s.id).collect()
}

#[test]
fn curseforge_install_hs_err_is_listed_and_readable_for_the_instance_it_names() {
    let fx = curseforge_fixture();
    assert_eq!(fx.st.guard.hs_err_dirs(), vec![fx.install.clone()]);
    assert!(!fx.st.guard.roots().contains(&fx.install), "Install is not a root");
    fs::write(fx.install.join("hs_err_pid900.log"), hs_err_naming(&fx.a.game_dir)).expect("hs_err a");
    let gone = fx.install.parent().expect("mc").join("Instances").join("Deleted Pack");
    fs::write(fx.install.join("hs_err_pid901.log"), hs_err_naming(&gone.display().to_string())).expect("hs_err gone");
    fs::write(fx.install.join("hs_err_pid902.log"), "# no command line\n").expect("hs_err none");

    assert_eq!(ids_of(&fx.st, &fx.a.id), vec!["@cwd/hs_err_pid900.log", "logs/latest.log"]);
    let d = read_digest_blocking(&fx.st, &fx.a.id, "@cwd/hs_err_pid900.log", &[], None).expect("digest");
    assert_eq!(d.source.id, "@cwd/hs_err_pid900.log");
    assert_eq!(d.source.kind, crate::model::LogKind::HsErr);
    // Files naming another or no known instance are ignored everywhere.
    for id in [&fx.b.id, &fx.prism.id] {
        assert!(ids_of(&fx.st, id).iter().all(|i| !i.starts_with('@')), "{:?}", ids_of(&fx.st, id));
    }
    for unlisted in ["@cwd/hs_err_pid901.log", "@cwd/hs_err_pid902.log"] {
        let err = read_digest_blocking(&fx.st, &fx.a.id, unlisted, &[], None).expect_err(unlisted);
        assert!(matches!(err, Error::NotFound { .. }), "{unlisted}: {err}");
    }
    assert!(read_digest_blocking(&fx.st, &fx.b.id, "@cwd/hs_err_pid900.log", &[], None).is_err());
    // Forged ids pointing at the launcher's other files are refused.
    for bad in ["@cwd/launcher_log.txt", "@cwd/../Install/launcher_profiles.json", "@cwd/sub/hs_err_pid1.log"] {
        let err = read_digest_blocking(&fx.st, &fx.a.id, bad, &[], None).expect_err(bad);
        assert!(matches!(err, Error::OutsideScope { .. }), "{bad}: {err}");
    }
}

#[test]
fn curseforge_install_stays_closed_to_everything_but_hs_err_files() {
    let fx = curseforge_fixture();
    fs::write(fx.install.join("hs_err_pid1.log"), "x").expect("hs_err");
    fs::write(fx.install.join("hs_err_pid1.log.bak"), "x").expect("bak");
    fs::write(fx.install.join("sub").join("hs_err_pid1.log"), "x").expect("sub");
    let g = &fx.st.guard;
    assert!(g.check_existing(&fx.install.join("hs_err_pid1.log")).is_ok());
    for bad in ["launcher_log.txt", "launcher_profiles.json", "launcher_msa_credentials.bin", "crash.txt", "hs_err_pid1.log.bak"] {
        assert!(matches!(g.check_existing(&fx.install.join(bad)), Err(Error::OutsideScope { .. })), "{bad}");
    }
    assert!(g.check_existing(&fx.install.join("sub").join("hs_err_pid1.log")).is_err());
    assert!(g.check_existing(&fx.install).is_err());
    for new in ["hs_err_pid1.log", "hs_err_pid2.log", "launcher_log.txt"] {
        assert!(g.check_new(&fx.install.join(new)).is_err(), "{new} is writable");
    }
    // A link inside an instance root that leads into Install reaches only the hs_err files.
    let link = PathBuf::from(&fx.a.game_dir).join("install-link");
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(&fx.install)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if cfg!(windows) && made {
        assert!(g.check_existing(&link.join("launcher_log.txt")).is_err());
        assert!(g.check_existing(&link.join("hs_err_pid1.log")).is_ok());
    }
    // A link in Install that leads elsewhere is refused.
    let outside = fx.t.path().join("outside");
    fs::create_dir_all(&outside).expect("outside");
    fs::write(outside.join("hs_err_pid3.log"), "x").expect("outside file");
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(fx.install.join("escape"))
        .arg(&outside)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if cfg!(windows) && made {
        assert!(g.check_existing(&fx.install.join("escape").join("hs_err_pid3.log")).is_err());
    }
}

#[test]
fn curseforge_rule_exists_only_while_a_curseforge_instance_is_discovered() {
    let fx = curseforge_fixture();
    fs::write(fx.install.join("hs_err_pid900.log"), hs_err_naming(&fx.a.game_dir)).expect("hs_err");
    assert!(ids_of(&fx.st, &fx.a.id).contains(&"@cwd/hs_err_pid900.log".to_string()));
    // Rediscovery without CurseForge instances drops the rule.
    discover(&fx.st, vec![fx.prism.clone()]);
    assert!(fx.st.guard.hs_err_dirs().is_empty());
    assert!(fx.st.guard.check_existing(&fx.install.join("hs_err_pid900.log")).is_err());
    // And brings it back with them.
    discover(&fx.st, vec![fx.b.clone(), fx.prism.clone()]);
    assert_eq!(fx.st.guard.hs_err_dirs(), vec![fx.install.clone()]);
    // A Manual instance in the same folder does not count.
    let manual = instance(Launcher::Manual, Path::new(&fx.a.game_dir));
    discover(&fx.st, vec![manual.clone()]);
    assert!(fx.st.guard.hs_err_dirs().is_empty());
    assert!(ids_of(&fx.st, &manual.id).iter().all(|i| !i.starts_with('@')));
}

#[test]
fn watch_picks_up_a_curseforge_hs_err_in_install_on_exit() {
    let fx = curseforge_fixture();
    let (s, rx) = sink();
    enable_watch(&fx.st, &fx.a.id, anchors(), s).expect("enable");
    // Recorded working dir = Install (the case the rule exists for).
    fx.fake.set(vec![ProcInfo {
        pid: 6543,
        name: "javaw.exe".into(),
        cmd: vec!["javaw.exe".into(), "--gameDir".into(), fx.a.game_dir.clone()],
        cwd: Some(fx.install.clone()),
    }]);
    std::thread::sleep(Duration::from_millis(300));
    fs::write(fx.install.join("hs_err_pid6543.log"), "#\n# A fatal error has been detected\n").expect("hs_err");
    fx.fake.set(Vec::new());
    let e = rx.recv_timeout(Duration::from_secs(15)).expect("event");
    assert_eq!(e.instance_id, fx.a.id);
    assert_eq!(e.source.id, "@cwd/hs_err_pid6543.log");
    assert_eq!(e.source.kind, crate::model::LogKind::HsErr);
    assert!(e.source.size > 0);
    let d = read_digest_blocking(&fx.st, &fx.a.id, "@cwd/hs_err_pid6543.log", &[], None).expect("digest");
    assert_eq!(d.total_lines, 2);
    assert!(ids_of(&fx.st, &fx.b.id).iter().all(|i| !i.starts_with('@')));
    fx.st.watchers.stop_all();
}
