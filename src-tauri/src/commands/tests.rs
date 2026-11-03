//! Command wiring tests without a Tauri runtime: registry + PathGuard sync, manual-instance
//! removal, settings edits for scope entries, and scan orchestration with a recording sink.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use super::instances::remove_manual_blocking;
use super::*;
use crate::discovery::{self, discover_with, DbOptions, Discovered, DiscoveryInput, Env, Os};
use crate::error::Error;
use crate::guard::PathGuard;
use crate::model::{DiscoveryReport, Instance, Launcher, MetadataSource, Settings, Side};
use crate::state::{apply_registry, root_changes, AppState, Registry};
use crate::test_support::JarBuilder;

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn canon(p: &Path) -> PathBuf {
    dunce::canonicalize(p).expect("canonicalize")
}

fn mkdir(p: &Path) -> PathBuf {
    fs::create_dir_all(p).expect("mkdir");
    canon(p)
}

fn fake_instance(launcher: Launcher, name: &str, root: &Path, game_dir: &Path) -> Instance {
    Instance {
        id: discovery::instance_id(game_dir, Os::current()),
        name: name.into(),
        launcher,
        root: root.display().to_string(),
        game_dir: game_dir.display().to_string(),
        mc_version: None,
        loader: None,
        side: Side::Client,
        metadata_source: MetadataSource::Inferred,
        mod_count: 0,
    }
}

fn fake_discovered(instances: Vec<Instance>) -> Discovered {
    let mut roots = Vec::new();
    for i in &instances {
        for r in discovery::guard_roots(Path::new(&i.root), Path::new(&i.game_dir)) {
            if !roots.contains(&r) {
                roots.push(r);
            }
        }
    }
    Discovered { report: DiscoveryReport { instances, probes: Vec::new() }, roots }
}

fn fast_db() -> DbOptions {
    DbOptions { busy_timeout: Duration::from_millis(50), retries: 1, retry_delay: Duration::from_millis(5) }
}

// ── Registry + roots ─────────────────────────────────────────────────────────

#[test]
fn root_changes_adds_new_and_removes_stale_but_never_pinned() {
    let a = PathBuf::from("a");
    let b = PathBuf::from("b");
    let c = PathBuf::from("c");
    let pinned = PathBuf::from("p");
    let (add, remove) = root_changes(&[a.clone(), b.clone(), pinned.clone()], &[b.clone(), c.clone()], &[pinned]);
    assert_eq!(add, vec![c]);
    assert_eq!(remove, vec![a]);
}

#[test]
fn applying_discoveries_syncs_registry_and_guard() {
    let t = tmp();
    let one = mkdir(&t.path().join("One"));
    let two = mkdir(&t.path().join("Two ü"));
    mkdir(&one.join("mods"));
    mkdir(&two.join("mods"));
    fs::write(one.join("mods").join("a.jar"), b"x").expect("write");
    fs::write(two.join("mods").join("b.jar"), b"x").expect("write");
    let app_data = mkdir(&t.path().join("appdata"));

    let st = AppState::default();
    st.pin_root(&app_data).expect("pin");
    let i1 = fake_instance(Launcher::Prism, "One", &one, &one);
    let i2 = fake_instance(Launcher::Manual, "Two", &two, &two);
    let report = st.apply_discovery(fake_discovered(vec![i1.clone(), i2.clone()])).expect("apply");
    assert_eq!(report.instances.len(), 2);
    assert_eq!(st.known_ids().len(), 2);
    assert_eq!(st.instance(&i2.id).expect("registered").game_dir, two);
    assert!(st.guard.check_existing(&one.join("mods").join("a.jar")).is_ok());
    assert!(st.guard.check_existing(&two.join("mods").join("b.jar")).is_ok());

    // Rediscovery without `Two`: its root is unregistered, the pinned root stays.
    st.apply_discovery(fake_discovered(vec![i1.clone()])).expect("apply");
    assert!(matches!(st.instance(&i2.id), Err(Error::NotFound { .. })));
    assert!(matches!(st.guard.check_existing(&two.join("mods").join("b.jar")), Err(Error::OutsideScope { .. })));
    assert!(st.guard.check_existing(&one.join("mods").join("a.jar")).is_ok());
    assert!(st.guard.check_existing(&app_data).is_ok());
}

#[test]
fn registry_remove_keeps_roots_shared_with_other_instances() {
    let shared = PathBuf::from("shared");
    let own = PathBuf::from("own");
    let mut d2 = fake_discovered(vec![]);
    let t = tmp();
    let a = mkdir(&t.path().join("a"));
    let b = mkdir(&t.path().join("b"));
    d2.report.instances = vec![fake_instance(Launcher::Manual, "A", &a, &a), fake_instance(Launcher::Manual, "B", &b, &b)];
    let ia = d2.report.instances[0].id.clone();
    let mut reg = Registry::from_discovered(&d2, |root, _| {
        if root.ends_with("a") {
            vec![shared.clone(), own.clone()]
        } else {
            vec![shared.clone()]
        }
    });
    assert_eq!(reg.len(), 2);
    let (gone, orphaned) = reg.remove(&ia).expect("present");
    assert_eq!(gone.instance.name, "A");
    assert_eq!(orphaned, vec![own.clone()]);
    assert_eq!(reg.roots(), &[shared][..]);
    assert!(reg.remove(&ia).is_none());
}

#[test]
fn apply_registry_registers_every_root() {
    let t = tmp();
    let a = mkdir(&t.path().join("a"));
    let guard = PathGuard::new();
    let mut reg = Registry::default();
    let next = Registry::from_discovered(&fake_discovered(vec![fake_instance(Launcher::Vanilla, "A", &a, &a)]), discovery::guard_roots);
    apply_registry(&guard, &mut reg, next, &[]);
    assert_eq!(guard.roots(), vec![a.clone()]);
    apply_registry(&guard, &mut reg, Registry::default(), &[]);
    assert!(guard.roots().is_empty());
}

// ── Manual folders and launcher roots ────────────────────────────────────────

#[test]
fn manual_folder_id_matches_discovery() {
    let t = tmp();
    let home = mkdir(&t.path().join("home"));
    let plain = mkdir(&t.path().join("Plain pack"));
    mkdir(&plain.join("mods"));
    let prism = mkdir(&t.path().join("Prism instance"));
    fs::write(prism.join("instance.cfg"), "name=Cool Pack\n").expect("write");
    mkdir(&prism.join(".minecraft").join("mods"));
    let empty = mkdir(&t.path().join("Empty"));

    let input = DiscoveryInput { manual_folders: vec![plain.clone(), prism.clone(), empty.clone()], launcher_roots: vec![] };
    let d = discover_with(&Env::new(Os::current(), home), &input, &fast_db());
    for folder in [&plain, &prism, &empty] {
        let id = manual_folder_id(folder);
        assert!(d.report.instances.iter().any(|i| i.id == id), "no instance for {}: {:?}", folder.display(), d.report.instances);
    }
    assert_eq!(manual_game_dir(&prism), prism.join(".minecraft"));
}

#[test]
fn add_manual_folder_dedupes() {
    let mut s = Settings::default();
    assert!(add_manual_folder(&mut s, "/x/Pack"));
    assert!(!add_manual_folder(&mut s, "/x/Pack"));
    let case_insensitive = Os::current().case_insensitive();
    assert_eq!(add_manual_folder(&mut s, "/x/PACK"), !case_insensitive);
}

#[test]
fn add_launcher_root_dedupes_per_launcher() {
    let mut s = Settings::default();
    assert!(add_launcher_root(&mut s, Launcher::Prism, "/p"));
    assert!(!add_launcher_root(&mut s, Launcher::Prism, "/p"));
    assert!(add_launcher_root(&mut s, Launcher::Multimc, "/p"));
    assert_eq!(s.launcher_roots.len(), 2);
}

#[test]
fn remove_stored_path_requires_exact_match() {
    let mut s = Settings::default();
    add_launcher_root(&mut s, Launcher::Prism, "/p/Prism");
    add_manual_folder(&mut s, "/gone/Pack");
    assert!(!remove_stored_path(&mut s, "/p/prism/"));
    assert!(!remove_stored_path(&mut s, "/p"));
    assert!(remove_stored_path(&mut s, "/p/Prism"));
    assert!(s.launcher_roots.is_empty());
    assert_eq!(s.manual_folders.len(), 1);
    // A stale manual folder (no instance to remove) can be dropped by its probe path.
    assert!(remove_stored_path(&mut s, "/gone/Pack"));
    assert!(s.manual_folders.is_empty());
}

fn state_with_instances(t: &tempfile::TempDir) -> (AppState, Instance, Instance, PathBuf) {
    let manual = mkdir(&t.path().join("My Pack"));
    mkdir(&manual.join("mods"));
    let launcher = mkdir(&t.path().join("Launcher Pack"));
    let st = AppState::default();
    let m = fake_instance(Launcher::Manual, "My Pack", &manual, &manual);
    let l = fake_instance(Launcher::Prism, "Launcher Pack", &launcher, &launcher);
    st.settings
        .update(|s| {
            s.manual_folders.push(manual.display().to_string());
            s.manual_folders.push("/somewhere/else".into());
            Ok(())
        })
        .expect("settings");
    st.apply_discovery(fake_discovered(vec![m.clone(), l.clone()])).expect("apply");
    (st, m, l, manual)
}

#[test]
fn remove_manual_instance_removes_only_manual_ones() {
    let t = tmp();
    let (st, manual, launcher, manual_dir) = state_with_instances(&t);

    let err = remove_manual_blocking(&st, &launcher.id).expect_err("launcher instance");
    assert!(matches!(err, Error::Invalid(_)), "{err}");
    assert!(st.instance(&launcher.id).is_ok());

    assert!(matches!(remove_manual_blocking(&st, "0000000000000000"), Err(Error::NotFound { .. })));

    assert!(st.guard.check_existing(&manual_dir).is_ok());
    remove_manual_blocking(&st, &manual.id).expect("remove manual");
    assert!(st.instance(&manual.id).is_err());
    assert_eq!(st.settings.get().manual_folders, vec!["/somewhere/else".to_string()]);
    assert!(matches!(st.guard.check_existing(&manual_dir), Err(Error::OutsideScope { .. })));
    assert!(st.instance(&launcher.id).is_ok(), "other instances untouched");
}

#[test]
fn remove_manual_folders_matches_by_root_or_id() {
    let t = tmp();
    let prism = mkdir(&t.path().join("Inst"));
    let game = mkdir(&prism.join(".minecraft"));
    mkdir(&game.join("mods"));
    let inst = fake_instance(Launcher::Manual, "Inst", &prism, &game);
    // Added once as the instance root and once as its game dir: both map to the same id.
    let mut s = Settings {
        manual_folders: vec![prism.display().to_string(), game.display().to_string(), "/other".into()],
        ..Settings::default()
    };
    assert_eq!(remove_manual_folders_for(&mut s, &inst, manual_folder_id), 2);
    assert_eq!(s.manual_folders, vec!["/other".to_string()]);
}

// ── Scanning ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Ev {
    Started(Vec<String>),
    Progress { done: u32, total: u32, jar: String },
}

#[derive(Default)]
struct Recorder(Mutex<Vec<Ev>>);

impl ScanSink for Recorder {
    fn started(&self, e: crate::model::ScanStarted) {
        self.0.lock().expect("lock").push(Ev::Started(e.jars.into_iter().map(|j| j.id).collect()));
    }
    fn progress(&self, e: crate::model::ScanProgress) {
        self.0.lock().expect("lock").push(Ev::Progress { done: e.done, total: e.total, jar: e.jar_id });
    }
}

fn fabric_jar(id: &str) -> JarBuilder {
    JarBuilder::new().fabric_mod_json(&format!(r#"{{"schemaVersion":1,"id":"{id}","version":"1.0.0"}}"#))
}

/// An instance with 3 top-level jars (one disabled, one with a nested jar) plus noise.
fn scan_fixture(t: &tempfile::TempDir) -> AppState {
    let game = mkdir(&t.path().join("Scan Pack"));
    let mods = game.join("mods");
    fabric_jar("alpha").write_to(&mods, "alpha.jar");
    JarBuilder::new()
        .fabric_mod_json(r#"{"schemaVersion":1,"id":"beta","version":"1.0.0","jars":[{"file":"META-INF/jars/inner.jar"}]}"#)
        .nested("META-INF/jars/inner.jar", fabric_jar("inner"))
        .write_to(&mods, "beta.jar");
    fabric_jar("gamma").write_to(&mods, "gamma.jar.disabled");
    fs::write(mods.join("readme.txt"), b"x").expect("write");
    fabric_jar("deep").write_to(&mods.join("sub"), "deep.jar");
    let st = AppState::default();
    st.apply_discovery(fake_discovered(vec![fake_instance(Launcher::Manual, "Scan Pack", &game, &game)])).expect("apply");
    st
}

fn only_instance(st: &AppState) -> crate::state::RegisteredInstance {
    let id = st.known_ids().into_iter().next().expect("one instance");
    st.instance(&id).expect("registered")
}

#[test]
fn scan_emits_started_once_then_one_progress_per_top_level_jar() {
    let t = tmp();
    let st = scan_fixture(&t);
    let inst = only_instance(&st);
    let rec = Recorder::default();
    let res = scan_registered(&st.guard, &st.scan_cache, &st.scans, &inst, &rec).expect("scan");

    let events = rec.0.into_inner().expect("lock");
    let Some(Ev::Started(stubs)) = events.first() else { panic!("first event must be ScanStarted: {events:?}") };
    assert_eq!(stubs, &["mods/alpha.jar", "mods/beta.jar", "mods/gamma.jar"]);
    assert_eq!(events.iter().filter(|e| matches!(e, Ev::Started(_))).count(), 1);
    let progress: Vec<&Ev> = events[1..].iter().collect();
    let top_level = res.jars.iter().filter(|j| j.depth == 0).count();
    assert_eq!(top_level, 3);
    assert_eq!(progress.len(), top_level);
    assert!(res.jars.iter().any(|j| j.depth == 1), "nested jar scanned");
    let mut dones: Vec<u32> = progress
        .iter()
        .map(|e| match e {
            Ev::Progress { done, total, .. } => {
                assert_eq!(*total, 3);
                *done
            }
            Ev::Started(_) => panic!("second ScanStarted"),
        })
        .collect();
    dones.sort_unstable();
    assert_eq!(dones, vec![1, 2, 3]);
    assert!(!st.scans.is_running(&inst.instance.id), "ticket released");

    // Rescan hits the shared cache and gives the same result.
    let again = scan_registered(&st.guard, &st.scan_cache, &st.scans, &inst, &Recorder::default()).expect("rescan");
    assert_eq!(again.jars, res.jars);
    assert_eq!(st.scan_cache.len(), 3);
}

#[test]
fn concurrent_scan_of_same_instance_is_rejected() {
    let t = tmp();
    let st = scan_fixture(&t);
    let inst = only_instance(&st);
    let _held = st.scans.begin(&inst.instance.id, &inst.instance.name).expect("first");
    let err = scan_registered(&st.guard, &st.scan_cache, &st.scans, &inst, &Recorder::default()).expect_err("conflict");
    assert!(matches!(err, Error::Conflict(ref m) if m.contains("Scan Pack") && m.ends_with('.')), "{err}");
    // A different instance may scan meanwhile.
    assert!(st.scans.begin("ffffffffffffffff", "Other").is_ok());
}

/// Blocks in `started` until released, so a scan is provably in flight.
struct Gate {
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl ScanSink for Gate {
    fn started(&self, _: crate::model::ScanStarted) {
        if let Some(tx) = self.entered.lock().expect("lock").take() {
            let _ = tx.send(());
        }
        let _ = self.release.lock().expect("lock").recv_timeout(Duration::from_secs(10));
    }
    fn progress(&self, _: crate::model::ScanProgress) {}
}

#[test]
fn second_scan_while_first_runs_gets_conflict_then_succeeds_after() {
    let t = tmp();
    let st = scan_fixture(&t);
    let inst = only_instance(&st);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let gate = Gate { entered: Mutex::new(Some(entered_tx)), release: Mutex::new(release_rx) };

    let (st2, inst2) = (st.clone(), inst.clone());
    let first = std::thread::spawn(move || scan_registered(&st2.guard, &st2.scan_cache, &st2.scans, &inst2, &gate).map(|r| r.jars.len()));
    entered_rx.recv_timeout(Duration::from_secs(10)).expect("first scan started");
    let err = scan_registered(&st.guard, &st.scan_cache, &st.scans, &inst, &Recorder::default()).expect_err("conflict");
    assert!(matches!(err, Error::Conflict(_)));
    release_tx.send(()).expect("release");
    assert!(first.join().expect("join").expect("first scan ok") >= 3);
    assert!(scan_registered(&st.guard, &st.scan_cache, &st.scans, &inst, &Recorder::default()).is_ok());
}

#[test]
fn scan_of_instance_without_mods_folder_is_empty() {
    let t = tmp();
    let game = mkdir(&t.path().join("Fresh"));
    let st = AppState::default();
    st.apply_discovery(fake_discovered(vec![fake_instance(Launcher::Vanilla, "Fresh", &game, &game)])).expect("apply");
    let rec = Recorder::default();
    let res = scan_registered(&st.guard, &st.scan_cache, &st.scans, &only_instance(&st), &rec).expect("scan");
    assert!(res.jars.is_empty());
    assert_eq!(rec.0.into_inner().expect("lock"), vec![Ev::Started(vec![])]);
}
