//! Opened packs through `AppState` without a Tauri runtime: opening, drops, the read-only
//! guard rule, surviving rediscovery, removal and scanning. Temp dirs only.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::*;
use crate::discovery::{self, Discovered, Os};
use crate::model::{DiscoveryReport, Launcher, MetadataSource, PackOverride, ScanProgress, Side};
use crate::test_support::JarBuilder;

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn canon(p: &Path) -> PathBuf {
    dunce::canonicalize(p).expect("canonicalize")
}

const INDEX: &str = r#"{"formatVersion":1,"game":"minecraft","versionId":"1","name":"Drop Pack","files":[
  {"path":"mods/a.jar","hashes":{"sha1":"0123456789abcdef0123456789abcdef01234567","sha512":"00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"},"downloads":["https://cdn.modrinth.com/data/x/versions/y/a.jar"],"fileSize":3}],
  "dependencies":{"minecraft":"1.21.1","neoforge":"21.1.77"}}"#;

fn write_pack(dir: &Path, name: &str) -> PathBuf {
    std::fs::create_dir_all(dir).expect("mkdir");
    let jar = JarBuilder::new()
        .fabric_mod_json(r#"{"schemaVersion":1,"id":"extra","version":"1.0.0"}"#)
        .class("com/extra/Main.class", 65)
        .build();
    let path = JarBuilder::new()
        .file("modrinth.index.json", INDEX)
        .file("overrides/mods/extra.jar", jar)
        .write_to(dir, name);
    canon(&path)
}

fn folder_instance(dir: &Path) -> Instance {
    std::fs::create_dir_all(dir.join("mods")).expect("mkdir");
    let dir = canon(dir);
    Instance {
        id: discovery::instance_id(&dir, Os::current()),
        name: "Folder".into(),
        launcher: Launcher::Manual,
        root: dir.display().to_string(),
        game_dir: dir.display().to_string(),
        mc_version: None,
        loader: None,
        side: Side::Client,
        metadata_source: MetadataSource::Inferred,
        mod_count: 0,
    }
}

fn discovered(instances: Vec<Instance>) -> Discovered {
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

#[test]
fn opening_registers_a_session_pack_with_the_read_only_rule() {
    let t = tmp();
    let pack = write_pack(&t.path().join("Downloads"), "Drop Pack.mrpack");
    std::fs::write(t.path().join("Downloads").join("secret.txt"), b"s").expect("write");
    let st = AppState::default();

    let inst = open_pack(&st, &pack).expect("open");
    assert_eq!(inst.launcher, Launcher::Mrpack);
    assert_eq!(inst.name, "Drop Pack");
    assert_eq!(inst.metadata_source, MetadataSource::Mrpack);
    assert_eq!(inst.loader.as_ref().map(|l| l.kind), Some(crate::model::LoaderKind::Neoforge));
    assert_eq!(inst.mc_version.as_deref(), Some("1.21.1"));
    assert_eq!(inst.mod_count, 2);
    assert_eq!(PathBuf::from(&inst.root), pack);

    assert_eq!(st.instance(&inst.id).expect("registered").game_dir, pack);
    assert_eq!(st.guard.read_only_files(), vec![pack.clone()]);
    assert!(st.guard.roots().is_empty(), "a pack is never a root");
    assert!(st.guard.check_existing(&pack).is_ok());
    assert!(st.guard.check_existing(&t.path().join("Downloads").join("secret.txt")).is_err());
    assert!(st.guard.check_new(&pack).is_err());
    assert!(st.settings.get().manual_folders.is_empty(), "never persisted");

    // Opening it again refreshes the one entry.
    let again = open_pack(&st, &pack).expect("open again");
    assert_eq!(again.id, inst.id);
    assert_eq!(st.opened_packs().len(), 1);
    assert_eq!(st.registry.read().expect("lock").len(), 1);
}

#[test]
fn packs_survive_rediscovery_and_are_reported() {
    let t = tmp();
    let pack = write_pack(t.path(), "p.mrpack");
    let folder = folder_instance(&t.path().join("Instance"));
    let st = AppState::default();
    let inst = open_pack(&st, &pack).expect("open");

    let report = st.apply_discovery(discovered(vec![folder.clone()])).expect("discover");
    let ids: Vec<&str> = report.instances.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec![folder.id.as_str(), inst.id.as_str()], "discovered instances first, then opened packs");
    assert!(st.instance(&inst.id).is_ok());
    assert!(st.instance(&folder.id).is_ok());
    assert_eq!(st.guard.read_only_files(), vec![pack.clone()]);

    // A discovery that finds nothing keeps the pack (and its rule) too.
    let report = st.apply_discovery(discovered(Vec::new())).expect("discover");
    assert_eq!(report.instances.len(), 1);
    assert!(st.instance(&folder.id).is_err());
    assert!(st.guard.check_existing(&pack).is_ok());
}

#[test]
fn removal_closes_the_pack_for_good() {
    let t = tmp();
    let pack = write_pack(t.path(), "p.mrpack");
    let st = AppState::default();
    let inst = open_pack(&st, &pack).expect("open");
    let over = PackOverride { mc_version: Some("1.21.1".into()), loader: None, side: None };
    st.settings
        .update(|s| {
            s.overrides.insert(inst.id.clone(), over);
            Ok(())
        })
        .expect("override");

    remove_pack_and_forget(&st, &inst.id).expect("remove");
    assert!(st.instance(&inst.id).is_err());
    assert!(st.opened_packs().is_empty());
    assert!(st.guard.read_only_files().is_empty());
    assert!(st.guard.check_existing(&pack).is_err());
    assert!(!st.settings.get().overrides.contains_key(&inst.id), "its override is dropped");
    assert!(pack.is_file(), "the pack file itself is untouched");

    let report = st.apply_discovery(discovered(Vec::new())).expect("discover");
    assert!(report.instances.is_empty(), "it does not come back");
    assert!(matches!(remove_pack_and_forget(&st, &inst.id), Err(Error::NotFound { .. })));
}

#[test]
fn drops_open_packs_and_reject_everything_else() {
    let t = tmp();
    let pack = write_pack(t.path(), "good.mrpack");
    let folder = t.path().join("Some Instance");
    std::fs::create_dir_all(&folder).expect("mkdir");
    let text = t.path().join("notes.txt");
    std::fs::write(&text, b"x").expect("write");
    let st = AppState::default();

    let out = open_dropped(&st, &[pack.clone(), folder, text, t.path().join("gone.mrpack")]);
    assert_eq!(out.len(), 4);
    assert_eq!(out[0].as_ref().expect("pack").root, pack.display().to_string());
    let rejected: Vec<&DropRejected> = out[1..].iter().map(|r| r.as_ref().expect_err("rejected")).collect();
    assert_eq!(rejected[0].name, "Some Instance");
    assert!(rejected[0].reason.contains("Add folder"), "{}", rejected[0].reason);
    assert_eq!(rejected[1].name, "notes.txt");
    assert!(rejected[1].reason.contains(".mrpack"));
    assert_eq!(rejected[2].name, "gone.mrpack");
    for r in &rejected {
        assert!(!r.name.contains(['/', '\\']), "file name only: {}", r.name);
        assert!(r.reason.ends_with('.'), "a sentence: {}", r.reason);
    }
    assert_eq!(st.opened_packs().len(), 1);

    let many = vec![pack; MAX_DROPPED_FILES + 1];
    let out = open_dropped(&st, &many);
    assert!(out[..MAX_DROPPED_FILES].iter().all(Result::is_ok));
    assert!(out[MAX_DROPPED_FILES].as_ref().expect_err("over the cap").reason.contains("at most 32"));
}

#[derive(Default)]
struct Recorder {
    started: Mutex<Vec<ScanStarted>>,
    progress: Mutex<Vec<ScanProgress>>,
}

impl ScanSink for Recorder {
    fn started(&self, event: ScanStarted) {
        self.started.lock().expect("lock").push(event);
    }
    fn progress(&self, event: ScanProgress) {
        self.progress.lock().expect("lock").push(event);
    }
}

#[test]
fn scanning_a_registered_pack() {
    let t = tmp();
    let pack = write_pack(t.path(), "p.mrpack");
    let st = AppState::default();
    let inst = open_pack(&st, &pack).expect("open");
    let reg = st.instance(&inst.id).expect("registered");
    let sink = Recorder::default();

    let res = scan_registered_pack(&st.guard, &st.scans, &reg, &sink).expect("scan");
    assert_eq!(res.instance_id, inst.id);
    assert_eq!(res.declared.len(), 1);
    assert_eq!(res.declared[0].path, "mods/a.jar");
    assert_eq!(res.jars.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(), vec!["overrides/mods/extra.jar"]);
    assert_eq!(res.jars[0].max_class_major, Some(65));
    assert!(res.issues.is_empty(), "{:?}", res.issues);
    let started = sink.started.lock().expect("lock");
    assert_eq!(started.len(), 1);
    assert_eq!(started[0].jars.len(), 1);
    assert_eq!(sink.progress.lock().expect("lock").len(), 1);
    assert!(!st.scans.is_running(&inst.id), "the ticket is released");

    // Once closed, the pack can't be read through the guard any more.
    st.remove_opened_pack(&inst.id).expect("close");
    assert!(matches!(scan_registered_pack(&st.guard, &st.scans, &reg, &sink), Err(Error::OutsideScope { .. })));
}
