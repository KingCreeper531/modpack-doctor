//! Discovery integration tests: temp-dir fakes only, `Env` injected, never the real home.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::Connection;

use super::common::display;
use super::*;
use crate::model::{Instance, LauncherProbe, LoaderInfo, LoaderKind, MetadataSource, Side};

const OSES: [Os; 3] = [Os::Windows, Os::MacOs, Os::Linux];

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

/// A home with a non-ASCII user name.
fn home(t: &tempfile::TempDir) -> PathBuf {
    let h = t.path().join("Jürgen 名前");
    fs::create_dir_all(&h).expect("mkdir home");
    h
}

fn env(os: Os, home: &Path) -> Env {
    Env::new(os, home.to_path_buf())
}

fn write(p: &Path, data: impl AsRef<[u8]>) {
    fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
    fs::write(p, data).expect("write");
}

/// Join a `/`-separated relative path component by component (native separators).
fn rel(base: &Path, r: &str) -> PathBuf {
    r.split('/').fold(base.to_path_buf(), |acc, c| acc.join(c))
}

fn mkdir(p: &Path) {
    fs::create_dir_all(p).expect("mkdir");
}

/// `n` enabled jars + one disabled jar + noise that must not be counted.
fn jars(game: &Path, n: usize) {
    for i in 0..n {
        write(&game.join("mods").join(format!("mod{i}.jar")), b"PK");
    }
    write(&game.join("mods").join("off.JAR.disabled"), b"PK");
    write(&game.join("mods").join("notes.txt"), b"x");
    write(&game.join("mods").join(".modrinth-1234.tmp"), b"x");
    mkdir(&game.join("mods").join("folder.jar"));
}

fn fast() -> DbOptions {
    DbOptions { busy_timeout: Duration::from_millis(50), retries: 3, retry_delay: Duration::from_millis(10) }
}

fn run(env: &Env, input: &DiscoveryInput) -> Discovered {
    discover_with(env, input, &fast())
}

fn run_empty(env: &Env) -> Discovered {
    run(env, &DiscoveryInput::default())
}

fn find<'a>(d: &'a Discovered, name: &str) -> &'a Instance {
    d.report
        .instances
        .iter()
        .find(|i| i.name == name)
        .unwrap_or_else(|| panic!("no instance {name:?} in {:#?}", d.report.instances))
}

fn probe_at<'a>(d: &'a Discovered, launcher: Launcher, path: &Path) -> &'a LauncherProbe {
    let want = display(path);
    d.report
        .probes
        .iter()
        .find(|p| p.launcher == launcher && p.path == want)
        .unwrap_or_else(|| panic!("no {launcher:?} probe at {want} in {:#?}", d.report.probes))
}

fn loader(kind: LoaderKind, v: &str) -> Option<LoaderInfo> {
    Some(LoaderInfo { kind, version: Some(v.to_string()) })
}

fn canon(p: &Path) -> PathBuf {
    dunce::canonicalize(p).expect("canonicalize")
}

/// Directory link that needs no privilege: junction on Windows, symlink elsewhere.
fn link_dir(target: &Path, link: &Path) {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("run mklink");
        assert!(out.status.success(), "mklink /J failed: {out:?}");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).expect("symlink");
}

// ---------------------------------------------------------------------------------------------
// Modrinth

/// (path, name, game_version, mod_loader, mod_loader_version)
type GenARow<'a> = (&'a str, &'a str, Option<&'a str>, Option<&'a str>, Option<&'a str>);

fn modrinth_gen_a(db: &Path, custom_dir: Option<&str>, rows: &[GenARow<'_>]) {
    mkdir(db.parent().expect("parent"));
    let c = Connection::open(db).expect("open");
    c.execute_batch(
        "CREATE TABLE settings (id INTEGER PRIMARY KEY, custom_dir TEXT NULL, prev_custom_dir TEXT NULL);
         CREATE TABLE profiles (path TEXT PRIMARY KEY, name TEXT NOT NULL, game_version TEXT, mod_loader TEXT,
                                mod_loader_version TEXT, install_stage TEXT);",
    )
    .expect("schema");
    c.execute("INSERT INTO settings (id, custom_dir) VALUES (0, ?1)", [custom_dir]).expect("settings");
    for (path, name, gv, ml, mlv) in rows {
        c.execute(
            "INSERT INTO profiles (path, name, game_version, mod_loader, mod_loader_version, install_stage)
             VALUES (?1, ?2, ?3, ?4, ?5, 'installed')",
            rusqlite::params![path, name, gv, ml, mlv],
        )
        .expect("row");
    }
}

/// (path, name, game_version, loader, loader_version)
type GenBRow<'a> = (&'a str, &'a str, &'a str, &'a str, Option<&'a str>);

/// Gen-B database in WAL mode, closed (so it is checkpointed into the main file).
fn modrinth_gen_b(db: &Path, rows: &[GenBRow<'_>]) {
    drop(modrinth_gen_b_writer(db, rows));
}

/// Gen-B database written by a connection that stays open with auto-checkpoint off: schema
/// and rows exist **only in `app.db-wal`** until the returned writer is closed.
fn modrinth_gen_b_writer(db: &Path, rows: &[GenBRow<'_>]) -> Connection {
    mkdir(db.parent().expect("parent"));
    let c = Connection::open(db).expect("open");
    c.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA wal_autocheckpoint = 0;
         CREATE TABLE settings (id INTEGER PRIMARY KEY, custom_dir TEXT NULL);
         INSERT INTO settings (id, custom_dir) VALUES (0, NULL);
         CREATE TABLE instances (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
                                 icon_path TEXT, install_stage TEXT, applied_content_set_id TEXT);
         CREATE TABLE instance_content_sets (id TEXT PRIMARY KEY, instance_id TEXT, name TEXT, source_kind TEXT,
                                 status TEXT, game_version TEXT, protocol_version INTEGER, loader TEXT,
                                 loader_version TEXT);",
    )
    .expect("schema");
    for (path, name, gv, l, lv) in rows {
        let id = format!("legacy:{path}");
        let cs = format!("cs-{path}");
        c.execute(
            "INSERT INTO instances (id, path, name, install_stage, applied_content_set_id) VALUES (?1, ?2, ?3, 'installed', ?4)",
            rusqlite::params![id, path, name, cs],
        )
        .expect("instance");
        c.execute(
            "INSERT INTO instance_content_sets (id, instance_id, name, source_kind, status, game_version, loader, loader_version)
             VALUES (?1, ?2, 'Default', 'local', 'applied', ?3, ?4, ?5)",
            rusqlite::params![cs, id, gv, l, lv],
        )
        .expect("content set");
    }
    c
}

/// SQLite URI for `path` (spaces etc. percent-encoded) — used only to show what
/// `immutable=1` would see.
fn sqlite_uri(path: &Path, query: &str) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    if !s.starts_with('/') {
        s.insert(0, '/');
    }
    let enc: String = s
        .chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '?' => "%3f".to_string(),
            '#' => "%23".to_string(),
            '%' => "%25".to_string(),
            c => c.to_string(),
        })
        .collect();
    format!("file://{enc}?{query}")
}

/// File name → SHA-1 of every file directly in `dir` (existence and bytes).
fn snapshot(dir: &Path) -> std::collections::BTreeMap<String, String> {
    fs::read_dir(dir)
        .expect("read dir")
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| {
            let bytes = fs::read(e.path()).expect("read");
            (e.file_name().to_string_lossy().into_owned(), hex::encode(<sha1::Sha1 as sha1::Digest>::digest(&bytes)))
        })
        .collect()
}

#[test]
fn modrinth_reads_uncheckpointed_wal_rows() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    let dir = e.data_dir().join("ModrinthApp");
    let db = dir.join("app.db");
    let writer = modrinth_gen_b_writer(&db, &[("live", "Live WAL Pack", "1.21.1", "neoforge", Some("21.1.77"))]);
    mkdir(&dir.join("profiles").join("live"));
    // Precondition: the data is only in the WAL. `immutable=1` (which ignores the WAL) sees
    // no tables at all, so a reader using it would miss the instance.
    assert!(fs::metadata(dir.join("app.db-wal")).expect("wal exists").len() > 0);
    let immutable = Connection::open_with_flags(
        sqlite_uri(&db, "immutable=1"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .expect("open immutable");
    let tables: i64 = immutable
        .query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table'", [], |r| r.get(0))
        .expect("count");
    assert_eq!(tables, 0, "test setup: rows must not be checkpointed yet");
    drop(immutable);

    let d = run_empty(&e);
    let i = find(&d, "Live WAL Pack");
    assert_eq!(i.metadata_source, MetadataSource::Launcher);
    assert_eq!(i.loader, loader(LoaderKind::Neoforge, "21.1.77"));
    assert_eq!(i.mc_version.as_deref(), Some("1.21.1"));
    assert!(probe_at(&d, Launcher::Modrinth, &dir).notes.is_empty());

    // Still uncheckpointed while the writer is open: discovery did not checkpoint it.
    let in_main: i64 = Connection::open_with_flags(
        sqlite_uri(&db, "immutable=1"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .expect("open immutable")
    .query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table'", [], |r| r.get(0))
    .expect("count");
    assert_eq!(in_main, 0);
    drop(writer);
}

#[test]
fn modrinth_discovery_never_modifies_the_database() {
    // Rollback-journal (pre-0.15 schema) and closed WAL (0.15+ schema) databases: every file
    // in the settings dir is byte-identical and no -wal/-shm/-journal file appears.
    // WAL with a live writer: app.db and app.db-wal are byte-identical and no file appears or
    // disappears. The -shm bytes are excluded there: it is SQLite's shared-memory index, in
    // which every reader (the Modrinth App's own included) records a read mark — that is the
    // locking protocol, not a change to the data.
    for case in ["rollback", "wal-closed", "wal-live"] {
        let t = tmp();
        let e = env(Os::Linux, &home(&t));
        let dir = e.data_dir().join("ModrinthApp");
        let db = dir.join("app.db");
        let writer = match case {
            "rollback" => {
                modrinth_gen_a(&db, None, &[("p", "Pack", Some("1.20.1"), Some("forge"), Some("47.3.0"))]);
                None
            }
            "wal-closed" => {
                modrinth_gen_b(&db, &[("p", "Pack", "1.20.1", "forge", Some("47.3.0"))]);
                None
            }
            _ => Some(modrinth_gen_b_writer(&db, &[("p", "Pack", "1.20.1", "forge", Some("47.3.0"))])),
        };
        mkdir(&dir.join("profiles").join("p"));
        let mask_shm = |mut s: std::collections::BTreeMap<String, String>| {
            if case == "wal-live" {
                if let Some(v) = s.get_mut("app.db-shm") {
                    *v = "present".into();
                }
            }
            s
        };
        let before = mask_shm(snapshot(&dir));
        let d = run_empty(&e);
        let after = mask_shm(snapshot(&dir));
        assert_eq!(before, after, "{case}: discovery changed the Modrinth folder");
        if case != "wal-live" {
            assert_eq!(before.keys().collect::<Vec<_>>(), vec!["app.db"], "{case}");
        }
        let i = find(&d, "Pack");
        assert_eq!(i.metadata_source, MetadataSource::Launcher, "{case}");
        assert_eq!(i.loader, loader(LoaderKind::Forge, "47.3.0"), "{case}");
        drop(writer);
    }
}

#[test]
fn modrinth_reads_a_read_only_database_file() {
    for wal in [false, true] {
        let t = tmp();
        let e = env(Os::Windows, &home(&t));
        let dir = e.data_dir().join("ModrinthApp");
        let db = dir.join("app.db");
        if wal {
            modrinth_gen_b(&db, &[("p", "Pack", "1.20.1", "fabric", Some("0.16.5"))]);
        } else {
            modrinth_gen_a(&db, None, &[("p", "Pack", Some("1.20.1"), Some("fabric"), Some("0.16.5"))]);
        }
        mkdir(&dir.join("profiles").join("p"));
        let mut perms = fs::metadata(&db).expect("meta").permissions();
        perms.set_readonly(true);
        fs::set_permissions(&db, perms.clone()).expect("set read-only");
        let before = snapshot(&dir);
        let d = run_empty(&e);
        let after = snapshot(&dir);
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&db, perms).expect("restore");
        assert_eq!(before, after, "wal={wal}");
        let i = find(&d, "Pack");
        assert_eq!(i.loader, loader(LoaderKind::Fabric, "0.16.5"), "wal={wal}: {:?}", d.report.probes);
    }
}

#[test]
fn modrinth_old_schema_every_os() {
    for os in OSES {
        let t = tmp();
        let e = env(os, &home(&t));
        let dir = e.data_dir().join("ModrinthApp");
        modrinth_gen_a(
            &dir.join("app.db"),
            None,
            &[
                ("fabric pack", "Fabric Pack", Some("1.20.1"), Some("fabric"), Some("0.15.11")),
                ("plain", "Plain", Some("1.21"), Some("vanilla"), None),
            ],
        );
        jars(&dir.join("profiles").join("fabric pack"), 3);
        mkdir(&dir.join("profiles").join("plain"));
        let d = run_empty(&e);
        assert_eq!(d.report.instances.len(), 2, "{os:?}");
        let f = find(&d, "Fabric Pack");
        assert_eq!(f.launcher, Launcher::Modrinth);
        assert_eq!(f.mc_version.as_deref(), Some("1.20.1"));
        assert_eq!(f.loader, loader(LoaderKind::Fabric, "0.15.11"));
        assert_eq!(f.metadata_source, MetadataSource::Launcher);
        assert_eq!(f.mod_count, 4);
        assert_eq!(f.side, Side::Client);
        assert_eq!(f.game_dir, f.root);
        let p = find(&d, "Plain");
        assert_eq!(p.loader, None);
        assert_eq!(p.mc_version.as_deref(), Some("1.21"));
        assert_eq!(p.metadata_source, MetadataSource::Launcher);
        let probe = probe_at(&d, Launcher::Modrinth, &dir);
        assert_eq!(probe.result, ProbeResult::Found { count: 2 });
        assert!(probe.notes.is_empty(), "{:?}", probe.notes);
    }
}

#[test]
fn modrinth_new_schema() {
    for os in OSES {
        let t = tmp();
        let e = env(os, &home(&t));
        let dir = e.data_dir().join("ModrinthApp");
        modrinth_gen_b(
            &dir.join("app.db"),
            &[
                ("atm", "All the Mods", "1.20.1", "neoforge", Some("47.1.106")),
                ("q", "Quilty", "26.1", "quilt", Some("0.26.4")),
            ],
        );
        jars(&dir.join("profiles").join("atm"), 2);
        mkdir(&dir.join("profiles").join("q"));
        mkdir(&dir.join("profiles").join("stray"));
        let d = run_empty(&e);
        let a = find(&d, "All the Mods");
        assert_eq!(a.loader, loader(LoaderKind::Neoforge, "47.1.106"));
        assert_eq!(a.mc_version.as_deref(), Some("1.20.1"));
        assert_eq!(a.mod_count, 3);
        assert_eq!(find(&d, "Quilty").loader, loader(LoaderKind::Quilt, "0.26.4"));
        let stray = find(&d, "stray");
        assert_eq!(stray.metadata_source, MetadataSource::Inferred);
        let probe = probe_at(&d, Launcher::Modrinth, &dir);
        assert_eq!(probe.result, ProbeResult::Found { count: 3 });
        assert!(probe.notes.iter().any(|n| n.contains("not in app.db")), "{:?}", probe.notes);
    }
}

#[test]
fn modrinth_schema_mismatch_falls_back_to_folders() {
    let t = tmp();
    let e = env(Os::Linux, &home(&t));
    let dir = e.data_dir().join("ModrinthApp");
    mkdir(&dir);
    Connection::open(dir.join("app.db"))
        .expect("open")
        .execute_batch("CREATE TABLE future_things (id TEXT, path TEXT);")
        .expect("schema");
    jars(&dir.join("profiles").join("pack"), 1);
    let d = run_empty(&e);
    let i = find(&d, "pack");
    assert_eq!(i.metadata_source, MetadataSource::Inferred);
    assert_eq!(i.mc_version, None);
    let probe = probe_at(&d, Launcher::Modrinth, &dir);
    assert_eq!(probe.result, ProbeResult::Found { count: 1 });
    assert!(probe.notes.iter().any(|n| n.contains("schema not recognised")), "{:?}", probe.notes);
}

#[test]
fn modrinth_corrupt_db_is_a_note() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    let dir = e.data_dir().join("ModrinthApp");
    write(&dir.join("app.db"), b"this is not a sqlite database at all, just text padding......");
    mkdir(&dir.join("profiles").join("p"));
    let d = run_empty(&e);
    assert_eq!(find(&d, "p").metadata_source, MetadataSource::Inferred);
    let probe = probe_at(&d, Launcher::Modrinth, &dir);
    assert!(probe.notes.iter().any(|n| n.contains("could not be read")), "{:?}", probe.notes);
}

#[test]
fn modrinth_busy_db_retries_then_notes() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    let dir = e.data_dir().join("ModrinthApp");
    let db = dir.join("app.db");
    modrinth_gen_a(&db, None, &[("p", "Pack", Some("1.20.1"), Some("forge"), Some("47.3.0"))]);
    mkdir(&dir.join("profiles").join("p"));
    // Rollback-journal mode: an exclusive transaction blocks every reader.
    let writer = Connection::open(&db).expect("open writer");
    writer.execute_batch("BEGIN EXCLUSIVE; UPDATE profiles SET name = 'Locked';").expect("lock");
    let d = run_empty(&e);
    writer.execute_batch("ROLLBACK").expect("rollback");
    let i = find(&d, "p");
    assert_eq!(i.metadata_source, MetadataSource::Inferred);
    let probe = probe_at(&d, Launcher::Modrinth, &dir);
    assert_eq!(probe.result, ProbeResult::Found { count: 1 });
    assert!(probe.notes.iter().any(|n| n.contains("busy") && n.contains("retried 3×")), "{:?}", probe.notes);
    // The reader never wrote: the row is unchanged after the writer rolled back.
    let name: String = Connection::open(&db)
        .expect("open")
        .query_row("SELECT name FROM profiles WHERE path = 'p'", [], |r| r.get(0))
        .expect("query");
    assert_eq!(name, "Pack");
}

#[test]
fn modrinth_custom_dir() {
    let t = tmp();
    let e = env(Os::MacOs, &home(&t));
    let dir = e.data_dir().join("ModrinthApp");
    let custom = t.path().join("D Drive").join("Modrinth Data");
    jars(&custom.join("profiles").join("big"), 5);
    let custom_s = custom.to_string_lossy().into_owned();
    modrinth_gen_a(&dir.join("app.db"), Some(&custom_s), &[("big", "Big Pack", Some("1.20.1"), Some("forge"), Some("47.3.0"))]);
    // A stale profiles dir next to app.db must be ignored.
    mkdir(&dir.join("profiles").join("old-ignored"));
    let d = run_empty(&e);
    assert_eq!(d.report.instances.len(), 1);
    let i = find(&d, "Big Pack");
    assert_eq!(i.mod_count, 6);
    assert!(i.root.contains("Modrinth Data"));
    let probe = probe_at(&d, Launcher::Modrinth, &dir);
    assert!(probe.notes.iter().any(|n| n.contains("custom data folder")), "{:?}", probe.notes);
    assert!(d.roots.contains(&canon(&custom.join("profiles").join("big"))));
}

#[test]
fn modrinth_legacy_theseus_dir() {
    for os in OSES {
        let t = tmp();
        let e = env(os, &home(&t));
        let dir = e.config_dir().join("com.modrinth.theseus");
        let prof = dir.join("profiles").join("Old Pack");
        jars(&prof, 1);
        write(
            &prof.join("profile.json"),
            r#"{"path":"Old Pack","metadata":{"name":"Old Pack ✓","game_version":"1.19.2","loader":"forge",
                "loader_version":{"id":"43.2.0","url":"x","stable":true}}}"#,
        );
        let broken = dir.join("profiles").join("broken");
        mkdir(&broken);
        write(&broken.join("profile.json"), b"{not json");
        let d = run_empty(&e);
        let i = find(&d, "Old Pack ✓");
        assert_eq!(i.mc_version.as_deref(), Some("1.19.2"));
        assert_eq!(i.loader, loader(LoaderKind::Forge, "43.2.0"));
        assert_eq!(find(&d, "broken").metadata_source, MetadataSource::Inferred);
        let probe = probe_at(&d, Launcher::Modrinth, &dir);
        assert_eq!(probe.result, ProbeResult::Found { count: 2 });
        assert!(probe.notes.iter().any(|n| n.contains("broken")), "{:?}", probe.notes);
    }
    // Linux legacy lives in the *config* dir.
    let t = tmp();
    let e = env(Os::Linux, &home(&t));
    assert!(e.config_dir().join("com.modrinth.theseus").starts_with(e.home.join(".config")));
}

#[test]
fn modrinth_theseus_config_dir_override() {
    let t = tmp();
    let mut e = env(Os::Linux, &home(&t));
    let dir = t.path().join("override");
    e.vars.insert("THESEUS_CONFIG_DIR".into(), dir.to_string_lossy().into_owned());
    modrinth_gen_b(&dir.join("app.db"), &[("x", "X", "1.20.1", "fabric", Some("0.16.5"))]);
    mkdir(&dir.join("profiles").join("x"));
    let d = run_empty(&e);
    assert_eq!(find(&d, "X").loader, loader(LoaderKind::Fabric, "0.16.5"));
    assert_eq!(probe_at(&d, Launcher::Modrinth, &dir).result, ProbeResult::Found { count: 1 });
}

// ---------------------------------------------------------------------------------------------
// Prism / MultiMC

fn prism_instance(inst: &Path, cfg: &[u8], pack: Option<&str>, game: &str, mods: usize) {
    write(&inst.join("instance.cfg"), cfg);
    if let Some(p) = pack {
        write(&inst.join("mmc-pack.json"), p);
    }
    jars(&inst.join(game), mods);
}

const FABRIC_PACK: &str = r#"{"formatVersion":1,"components":[
    {"uid":"org.lwjgl3","version":"3.3.1","dependencyOnly":true},
    {"uid":"net.minecraft","version":"1.20.1","important":true},
    {"uid":"net.fabricmc.intermediary","version":"1.20.1","dependencyOnly":true},
    {"uid":"net.minecraftforge","version":"47.3.0","disabled":true},
    {"uid":"net.fabricmc.fabric-loader","version":"0.16.5","cachedName":"Fabric Loader"}]}"#;

#[test]
fn prism_relative_instance_dir_every_os() {
    for os in OSES {
        let t = tmp();
        let e = env(os, &home(&t));
        let data = e.data_dir().join("PrismLauncher");
        write(&data.join("prismlauncher.cfg"), "[General]\nInstanceDir=my instances\nLanguage=en\n");
        prism_instance(&data.join("my instances").join("inst1"), b"InstanceType=OneSix\nname=Fabric 1\n", Some(FABRIC_PACK), "minecraft", 2);
        // Default folder must be ignored when InstanceDir points elsewhere.
        prism_instance(&data.join("instances").join("ignored"), b"name=Ignored\n", None, "minecraft", 0);
        let d = run_empty(&e);
        assert_eq!(d.report.instances.len(), 1, "{os:?}: {:#?}", d.report.instances);
        let i = find(&d, "Fabric 1");
        assert_eq!(i.launcher, Launcher::Prism);
        assert_eq!(i.mc_version.as_deref(), Some("1.20.1"));
        // Disabled Forge component is skipped.
        assert_eq!(i.loader, loader(LoaderKind::Fabric, "0.16.5"));
        assert_eq!(i.mod_count, 3);
        assert!(Path::new(&i.game_dir).ends_with("minecraft"));
        assert_eq!(probe_at(&d, Launcher::Prism, &data).result, ProbeResult::Found { count: 1 });
    }
}

#[test]
fn prism_absolute_quoted_instance_dir() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    let data = e.data_dir().join("PrismLauncher");
    let inst_dir = t.path().join("Games").join("Instänces");
    // Qt writes forward slashes; quoted values may double backslashes.
    let fwd = inst_dir.to_string_lossy().replace('\\', "/");
    write(&data.join("prismlauncher.cfg"), format!("InstanceDir=\"{fwd}\"\n"));
    prism_instance(&inst_dir.join("a"), b"name=Abs\n", Some(r#"{"components":[{"uid":"net.minecraft","version":"1.21.1"},{"uid":"net.neoforged","version":"21.1.77"}]}"#), "minecraft", 1);
    let d = run_empty(&e);
    let i = find(&d, "Abs");
    assert_eq!(i.loader, loader(LoaderKind::Neoforge, "21.1.77"));
    assert_eq!(i.mc_version.as_deref(), Some("1.21.1"));
    let probe = probe_at(&d, Launcher::Prism, &data);
    assert!(probe.notes.iter().any(|n| n.contains("instances are in")), "{:?}", probe.notes);
}

#[test]
fn prism_flatpak_and_game_dir_rule() {
    let t = tmp();
    let e = env(Os::Linux, &home(&t));
    let data = rel(&e.home, ".var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher");
    let inst = data.join("instances");
    // Only `.minecraft` → use it.
    prism_instance(&inst.join("dot"), b"name=Dot\n", Some(FABRIC_PACK), ".minecraft", 1);
    // Both → `minecraft` wins.
    prism_instance(&inst.join("both"), b"name=Both\n", Some(FABRIC_PACK), "minecraft", 2);
    jars(&inst.join("both").join(".minecraft"), 7);
    // Neither (never launched) → `minecraft`.
    prism_instance(&inst.join("new"), b"name=New\n", None, "unused", 0);
    fs::remove_dir_all(inst.join("new").join("unused")).expect("rm");
    // Not an instance (no instance.cfg) and a dot-folder are skipped.
    mkdir(&inst.join("random"));
    write(&inst.join(".LAUNCHER_TEMP").join("instance.cfg"), b"name=Temp\n");
    let d = run_empty(&e);
    assert_eq!(d.report.instances.len(), 3, "{:#?}", d.report.instances);
    assert!(Path::new(&find(&d, "Dot").game_dir).ends_with(".minecraft"));
    let both = find(&d, "Both");
    assert!(Path::new(&both.game_dir).ends_with("minecraft") && !both.game_dir.ends_with(".minecraft"));
    assert_eq!(both.mod_count, 3);
    let new = find(&d, "New");
    assert!(Path::new(&new.game_dir).ends_with("minecraft"));
    assert_eq!(new.metadata_source, MetadataSource::Inferred);
    let probe = probe_at(&d, Launcher::Prism, &data);
    assert_eq!(probe.result, ProbeResult::Found { count: 3 });
    assert!(probe.notes.iter().any(|n| n.contains("New: no mmc-pack.json")), "{:?}", probe.notes);
    // `roots` holds only existing paths: New's missing game dir is absent, its root present.
    assert!(d.roots.contains(&canon(&inst.join("new"))));
    assert!(!d.roots.iter().any(|r| r.ends_with(Path::new("new").join("minecraft"))));
}

#[test]
fn prism_non_utf8_and_malformed_pack() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    let inst = e.data_dir().join("PrismLauncher").join("instances");
    prism_instance(&inst.join("cafe"), b"name=Caf\xE9 Pack\n", Some("{ broken"), "minecraft", 0);
    prism_instance(&inst.join("cjk"), "name=日本語 パック 🎮\n".as_bytes(), Some(FABRIC_PACK), "minecraft", 0);
    let d = run_empty(&e);
    assert_eq!(find(&d, "Café Pack").metadata_source, MetadataSource::Inferred);
    assert_eq!(find(&d, "日本語 パック 🎮").loader, loader(LoaderKind::Fabric, "0.16.5"));
    let probe = probe_at(&d, Launcher::Prism, &e.data_dir().join("PrismLauncher"));
    assert!(probe.notes.iter().any(|n| n.contains("Café Pack") && n.contains("not valid JSON")), "{:?}", probe.notes);
}

#[test]
fn multimc_portable_and_prism_userdata_roots() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    let mmc = t.path().join("Tools").join("MultiMC");
    write(&mmc.join("multimc.cfg"), "InstanceDir=instances\n");
    write(&mmc.join("MultiMC.exe"), b"MZ");
    prism_instance(&mmc.join("instances").join("m"), b"name=MMC Pack\n", Some(FABRIC_PACK), ".minecraft", 1);
    let portable = t.path().join("PrismPortable");
    write(&portable.join("portable.txt"), b"");
    write(&portable.join("UserData").join("prismlauncher.cfg"), "InstanceDir=instances\n");
    prism_instance(&portable.join("UserData").join("instances").join("p"), b"name=Portable\n", Some(FABRIC_PACK), "minecraft", 1);
    // A root that *is* an instance folder.
    let bare = t.path().join("BareInstances");
    prism_instance(&bare.join("b"), b"name=Bare\n", None, "minecraft", 0);
    let input = DiscoveryInput {
        manual_folders: vec![],
        launcher_roots: vec![(Launcher::Multimc, mmc.clone()), (Launcher::Prism, portable.clone()), (Launcher::Prism, bare.clone())],
    };
    let d = run(&e, &input);
    assert_eq!(find(&d, "MMC Pack").launcher, Launcher::Multimc);
    assert!(Path::new(&find(&d, "MMC Pack").game_dir).ends_with(".minecraft"));
    assert_eq!(find(&d, "Portable").launcher, Launcher::Prism);
    assert_eq!(find(&d, "Bare").launcher, Launcher::Prism);
    assert_eq!(probe_at(&d, Launcher::Multimc, &mmc).result, ProbeResult::Found { count: 1 });
    assert!(probe_at(&d, Launcher::Prism, &portable).notes.iter().any(|n| n.contains("portable")));
}

#[test]
fn prism_alias_and_loop_links_are_listed_once() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    let data = e.data_dir().join("PrismLauncher");
    let inst = data.join("instances");
    prism_instance(&inst.join("A"), b"name=Real\n", Some(FABRIC_PACK), "minecraft", 1);
    link_dir(&inst.join("A"), &inst.join("alias"));
    link_dir(&inst, &inst.join("loop"));
    let d = run_empty(&e);
    assert_eq!(d.report.instances.len(), 1, "{:#?}", d.report.instances);
    assert_eq!(probe_at(&d, Launcher::Prism, &data).result, ProbeResult::Found { count: 1 });
}

// ---------------------------------------------------------------------------------------------
// CurseForge

fn cf_json(name: &str, gv: &str, loader_name: &str, extra: &str) -> String {
    format!(
        r#"{{"name":"{name}","gameVersion":"{gv}","baseModLoader":{{"name":"{loader_name}","forgeVersion":"x","minecraftVersion":"{gv}","type":1{extra}}},"installedAddons":[]}}"#
    )
}

#[test]
fn curseforge_both_locations_and_loaders() {
    for os in OSES {
        let t = tmp();
        let mut e = env(os, &home(&t));
        // OneDrive-redirected Documents.
        e.documents = Some(e.home.join("OneDrive").join("Dokumente"));
        let home_inst = e.home.join("curseforge").join("minecraft").join("Instances");
        let doc_inst = e.documents_dir().join("curseforge").join("minecraft").join("Instances");
        let a = home_inst.join("ATM9");
        write(&a.join("minecraftinstance.json"), cf_json("All the Mods 9", "1.20.1", "forge-47.3.0", ""));
        jars(&a, 2);
        let b = doc_inst.join("Neo");
        write(&b.join("minecraftinstance.json"), format!("\u{feff}{}", cf_json("Neo", "1.21.1", "neoforge-21.1.256", "")));
        let c = doc_inst.join("Fab");
        write(&c.join("minecraftinstance.json"), r#"{"name":"Fab","baseModLoader":{"name":"fabric-0.15.11-1.20.1"}}"#);
        let v = doc_inst.join("Van");
        write(&v.join("minecraftinstance.json"), r#"{"name":"Van","gameVersion":"1.20.4","baseModLoader":null}"#);
        let bad = doc_inst.join("Bad");
        write(&bad.join("minecraftinstance.json"), "{oops");
        mkdir(&doc_inst.join("not-an-instance"));
        let d = run_empty(&e);
        let atm = find(&d, "All the Mods 9");
        assert_eq!(atm.launcher, Launcher::Curseforge);
        assert_eq!(atm.loader, loader(LoaderKind::Forge, "47.3.0"));
        assert_eq!(atm.mc_version.as_deref(), Some("1.20.1"));
        assert_eq!(atm.mod_count, 3);
        assert_eq!(atm.root, atm.game_dir);
        assert_eq!(find(&d, "Neo").loader, loader(LoaderKind::Neoforge, "21.1.256"));
        let fab = find(&d, "Fab");
        assert_eq!(fab.loader, loader(LoaderKind::Fabric, "0.15.11"));
        assert_eq!(fab.mc_version.as_deref(), Some("1.20.1"));
        let van = find(&d, "Van");
        assert_eq!((van.loader.clone(), van.mc_version.as_deref()), (None, Some("1.20.4")));
        assert_eq!(van.metadata_source, MetadataSource::Launcher);
        assert_eq!(find(&d, "Bad").metadata_source, MetadataSource::Inferred);
        assert_eq!(probe_at(&d, Launcher::Curseforge, &home_inst).result, ProbeResult::Found { count: 1 });
        let doc_probe = probe_at(&d, Launcher::Curseforge, &doc_inst);
        assert_eq!(doc_probe.result, ProbeResult::Found { count: 4 });
        assert!(doc_probe.notes.iter().any(|n| n.contains("Bad")), "{:?}", doc_probe.notes);
    }
}

#[test]
fn curseforge_loader_name_parsing() {
    use super::curseforge::parse_loader_name;
    let p = |s: &str| parse_loader_name(s, None).map(|(l, mc)| (l.kind, l.version, mc));
    let pk = |s: &str, k: &str| parse_loader_name(s, Some(k)).map(|(l, mc)| (l.kind, l.version, mc));
    let s = |x: &str| Some(x.to_string());
    // Hyphens in the loader version and/or the MC version.
    assert_eq!(p("fabric-0.16.0-beta.1-1.20.1"), Some((LoaderKind::Fabric, s("0.16.0-beta.1"), s("1.20.1"))));
    assert_eq!(p("quilt-0.26.4-1.20.5-pre1"), Some((LoaderKind::Quilt, s("0.26.4"), s("1.20.5-pre1"))));
    assert_eq!(
        p("quilt-0.26.4-beta.2-1.20.5-pre1"),
        Some((LoaderKind::Quilt, s("0.26.4-beta.2"), s("1.20.5-pre1")))
    );
    // The instance's gameVersion settles splits the heuristic would get wrong.
    assert_eq!(
        pk("fabric-0.16.0-1.2-1.20.5-pre1", "1.20.5-pre1"),
        Some((LoaderKind::Fabric, s("0.16.0-1.2"), s("1.20.5-pre1")))
    );
    assert_eq!(p("forge-47.3.0"), Some((LoaderKind::Forge, s("47.3.0"), None)));
    assert_eq!(p("neoforge-21.1.256"), Some((LoaderKind::Neoforge, s("21.1.256"), None)));
    assert_eq!(p("fabric-0.15.11-1.20.1"), Some((LoaderKind::Fabric, s("0.15.11"), s("1.20.1"))));
    assert_eq!(p("quilt-0.26.4-1.20.1"), Some((LoaderKind::Quilt, s("0.26.4"), s("1.20.1"))));
    assert_eq!(p("fabric-0.16.0-26.4-snapshot-6"), Some((LoaderKind::Fabric, s("0.16.0"), s("26.4-snapshot-6"))));
    assert_eq!(p("liteloader-1.12"), None);
    assert_eq!(p("forge"), None);
}

#[test]
fn curseforge_type_fallback_and_custom_root() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    let custom = t.path().join("E").join("CF Folder");
    let inst = custom.join("minecraft").join("Instances").join("Q");
    write(&inst.join("minecraftinstance.json"), r#"{"name":"Q","gameVersion":"1.20.1","baseModLoader":{"name":"weird","forgeVersion":"0.26.4","type":5}}"#);
    let input = DiscoveryInput { manual_folders: vec![], launcher_roots: vec![(Launcher::Curseforge, custom.clone())] };
    let d = run(&e, &input);
    assert_eq!(find(&d, "Q").loader, loader(LoaderKind::Quilt, "0.26.4"));
}

// ---------------------------------------------------------------------------------------------
// Vanilla

#[test]
fn vanilla_default_dirs_every_os() {
    for (os, sub) in [(Os::Windows, "AppData/Roaming/.minecraft"), (Os::MacOs, "Library/Application Support/minecraft"), (Os::Linux, ".minecraft")] {
        let t = tmp();
        let h = home(&t);
        let e = env(os, &h);
        let root = rel(&h, sub);
        jars(&root, 1);
        let d = run_empty(&e);
        let i = d.report.instances.iter().find(|i| i.launcher == Launcher::Vanilla).expect("vanilla");
        assert_eq!(i.name, "Minecraft");
        assert_eq!(i.metadata_source, MetadataSource::Inferred);
        assert_eq!(probe_at(&d, Launcher::Vanilla, &root).result, ProbeResult::Found { count: 1 });
    }
}

#[test]
fn vanilla_profiles_with_custom_game_dirs() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    let root = e.data_dir().join(".minecraft");
    let pack = t.path().join("Packs").join("My Pack");
    jars(&pack, 2);
    mkdir(&root.join("relative dir"));
    write(
        &root.join("versions").join("custom-fabric").join("custom-fabric.json"),
        r#"{"id":"custom-fabric","inheritsFrom":"1.20.4","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.5"}]}"#,
    );
    let pack_s = serde_json::to_string(&pack.to_string_lossy()).expect("json");
    write(
        &root.join("launcher_profiles.json"),
        format!(
            r#"{{"profiles":{{
              "a":{{"name":"","type":"latest-release","lastVersionId":"latest-release","lastUsed":"2026-01-01T00:00:00Z"}},
              "b":{{"name":"Forge Pack","type":"custom","lastVersionId":"1.20.1-forge-47.3.0","gameDir":{pack_s},"lastUsed":"2026-10-01T00:00:00Z"}},
              "c":{{"name":"Forge Pack (old)","type":"custom","lastVersionId":"1.19.2","gameDir":{pack_s},"lastUsed":"2025-01-01T00:00:00Z"}},
              "d":{{"name":"Relative","type":"custom","lastVersionId":"custom-fabric","gameDir":"relative dir"}},
              "e":{{"name":"Gone","type":"custom","lastVersionId":"1.20.1","gameDir":"C:/definitely/missing/dir"}}
            }}}}"#
        ),
    );
    write(&root.join("launcher_accounts.json"), b"{\"secret\":\"never read\"}");
    let d = run_empty(&e);
    let vanilla: Vec<_> = d.report.instances.iter().filter(|i| i.launcher == Launcher::Vanilla).collect();
    assert_eq!(vanilla.len(), 3, "{vanilla:#?}");
    let latest = find(&d, "Latest release");
    assert_eq!(latest.mc_version, None);
    let forge = find(&d, "Forge Pack");
    assert_eq!(forge.loader, loader(LoaderKind::Forge, "47.3.0"));
    assert_eq!(forge.mc_version.as_deref(), Some("1.20.1"));
    assert_eq!(forge.mod_count, 3);
    let rel = find(&d, "Relative");
    assert_eq!(rel.loader, loader(LoaderKind::Fabric, "0.16.5"));
    assert_eq!(rel.mc_version.as_deref(), Some("1.20.4"));
    let probe = probe_at(&d, Launcher::Vanilla, &root);
    assert_eq!(probe.result, ProbeResult::Found { count: 3 });
    assert!(probe.notes.iter().any(|n| n.contains("Gone")), "{:?}", probe.notes);
}

#[test]
fn vanilla_malformed_profiles_still_lists_root() {
    let t = tmp();
    let e = env(Os::Linux, &home(&t));
    let root = e.home.join(".minecraft");
    write(&root.join("launcher_profiles.json"), b"{\"profiles\": [");
    let d = run_empty(&e);
    assert_eq!(find(&d, "Minecraft").launcher, Launcher::Vanilla);
    assert!(probe_at(&d, Launcher::Vanilla, &root).notes.iter().any(|n| n.contains("not valid JSON")));
}

// ---------------------------------------------------------------------------------------------
// Manual folders, side, links, ids

#[test]
fn manual_folder_merges_with_launcher_instance() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    let data = e.data_dir().join("PrismLauncher");
    let inst = data.join("instances").join("shared");
    prism_instance(&inst, b"name=Shared\n", Some(FABRIC_PACK), "minecraft", 2);
    // Once as the instance root, once as the game dir (in different case where the file system
    // ignores case; on a case-sensitive one, such as Linux CI, the upper-case path doesn't exist).
    let game = inst.join("minecraft");
    let upper = PathBuf::from(game.to_string_lossy().to_uppercase());
    let game_upper = if upper.exists() { upper } else { game };
    let input = DiscoveryInput { manual_folders: vec![inst.clone(), game_upper.clone()], launcher_roots: vec![] };
    let d = run(&e, &input);
    assert_eq!(d.report.instances.len(), 1, "{:#?}", d.report.instances);
    assert_eq!(d.report.instances[0].launcher, Launcher::Prism);
    let manual: Vec<_> = d.report.probes.iter().filter(|p| p.launcher == Launcher::Manual).collect();
    assert_eq!(manual.len(), 2);
    for p in manual {
        assert_eq!(p.result, ProbeResult::Found { count: 1 });
        assert!(p.notes.iter().any(|n| n.contains("listed once") && n.contains("Prism")), "{:?}", p.notes);
    }
}

#[test]
fn manual_folder_locates_game_dir_and_reads_metadata() {
    let t = tmp();
    let e = env(Os::Linux, &home(&t));
    let root = t.path().join("Мой сборник");
    write(&root.join("instance.cfg"), "name=Copied Instance\n");
    write(&root.join("mmc-pack.json"), FABRIC_PACK);
    jars(&root.join(".minecraft"), 1);
    let plain = t.path().join("plain");
    mkdir(&plain);
    let missing = t.path().join("missing");
    let input = DiscoveryInput { manual_folders: vec![root.clone(), plain.clone(), missing.clone()], launcher_roots: vec![] };
    let d = run(&e, &input);
    let i = find(&d, "Copied Instance");
    assert_eq!(i.launcher, Launcher::Manual);
    assert!(Path::new(&i.game_dir).ends_with(".minecraft"));
    assert_eq!(i.loader, loader(LoaderKind::Fabric, "0.16.5"));
    assert_eq!(i.mod_count, 2);
    let p = find(&d, "plain");
    assert_eq!(p.metadata_source, MetadataSource::Inferred);
    assert!(probe_at(&d, Launcher::Manual, &plain).notes.iter().any(|n| n.contains("no mods folder")));
    assert!(matches!(probe_at(&d, Launcher::Manual, &missing).result, ProbeResult::Error { .. }));
}

#[test]
fn server_detection() {
    let t = tmp();
    let e = env(Os::Linux, &home(&t));
    let srv = t.path().join("server");
    jars(&srv, 1);
    write(&srv.join("server.properties"), b"motd=x");
    write(&srv.join("eula.txt"), b"eula=true");
    let forge_srv = t.path().join("forge-server");
    jars(&forge_srv, 1);
    write(&forge_srv.join("user_jvm_args.txt"), b"");
    write(&forge_srv.join("run.sh"), b"#!/bin/sh");
    write(&forge_srv.join("libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt"), b"");
    let neo_srv = t.path().join("neo-server");
    jars(&neo_srv, 0);
    write(&neo_srv.join("libraries/net/neoforged/neoforge/21.1.77/win_args.txt"), b"");
    let client = t.path().join("client");
    jars(&client, 1);
    write(&client.join("options.txt"), b"");
    write(&client.join("servers.dat"), b"");
    let weak = t.path().join("weak");
    jars(&weak, 1);
    write(&weak.join("ops.json"), b"[]");
    let input = DiscoveryInput {
        manual_folders: vec![srv, forge_srv, neo_srv, client, weak],
        launcher_roots: vec![],
    };
    let d = run(&e, &input);
    assert_eq!(find(&d, "server").side, Side::Server);
    assert_eq!(find(&d, "forge-server").side, Side::Server);
    assert_eq!(find(&d, "neo-server").side, Side::Server);
    assert_eq!(find(&d, "client").side, Side::Client);
    assert_eq!(find(&d, "weak").side, Side::Client);
}

#[test]
fn linked_mods_target_is_a_root() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    let inst = e.data_dir().join("PrismLauncher").join("instances").join("linked");
    write(&inst.join("instance.cfg"), "name=Linked\n");
    write(&inst.join("mmc-pack.json"), FABRIC_PACK);
    let game = inst.join("minecraft");
    mkdir(&game.join("logs"));
    let shared = t.path().join("Shared Mods ü");
    jars(&shared.join("pool"), 2);
    link_dir(&shared.join("pool").join("mods"), &game.join("mods"));
    let crash_target = t.path().join("crash target");
    mkdir(&crash_target);
    link_dir(&crash_target, &game.join("crash-reports"));
    let d = run_empty(&e);
    let i = find(&d, "Linked");
    assert_eq!(i.mod_count, 3);
    assert!(d.roots.contains(&canon(&inst)));
    assert!(d.roots.contains(&canon(&game)));
    assert!(d.roots.contains(&canon(&shared.join("pool").join("mods"))), "{:#?}", d.roots);
    assert!(d.roots.contains(&canon(&crash_target)));
    // A plain logs/ is inside the game dir, not a separate root.
    assert!(!d.roots.contains(&canon(&game.join("logs"))));
    // Every root works with PathGuard.
    let guard = crate::guard::PathGuard::new();
    for r in &d.roots {
        guard.add_root(r).expect("add root");
    }
    assert!(guard.check_existing(&game.join("mods").join("mod0.jar")).is_ok());
    assert_eq!(guard_roots(&inst, &game), d.roots);
}

#[test]
fn missing_launchers_are_not_installed() {
    for os in OSES {
        let t = tmp();
        let e = env(os, &home(&t));
        let d = run_empty(&e);
        assert!(d.report.instances.is_empty());
        assert!(d.roots.is_empty());
        assert!(!d.report.probes.is_empty());
        for p in &d.report.probes {
            assert_eq!(p.result, ProbeResult::NotInstalled, "{p:?}");
            assert!(Path::new(&p.path).starts_with(&e.home), "probe outside the fake home: {p:?}");
        }
        for l in [Launcher::Modrinth, Launcher::Prism, Launcher::Multimc, Launcher::Curseforge, Launcher::Vanilla] {
            assert!(d.report.probes.iter().any(|p| p.launcher == l), "{os:?}: no {l:?} probe");
        }
        probe_at(&d, Launcher::Modrinth, &e.data_dir().join("ModrinthApp"));
        probe_at(&d, Launcher::Modrinth, &e.config_dir().join("com.modrinth.theseus"));
        probe_at(&d, Launcher::Prism, &e.data_dir().join("PrismLauncher"));
        probe_at(&d, Launcher::Curseforge, &e.home.join("curseforge").join("minecraft").join("Instances"));
        probe_at(&d, Launcher::Curseforge, &e.documents_dir().join("curseforge").join("minecraft").join("Instances"));
    }
}

#[test]
fn file_instead_of_folder_and_mrpack_root_are_errors() {
    let t = tmp();
    let e = env(Os::Linux, &home(&t));
    let modrinth = e.data_dir().join("ModrinthApp");
    write(&modrinth, b"not a dir");
    let mr = t.path().join("pack.mrpack");
    write(&mr, b"PK");
    let input = DiscoveryInput { manual_folders: vec![], launcher_roots: vec![(Launcher::Mrpack, mr.clone())] };
    let d = run(&e, &input);
    assert!(matches!(probe_at(&d, Launcher::Modrinth, &modrinth).result, ProbeResult::Error { .. }));
    assert!(matches!(probe_at(&d, Launcher::Mrpack, &mr).result, ProbeResult::Error { .. }));
}

#[test]
fn instance_id_is_stable_and_case_folded() {
    let t = tmp();
    let game = t.path().join("Game Dir ü");
    mkdir(&game);
    let id = instance_id(&game, Os::Windows);
    assert_eq!(id.len(), 16);
    assert!(id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    assert_eq!(id, instance_id(&game, Os::Windows));
    assert_eq!(id, instance_id(&game.join("."), Os::Windows));
    // Matches the contract formula exactly.
    let canon_s = canon(&game).to_string_lossy().to_lowercase();
    let expected = hex::encode(<sha1::Sha1 as sha1::Digest>::digest(canon_s.as_bytes()));
    assert_eq!(id, expected[..16]);
    // Case-folding on Windows/macOS, not on Linux (paths that do not exist are hashed lexically).
    let a = t.path().join("Missing Pack");
    let b = t.path().join("missing pack");
    assert_eq!(instance_id(&a, Os::Windows), instance_id(&b, Os::Windows));
    assert_eq!(instance_id(&a, Os::MacOs), instance_id(&b, Os::MacOs));
    assert_ne!(instance_id(&a, Os::Linux), instance_id(&b, Os::Linux));
    // Ids in a report equal instance_id(game_dir).
    let e = env(Os::Windows, &home(&t));
    let d = run(&e, &DiscoveryInput { manual_folders: vec![game.clone()], launcher_roots: vec![] });
    assert_eq!(d.report.instances[0].id, id);
}

#[test]
fn instance_id_survives_first_launch_under_a_linked_parent() {
    let t = tmp();
    // e.g. a OneDrive-redirected or junctioned Instances folder.
    let real = t.path().join("Real Instances");
    mkdir(&real);
    let linked = t.path().join("Linked Instances");
    link_dir(&real, &linked);
    let game = linked.join("Pack").join("minecraft");
    for os in OSES {
        let before = instance_id(&game, os);
        // Same folder reached through the real path.
        assert_eq!(before, instance_id(&real.join("Pack").join("minecraft"), os), "{os:?}");
        mkdir(&game);
        assert_eq!(before, instance_id(&game, os), "{os:?}: id changed after the game dir was created");
        fs::remove_dir_all(real.join("Pack")).expect("rm");
    }
    // Discovery of a never-launched Prism instance under a linked instance dir keeps its id.
    let e = env(Os::Windows, &home(&t));
    let data = e.data_dir().join("PrismLauncher");
    write(&data.join("prismlauncher.cfg"), format!("InstanceDir={}\n", linked.to_string_lossy().replace('\\', "/")));
    write(&linked.join("New").join("instance.cfg"), "name=Never Launched\n");
    let id_before = find(&run_empty(&e), "Never Launched").id.clone();
    mkdir(&linked.join("New").join("minecraft").join("mods"));
    assert_eq!(find(&run_empty(&e), "Never Launched").id, id_before);
}

#[test]
fn hyphenated_versions_in_launcher_metadata() {
    let t = tmp();
    let e = env(Os::Windows, &home(&t));
    // CurseForge: gameVersion with a hyphen, loader version with a hyphen.
    let cf = e.home.join("curseforge").join("minecraft").join("Instances").join("Pre");
    write(
        &cf.join("minecraftinstance.json"),
        r#"{"name":"Pre","gameVersion":"1.20.5-pre1","baseModLoader":{"name":"fabric-0.16.0-beta.1-1.20.5-pre1"}}"#,
    );
    // Vanilla: lastVersionId with both, confirmed by inheritsFrom.
    let root = e.data_dir().join(".minecraft");
    write(
        &root.join("launcher_profiles.json"),
        r#"{"profiles":{"x":{"name":"Beta Fabric","type":"custom","lastVersionId":"fabric-loader-0.16.0-beta.1-1.20.5-pre1"}}}"#,
    );
    write(
        &root.join("versions").join("fabric-loader-0.16.0-beta.1-1.20.5-pre1").join("fabric-loader-0.16.0-beta.1-1.20.5-pre1.json"),
        r#"{"id":"fabric-loader-0.16.0-beta.1-1.20.5-pre1","inheritsFrom":"1.20.5-pre1"}"#,
    );
    let d = run_empty(&e);
    for name in ["Pre", "Beta Fabric"] {
        let i = find(&d, name);
        assert_eq!(i.loader, loader(LoaderKind::Fabric, "0.16.0-beta.1"), "{name}");
        assert_eq!(i.mc_version.as_deref(), Some("1.20.5-pre1"), "{name}");
    }
}

#[test]
fn settings_convert_to_input() {
    let mut s = crate::model::Settings::default();
    s.manual_folders.push("/x/y".into());
    s.launcher_roots.push(crate::model::LauncherRoot { launcher: Launcher::Multimc, path: "/m".into() });
    let input = DiscoveryInput::from(&s);
    assert_eq!(input.manual_folders, vec![PathBuf::from("/x/y")]);
    assert_eq!(input.launcher_roots, vec![(Launcher::Multimc, PathBuf::from("/m"))]);
}
