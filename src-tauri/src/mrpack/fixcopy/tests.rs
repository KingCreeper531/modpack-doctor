//! Fixed copies of opened packs. Temp dirs only (every pack is built in one), no real network:
//! Modrinth is a wiremock server driven through the real `ModrinthClient`.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};
use zip::write::SimpleFileOptions;

use super::hook::Stage;
use super::*;
use crate::fix::ClientRemote;
use crate::guard::PathGuard;
use crate::modrinth::ModrinthService;
use crate::test_support::JarBuilder;

const PROJECT: &str = "PRoj0001";
const OTHER_PROJECT: &str = "OTHer001";
const CURRENT: &str = "CURver01";
const NEWER: &str = "NEWver01";
const DEP: &str = "DEPver01";
const DEP_PROJECT: &str = "DEPprj01";

fn sha1_of(b: &[u8]) -> String {
    crate::fix::fsops::sha1_bytes(b)
}

fn sodium_sha1() -> String {
    "5".repeat(40)
}

fn lithium_sha1() -> String {
    "6".repeat(40)
}

fn fabric_jar(id: &str) -> Vec<u8> {
    fabric_jar_json(&format!(r#"{{"schemaVersion":1,"id":"{id}","version":"1.0.0"}}"#), id)
}

/// A Fabric jar `id` that requires `dep`.
fn needy_jar(id: &str, dep: &str) -> Vec<u8> {
    fabric_jar_json(&format!(r#"{{"schemaVersion":1,"id":"{id}","version":"1.0.0","depends":{{"{dep}":"*"}}}}"#), id)
}

fn fabric_jar_json(json: &str, id: &str) -> Vec<u8> {
    JarBuilder::new().fabric_mod_json(json).class(&format!("com/{id}/Main.class"), 61).build()
}

/// The three standard declared files (one with an `env` and an unknown field).
fn standard_files() -> Value {
    json!([
        {
            "path": "mods/sodium-0.5.8.jar",
            "hashes": {"sha1": sodium_sha1(), "sha512": "a".repeat(128)},
            "env": {"client": "required", "server": "unsupported"},
            "downloads": ["https://cdn.modrinth.com/data/PRoj0001/versions/CURver01/sodium-0.5.8.jar"],
            "fileSize": 100,
            "x-entry": 1
        },
        {
            "path": "mods/lithium.jar",
            "hashes": {"sha1": lithium_sha1(), "sha512": "b".repeat(128)},
            "downloads": ["https://cdn.modrinth.com/data/x/versions/y/lithium.jar"],
            "fileSize": 200
        },
        {
            "path": "resourcepacks/pack.zip",
            "hashes": {"sha1": "7".repeat(40), "sha512": "c".repeat(128)},
            "downloads": ["https://cdn.modrinth.com/data/z/versions/w/pack.zip"],
            "fileSize": 300
        }
    ])
}

/// The standard index with `files`; unknown fields at the root and in `dependencies`.
fn index_with(deps: Value, files: Value) -> String {
    json!({
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": "1.0.0",
        "name": "My Pack",
        "summary": "kept",
        "x-custom": {"keep": [1, 2, 3]},
        "files": files,
        "dependencies": deps
    })
    .to_string()
}

fn index_json(deps: Value) -> String {
    index_with(deps, standard_files())
}

fn fabric_deps() -> Value {
    json!({"minecraft": "1.20.1", "fabric-loader": "0.15.11", "x-future": "9"})
}

/// The standard pack: the index, two override jars directly in `mods/`, a config file and a
/// stray jar outside `mods/`.
fn pack_bytes(index: &str) -> Vec<u8> {
    pack_with(index, &[])
}

/// The standard pack plus `extra` entries.
fn pack_with(index: &str, extra: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut b = JarBuilder::new()
        .file("modrinth.index.json", index)
        .file("overrides/mods/extra.jar", fabric_jar("extra"))
        .file("overrides/config/extra.toml", "a = 1")
        .file("overrides/stray.jar", fabric_jar("stray"))
        .file("client-overrides/mods/menu.jar", fabric_jar("menu"));
    for (name, bytes) in extra {
        b = b.file(name, bytes);
    }
    b.build()
}

struct H {
    rt: tokio::runtime::Runtime,
    server: MockServer,
    _tmp: TempDir,
    dir: PathBuf,
    st: AppState,
    store: PackFixStore,
    remote: ClientRemote,
    pack: PathBuf,
    id: String,
}

impl H {
    fn new() -> H {
        Self::with_pack(pack_bytes(&index_json(fabric_deps())))
    }

    fn with_pack(bytes: Vec<u8>) -> H {
        Self::build(bytes, json!([]), json!({"hits": []}))
    }

    /// `projects` answers every `/v2/projects` request, `search` every `/v2/search`.
    fn build(bytes: Vec<u8>, projects: Value, search: Value) -> H {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime");
        let server = rt.block_on(MockServer::start());
        let tmp = TempDir::new().expect("tmp");
        let dir = dunce::canonicalize(tmp.path()).expect("canon");
        std::fs::create_dir_all(dir.join("Downloads")).expect("mkdir");
        std::fs::create_dir_all(dir.join("out")).expect("mkdir");
        let raw = dir.join("Downloads").join("My Pack.mrpack");
        std::fs::write(&raw, bytes).expect("write pack");
        let svc = ModrinthService::for_tests(
            server.uri(),
            "cdn.modrinth.com".into(),
            dir.join("cache").join("modrinth"),
            dir.join("cache").join("icons"),
        );
        let st = AppState { modrinth: Some(svc.clone()), ..AppState::default() };
        let pack = crate::mrpack::check_pack_file(&raw).expect("a pack");
        let inst = crate::mrpack::describe_pack(&pack);
        let id = inst.id.clone();
        st.add_opened_pack(inst).expect("open");
        let remote = ClientRemote::new(svc.client(true).clone(), rt.handle().clone());
        let h = H { rt, server, _tmp: tmp, dir, st, store: PackFixStore::default(), remote, pack, id };
        h.mount(Mock::given(method("GET")).and(path("/v2/projects")).respond_with(ResponseTemplate::new(200).set_body_json(projects)));
        h.mount(Mock::given(method("GET")).and(path("/v2/search")).respond_with(ResponseTemplate::new(200).set_body_json(search)));
        h
    }

    fn mount(&self, m: Mock) {
        self.rt.block_on(m.mount(&self.server));
    }

    fn mount_version(&self, v: Value) {
        let id = v["id"].as_str().expect("id").to_string();
        self.mount(Mock::given(method("GET")).and(path(format!("/v2/version/{id}"))).respond_with(ResponseTemplate::new(200).set_body_json(v)));
    }

    /// The pack's `mods/sodium-0.5.8.jar` is version CURRENT of PROJECT, which requires
    /// DEP_PROJECT and OTHER_PROJECT; nothing else is on Modrinth.
    fn mount_identify(&self) {
        let mut current = version(CURRENT, PROJECT, "0.5.8", "sodium-0.5.8.jar");
        current["dependencies"] = json!([required(DEP_PROJECT), required(OTHER_PROJECT), {"project_id": "OPTproj1", "dependency_type": "optional"}]);
        self.mount_identified(json!({ sodium_sha1(): current }));
    }

    /// Every `version_files` lookup answers `found` (sha1 → version JSON).
    fn mount_identified(&self, found: Value) {
        self.mount(Mock::given(method("POST")).and(path("/v2/version_files")).respond_with(ResponseTemplate::new(200).set_body_json(found)));
    }

    fn plan(&self, edits: Vec<PackEdit>) -> Result<PackFixPlan> {
        plan(&self.st, &self.store, Some(&self.remote), &self.id, &edits)
    }

    fn plan_offline(&self, edits: Vec<PackEdit>) -> Result<PackFixPlan> {
        plan(&self.st, &self.store, None, &self.id, &edits)
    }

    fn dest(&self, name: &str) -> PathBuf {
        self.dir.join("out").join(name)
    }

    fn save(&self, plan_id: &str, dest: &Path, may_replace: bool) -> Result<SavedPack> {
        save(&self.st, &self.store, plan_id, dest, may_replace)
    }

    fn pack_sha1(&self) -> String {
        sha1_of(&std::fs::read(&self.pack).expect("read pack"))
    }

    /// Names in `out/` (temp files included).
    fn out_names(&self) -> Vec<String> {
        names_in(&self.dir.join("out"))
    }

    /// Open another pack (in `Downloads/`) as well; its path.
    fn open_second_pack(&self) -> PathBuf {
        let raw = self.dir.join("Downloads").join("Second.mrpack");
        std::fs::write(&raw, pack_bytes(&index_json(fabric_deps()))).expect("write");
        let canon = crate::mrpack::check_pack_file(&raw).expect("a pack");
        self.st.add_opened_pack(crate::mrpack::describe_pack(&canon)).expect("open");
        canon
    }
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).expect("ls").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

fn required(project: &str) -> Value {
    json!({"project_id": project, "version_id": null, "file_name": null, "dependency_type": "required"})
}

/// A Modrinth version JSON (Fabric, 1.20.1) with one primary CDN file. CURRENT is published
/// before every other version.
fn version(id: &str, project: &str, number: &str, file: &str) -> Value {
    json!({
        "id": id,
        "project_id": project,
        "version_number": number,
        "name": format!("Mod {number}"),
        "game_versions": ["1.20.1"],
        "loaders": ["fabric"],
        "version_type": "release",
        "date_published": if id == CURRENT { "2024-01-01T00:00:00Z" } else { "2024-03-01T00:00:00Z" },
        "files": [{
            "url": format!("https://cdn.modrinth.com/data/{project}/versions/{id}/{file}"),
            "filename": file,
            "primary": true,
            "size": 4096,
            "hashes": {"sha1": "1".repeat(40), "sha512": "2".repeat(128)},
            "file_type": null
        }],
        "dependencies": []
    })
}

/// A Modrinth project JSON.
fn project(id: &str, slug: &str, title: &str, client: Option<&str>, server: Option<&str>) -> Value {
    json!({"id": id, "slug": slug, "title": title, "project_type": "mod", "client_side": client, "server_side": server})
}

fn remove(path: &str) -> PackEdit {
    PackEdit::RemoveDeclared { path: path.into() }
}

fn remove_override(entry: &str) -> PackEdit {
    PackEdit::RemoveOverride { entry: entry.into() }
}

fn replace(path: &str, version_id: &str) -> PackEdit {
    PackEdit::ReplaceDeclared { path: path.into(), version_id: version_id.into() }
}

fn add(version_id: &str) -> PackEdit {
    PackEdit::AddDependency { version_id: version_id.into() }
}

/// Every entry: (name, compression, crc, raw compressed bytes), in archive order.
fn raw_entries(bytes: &[u8]) -> Vec<(String, zip::CompressionMethod, u32, Vec<u8>)> {
    let mut z = ZipArchive::new(Cursor::new(bytes)).expect("zip");
    (0..z.len())
        .map(|i| {
            let mut f = z.by_index_raw(i).expect("entry");
            let mut b = Vec::new();
            f.read_to_end(&mut b).expect("read");
            (String::from_utf8_lossy(f.name_raw()).into_owned(), f.compression(), f.crc32(), b)
        })
        .collect()
}

fn names_of(bytes: &[u8]) -> Vec<String> {
    raw_entries(bytes).into_iter().map(|e| e.0).collect()
}

fn index_of(bytes: &[u8]) -> Value {
    let mut z = ZipArchive::new(Cursor::new(bytes)).expect("zip");
    let mut s = String::new();
    z.by_name(INDEX_NAME).expect("index").read_to_string(&mut s).expect("read");
    serde_json::from_str(&s).expect("json")
}

fn paths_of(index: &Value) -> Vec<String> {
    index["files"].as_array().expect("files").iter().map(|f| f["path"].as_str().expect("path").to_string()).collect()
}

fn scan_copy(copy: &Path) -> crate::model::ScanResult {
    let g = PathGuard::new();
    g.set_read_only_files(&[copy.to_path_buf()]);
    crate::mrpack::scan_pack(&g, copy, "copy", |_| {}, |_| {}).expect("scan the copy")
}

fn msg(e: &Error) -> String {
    e.to_string()
}

fn warning<'a>(plan: &'a PackFixPlan, needle: &str) -> &'a str {
    plan.warnings.iter().find(|w| w.contains(needle)).unwrap_or_else(|| panic!("no warning with {needle:?}: {:?}", plan.warnings))
}

fn set_mtime(path: &Path, t: SystemTime) {
    OpenOptions::new().write(true).open(path).expect("open").set_modified(t).expect("set mtime");
}

// ── Writing ──────────────────────────────────────────────────────────────────

#[test]
fn removals_write_a_valid_copy_and_never_touch_the_pack() {
    let h = H::new();
    let original = std::fs::read(&h.pack).expect("read");
    let before = h.pack_sha1();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar"), remove_override("overrides/mods/extra.jar")]).expect("plan");
    assert_eq!(plan.pack_file_name, "My Pack.mrpack");
    assert_eq!(plan.instance_id, h.id);
    assert_eq!(plan.ops.iter().map(|o| (o.kind, o.subject.as_str())).collect::<Vec<_>>(), vec![
        (PackFixOpKind::Remove, "mods/lithium.jar"),
        (PackFixOpKind::RemoveOverride, "overrides/mods/extra.jar"),
    ]);
    // Offline, the kept declared files were not identified: said once.
    assert_eq!(plan.warnings.len(), 1, "{:?}", plan.warnings);
    assert!(warning(&plan, "switched off").contains("the 2 files the copy keeps from the pack's index were not identified"), "{:?}", plan.warnings);
    assert_eq!(h.pack_sha1(), before, "planning reads only");

    let dest = h.dest("My Pack (fixed).mrpack");
    let saved = h.save(&plan.id, &dest, false).expect("save");
    assert_eq!(saved.file_name, "My Pack (fixed).mrpack");
    assert_eq!(PathBuf::from(&saved.path), dest);
    assert_eq!(h.pack_sha1(), before, "the opened pack is unchanged");
    assert_eq!(h.out_names(), vec!["My Pack (fixed).mrpack".to_string()], "no temp file left");

    // Every kept entry: same order, same compressed bytes; the index rewritten; the jar gone.
    let copy = std::fs::read(&dest).expect("read copy");
    let want: Vec<_> = raw_entries(&original).into_iter().filter(|e| e.0 != "overrides/mods/extra.jar").collect();
    let got = raw_entries(&copy);
    assert_eq!(got.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(), want.iter().map(|e| e.0.as_str()).collect::<Vec<_>>());
    for (g, w) in got.iter().zip(&want) {
        if g.0 == INDEX_NAME {
            continue;
        }
        assert_eq!(g, w, "{} copied byte for byte", g.0);
    }
    let index = index_of(&copy);
    assert_eq!(paths_of(&index), vec!["mods/sodium-0.5.8.jar", "resourcepacks/pack.zip"]);
    assert_eq!(index["x-custom"], json!({"keep": [1, 2, 3]}), "unknown root fields survive");
    assert_eq!(index["summary"], "kept");
    assert_eq!(index["dependencies"]["x-future"], "9");
    assert_eq!(index["files"][0]["x-entry"], 1, "untouched entries are kept verbatim");

    // The copy is a valid pack for the scanner.
    let canon = dunce::canonicalize(&dest).expect("canon");
    let res = scan_copy(&canon);
    assert_eq!(res.declared.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), vec!["mods/sodium-0.5.8.jar", "resourcepacks/pack.zip"]);
    let jars: Vec<&str> = res.jars.iter().filter(|j| j.depth == 0).map(|j| j.id.as_str()).collect();
    assert_eq!(jars, vec!["client-overrides/mods/menu.jar"]);
    assert_eq!(crate::mrpack::describe_pack(&canon).name, "My Pack");

    // Single use.
    let again = h.save(&plan.id, &h.dest("again.mrpack"), false).expect_err("used");
    assert!(matches!(again, Error::NotFound { .. }), "{again}");
    assert!(!h.dest("again.mrpack").exists());
}

#[test]
fn a_replacement_keeps_env_and_points_at_the_cdn() {
    let h = H::new();
    h.mount_identify();
    h.mount_version(version(NEWER, PROJECT, "0.5.11", "sodium-0.5.11.jar"));
    let plan = h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]).expect("plan");
    let op = &plan.ops[0];
    assert_eq!(op.kind, PackFixOpKind::Replace);
    assert_eq!(op.subject, "mods/sodium-0.5.8.jar");
    assert!(op.detail.contains("Becomes mods/sodium-0.5.11.jar: Mod 0.5.11 0.5.11 (4 KB) from cdn.modrinth.com"), "{}", op.detail);
    assert!(op.detail.contains("keeps the entry's env (client required, server unsupported)"), "{}", op.detail);
    assert_eq!(op.url.as_deref(), Some("https://cdn.modrinth.com/data/PRoj0001/versions/NEWver01/sodium-0.5.11.jar"));
    // Online, the files Modrinth does not know are named.
    let w = warning(&plan, "not identified on Modrinth");
    assert!(w.starts_with("2 files the copy keeps") && w.contains("mods/lithium.jar, resourcepacks/pack.zip"), "{w}");

    let dest = h.dest("copy.mrpack");
    h.save(&plan.id, &dest, false).expect("save");
    let index = index_of(&std::fs::read(&dest).expect("read"));
    assert_eq!(paths_of(&index), vec!["mods/sodium-0.5.11.jar", "mods/lithium.jar", "resourcepacks/pack.zip"], "same position");
    let e = &index["files"][0];
    assert_eq!(e["env"], json!({"client": "required", "server": "unsupported"}));
    assert_eq!(e["hashes"], json!({"sha1": "1".repeat(40), "sha512": "2".repeat(128)}));
    assert_eq!(e["downloads"], json!(["https://cdn.modrinth.com/data/PRoj0001/versions/NEWver01/sodium-0.5.11.jar"]));
    assert_eq!(e["fileSize"], 4096);
    assert!(e.get("x-entry").is_none(), "facts about the old file are not carried over");
    let res = scan_copy(&dunce::canonicalize(&dest).expect("canon"));
    assert!(res.declared.iter().any(|d| d.path == "mods/sodium-0.5.11.jar" && d.client.as_deref() == Some("required")));
}

#[test]
fn an_added_dependency_takes_the_env_of_the_file_that_requires_it() {
    let h = H::new();
    h.mount_identify();
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let plan = h.plan(vec![add(DEP)]).expect("plan");
    assert_eq!(plan.ops[0].kind, PackFixOpKind::Add);
    assert_eq!(plan.ops[0].subject, "mods/cloth-config-11.jar");
    let detail = &plan.ops[0].detail;
    assert!(detail.contains("required by mods/sodium-0.5.8.jar"), "{detail}");
    assert!(detail.contains("Modrinth does not say which sides"), "{detail}");
    assert!(detail.contains("client required, server unsupported"), "{detail}");
    let dest = h.dest("copy.mrpack");
    h.save(&plan.id, &dest, false).expect("save");
    let index = index_of(&std::fs::read(&dest).expect("read"));
    let last = index["files"].as_array().expect("files").last().expect("entry").clone();
    assert_eq!(last["path"], "mods/cloth-config-11.jar");
    assert_eq!(last["env"], json!({"client": "required", "server": "unsupported"}));
    let res = scan_copy(&dunce::canonicalize(&dest).expect("canon"));
    assert!(res.declared.iter().any(|d| d.path == "mods/cloth-config-11.jar" && d.client.as_deref() == Some("required") && d.size == 4096));
}

#[test]
fn an_added_dependency_takes_the_env_of_its_modrinth_sides() {
    let h = H::build(
        pack_bytes(&index_json(fabric_deps())),
        json!([project(DEP_PROJECT, "cloth-config", "Cloth Config", Some("optional"), Some("required"))]),
        json!({"hits": []}),
    );
    h.mount_identify();
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let plan = h.plan(vec![add(DEP)]).expect("plan");
    assert!(plan.ops[0].detail.starts_with("New index entry: Cloth Config 11.0.0 (4 KB)"), "{}", plan.ops[0].detail);
    assert!(plan.ops[0].detail.contains("its env follows Modrinth's sides for Cloth Config (client optional, server required)"), "{}", plan.ops[0].detail);
    let dest = h.dest("copy.mrpack");
    h.save(&plan.id, &dest, false).expect("save");
    let index = index_of(&std::fs::read(&dest).expect("read"));
    assert_eq!(index["files"][3]["env"], json!({"client": "optional", "server": "required"}));
}

#[test]
fn an_added_dependency_of_a_file_without_env_gets_none() {
    let h = H::new();
    let mut lith = version("LITHcur1", "LITHprj1", "0.11", "lithium.jar");
    lith["dependencies"] = json!([required(DEP_PROJECT)]);
    h.mount_identified(json!({ lithium_sha1(): lith }));
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let plan = h.plan(vec![add(DEP)]).expect("plan");
    assert!(plan.ops[0].detail.contains("required by mods/lithium.jar"), "{}", plan.ops[0].detail);
    assert!(plan.ops[0].detail.contains("it has no env, so launchers install it on both client and server"), "{}", plan.ops[0].detail);
    let dest = h.dest("copy.mrpack");
    h.save(&plan.id, &dest, false).expect("save");
    let index = index_of(&std::fs::read(&dest).expect("read"));
    assert!(index["files"][3].get("env").is_none());
}

/// A zip of `entries` (stored), plus symlink entries.
fn raw_zip(entries: &[(&str, &[u8])], symlinks: &[(&str, &str)]) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for (name, bytes) in entries {
        zip.start_file(*name, opts).expect("start");
        zip.write_all(bytes).expect("write");
    }
    for (name, target) in symlinks {
        zip.add_symlink(*name, *target, opts).expect("symlink");
    }
    zip.finish().expect("finish").into_inner()
}

/// Replace the first occurrence of `from` (the local header's name) by `to` (same length).
fn patch_first(mut bytes: Vec<u8>, from: &str, to: &str) -> Vec<u8> {
    assert_eq!(from.len(), to.len());
    let at = bytes.windows(from.len()).position(|w| w == from.as_bytes()).expect("found");
    bytes[at..at + to.len()].copy_from_slice(to.as_bytes());
    bytes
}

#[test]
fn unsafe_entries_are_left_out_with_a_warning() {
    let index = index_json(fabric_deps());
    let bytes = raw_zip(
        &[
            (INDEX_NAME, index.as_bytes()),
            ("../evil.txt", b"evil"),
            ("overrides/config/n\0ul.toml", b"nul"),
            ("./overrides/config/dot.toml", b"dot"),
            ("overrides//config/double.toml", b"double"),
            ("overrides/config/aaa.toml", b"mismatch"),
            ("overrides/config/ok.toml", b"a = 1"),
        ],
        &[("overrides/config/link.toml", "../../../etc/passwd")],
    );
    // Only the local header of `aaa.toml` says `zzz.toml`.
    let bytes = patch_first(bytes, "overrides/config/aaa.toml", "overrides/config/zzz.toml");
    let h = H::with_pack(bytes);
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    let w = warning(&plan, "unsafe entries the scan skipped are left out of the copy");
    assert!(w.starts_with("6 unsafe entries"), "{w}");
    for needle in ["../evil.txt", "NUL", "./overrides/config/dot.toml", "overrides//config/double.toml", "local header", "and 1 more"] {
        assert!(w.contains(needle), "{needle}: {w}");
    }
    let dest = h.dest("copy.mrpack");
    h.save(&plan.id, &dest, false).expect("save");
    assert_eq!(names_of(&std::fs::read(&dest).expect("read")), vec![INDEX_NAME.to_string(), "overrides/config/ok.toml".to_string()]);
}

#[test]
fn index_entries_the_scanner_rejects_are_left_out_and_odd_links_are_named() {
    let hash = |c: char| json!({"sha1": c.to_string().repeat(40), "sha512": c.to_string().repeat(128)});
    let files = json!([
        {"path": "../../config/evil.jar", "hashes": hash('1'), "downloads": ["https://evil.example/x"]},
        {"path": "mods/", "hashes": hash('2'), "downloads": []},
        {"path": "mods/badhash.jar", "hashes": {"sha1": "xyz", "sha512": "b".repeat(128)}, "downloads": []},
        "not an object",
        {"path": "mods/dup.jar", "hashes": hash('3'), "downloads": ["https://evil.example/old.jar"]},
        {"path": "mods/dup.jar", "hashes": hash('4'), "downloads": ["https://cdn.modrinth.com/data/a/versions/b/dup.jar"]},
        {"path": "mods/./dot.jar", "hashes": hash('5'), "downloads": []},
        {"path": "mods/lithium.jar", "hashes": hash('6'), "downloads": ["https://cdn.modrinth.com/data/x/versions/y/lithium.jar"]},
        {"path": "mods/github.jar", "hashes": hash('7'), "downloads": ["https://github.com/a/b/releases/download/1/github.jar"]},
        {"path": "mods/elsewhere.jar", "hashes": hash('8'), "downloads": ["https://evil.example/e.jar", "https://cdn.modrinth.com/data/c/versions/d/e.jar"]},
        {"path": "mods/notalist.jar", "hashes": hash('9'), "downloads": "https://cdn.modrinth.com/x.jar"}
    ]);
    let h = H::with_pack(pack_bytes(&index_with(fabric_deps(), files)));
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    let w = warning(&plan, "that Modpack Doctor's scan skips");
    assert!(w.starts_with("6 entries of the pack's modrinth.index.json"), "{w}");
    for needle in [
        "files[0] (\"../../config/evil.jar\" is unsafe",
        "files[1] (\"mods/\" is a folder, not a file)",
        "files[2] (\"mods/badhash.jar\" has no valid sha1 hash)",
        "files[3] (it is not a JSON object)",
        "files[4] (\"mods/dup.jar\" is listed again as files[5]",
        "and 1 more",
    ] {
        assert!(w.contains(needle), "{needle}: {w}");
    }
    let w = warning(&plan, "outside Modrinth's allowlist");
    assert!(w.starts_with("2 files the copy keeps have download links outside Modrinth's allowlist (cdn.modrinth.com, github.com"), "{w}");
    assert!(w.contains("mods/elsewhere.jar (evil.example)") && w.contains("mods/notalist.jar (links that are not a list)"), "{w}");
    assert!(!w.contains("github.jar"), "{w}");

    let dest = h.dest("copy.mrpack");
    h.save(&plan.id, &dest, false).expect("save");
    let index = index_of(&std::fs::read(&dest).expect("read"));
    assert_eq!(paths_of(&index), vec!["mods/dup.jar", "mods/github.jar", "mods/elsewhere.jar", "mods/notalist.jar"]);
    assert_eq!(index["files"][0]["hashes"]["sha1"], "4".repeat(40), "the entry installers keep");
    assert_eq!(index["files"][2]["downloads"][0], "https://evil.example/e.jar", "kept, not dropped");
    let res = scan_copy(&dunce::canonicalize(&dest).expect("canon"));
    assert!(res.unverified_downloads.is_empty(), "{:?}", res.unverified_downloads);
}

#[test]
fn duplicate_and_case_different_paths() {
    let hash = |c: char| json!({"sha1": c.to_string().repeat(40), "sha512": c.to_string().repeat(128)});
    let files = json!([
        {"path": "mods/dup.jar", "hashes": hash('3'), "downloads": []},
        {"path": "mods/Case.jar", "hashes": hash('4'), "downloads": []},
        {"path": "mods/dup.jar", "hashes": hash('5'), "downloads": []},
        {"path": "mods/case.jar", "hashes": hash('6'), "downloads": []},
        {"path": "mods/sodium-0.5.8.jar", "hashes": {"sha1": sodium_sha1(), "sha512": "a".repeat(128)}, "downloads": []}
    ]);
    let h = H::with_pack(pack_bytes(&index_with(fabric_deps(), files)));
    // Removing a listed-twice path leaves both entries out; the case twin stays (named).
    let plan = h.plan_offline(vec![remove("mods/dup.jar")]).expect("plan");
    assert!(warning(&plan, "scan skips").contains("files[0] (\"mods/dup.jar\" is listed again as files[2]"), "{:?}", plan.warnings);
    assert!(warning(&plan, "differ only in letter case").contains("mods/Case.jar and mods/case.jar"), "{:?}", plan.warnings);
    let dest = h.dest("a.mrpack");
    h.save(&plan.id, &dest, false).expect("save");
    assert_eq!(paths_of(&index_of(&std::fs::read(&dest).expect("read"))), vec!["mods/Case.jar", "mods/case.jar", "mods/sodium-0.5.8.jar"]);

    // Removing one case twin removes exactly that path; no letter-case note is left.
    let plan = h.plan_offline(vec![remove("mods/case.jar")]).expect("plan");
    assert!(!plan.warnings.iter().any(|w| w.contains("letter case")), "{:?}", plan.warnings);
    let dest = h.dest("b.mrpack");
    h.save(&plan.id, &dest, false).expect("save");
    assert_eq!(paths_of(&index_of(&std::fs::read(&dest).expect("read"))), vec!["mods/Case.jar", "mods/dup.jar", "mods/sodium-0.5.8.jar"]);
    assert!(h.plan_offline(vec![remove("mods/CASE.jar")]).is_err(), "paths are matched exactly");

    // A replacement whose file name lands on a case twin is refused.
    h.mount_identify();
    h.mount_version(version("CASEver1", PROJECT, "0.6", "CASE.jar"));
    let e = h.plan(vec![replace("mods/sodium-0.5.8.jar", "CASEver1")]).expect_err("collision");
    assert!(msg(&e).contains("more than once"), "{e}");
}

// ── Validation ───────────────────────────────────────────────────────────────

#[test]
fn edits_are_checked_against_the_pack() {
    let h = H::new();
    let cases: Vec<(Vec<PackEdit>, &str)> = vec![
        (vec![], "no edits"),
        (vec![remove("mods/nope.jar")], "lists no file at that path"),
        (vec![remove("MODS/lithium.jar")], "lists no file at that path"),
        (vec![remove_override("overrides/config/extra.toml")], "not a jar directly in the mods folder"),
        (vec![remove_override("overrides/stray.jar")], "not a jar directly in the mods folder"),
        (vec![remove_override("overrides/mods/missing.jar")], "not a jar directly in the mods folder"),
        (vec![remove_override("mods/lithium.jar")], "not a jar directly in the mods folder"),
        (vec![remove("mods/lithium.jar"), remove("mods/lithium.jar")], "already changes"),
        (vec![remove("mods/sodium-0.5.8.jar"), replace("mods/sodium-0.5.8.jar", NEWER)], "already changes"),
        (vec![replace("mods/sodium-0.5.8.jar", "../../x")], "not a Modrinth version id"),
    ];
    for (edits, want) in cases {
        let e = h.plan_offline(edits.clone()).expect_err("refused");
        assert!(matches!(e, Error::Invalid(_)), "{edits:?}: {e}");
        assert!(msg(&e).contains(want), "{edits:?}: {e}");
    }
    // Replacements and additions need Modrinth.
    assert!(matches!(h.plan_offline(vec![add(DEP)]), Err(Error::Offline)));
    // Only opened packs.
    let e = plan(&h.st, &h.store, None, "0123456789abcdef", &[remove("mods/lithium.jar")]).expect_err("unknown");
    assert!(matches!(e, Error::NotFound { .. }), "{e}");
    let e = plan(&h.st, &h.store, None, "../x", &[remove("mods/lithium.jar")]).expect_err("malformed");
    assert!(matches!(e, Error::Invalid(_)), "{e}");
    assert!(std::fs::read_dir(h.dir.join("out")).expect("ls").next().is_none(), "nothing written");
}

#[test]
fn modrinth_versions_are_checked() {
    let h = H::new();
    h.mount_identify();
    let mut other = version("OTHver01", OTHER_PROJECT, "1.0", "other.jar");
    other["name"] = json!("Other");
    h.mount_version(other);
    h.mount_version(version(CURRENT, PROJECT, "0.5.8", "sodium-0.5.8.jar"));
    h.mount_version(version(NEWER, PROJECT, "0.5.11", "sodium-0.5.11.jar"));
    let mut http = version("HTTPver1", PROJECT, "0.5.12", "sodium-0.5.12.jar");
    http["files"][0]["url"] = json!("http://cdn.modrinth.com/data/PRoj0001/versions/HTTPver1/sodium-0.5.12.jar");
    h.mount_version(http);
    let mut off = version("OFFver01", PROJECT, "0.5.13", "sodium-0.5.13.jar");
    off["files"][0]["url"] = json!("https://evil.example/sodium-0.5.13.jar");
    h.mount_version(off);
    let mut nohash = version("NOHash01", PROJECT, "0.5.14", "sodium-0.5.14.jar");
    nohash["files"][0]["hashes"] = json!({"sha1": "1".repeat(40)});
    h.mount_version(nohash);
    let mut nosize = version("NOSize01", PROJECT, "0.5.15", "sodium-0.5.15.jar");
    nosize["files"][0]["size"] = Value::Null;
    h.mount_version(nosize);
    let mut forge = version("FORge001", PROJECT, "0.5.16", "sodium-0.5.16.jar");
    forge["loaders"] = json!(["forge"]);
    h.mount_version(forge);
    let mut mc = version("MCver001", PROJECT, "0.5.17", "sodium-0.5.17.jar");
    mc["game_versions"] = json!(["1.21.1"]);
    h.mount_version(mc);
    let mut two = version("TWOfil01", PROJECT, "0.5.18", "sodium-0.5.18.jar");
    two["files"][0]["primary"] = json!(false);
    let mut second = two["files"][0].clone();
    second["filename"] = json!("sodium-0.5.18-extra.jar");
    two["files"].as_array_mut().expect("files").push(second);
    h.mount_version(two);
    let mut old = version("OLDver01", PROJECT, "0.5.7", "sodium-0.5.7.jar");
    old["date_published"] = json!("2023-06-01T00:00:00Z");
    h.mount_version(old);
    let mut undated = version("NODate01", PROJECT, "0.5.19", "sodium-0.5.19.jar");
    undated["date_published"] = Value::Null;
    h.mount_version(undated);

    let sodium = "mods/sodium-0.5.8.jar";
    let cases = [
        (replace(sodium, "OTHver01"), "belongs to a different Modrinth project"),
        (replace(sodium, CURRENT), "already has version 0.5.8"),
        (replace(sodium, "OLDver01"), "version 0.5.7 was not published after the pack's version 0.5.8"),
        (replace(sodium, "NODate01"), "was not published after"),
        (replace(sodium, "HTTPver1"), "not a https://cdn.modrinth.com/ link"),
        (replace(sodium, "OFFver01"), "primary file for this version is not a verifiable CDN download"),
        (replace(sodium, "NOHash01"), "primary file for this version is not a verifiable CDN download"),
        (replace(sodium, "NOSize01"), "did not report the size"),
        (replace(sodium, "FORge001"), "is for forge, not for this pack's loader (Fabric)"),
        (replace(sodium, "MCver001"), "does not list Minecraft 1.20.1"),
        (replace(sodium, "TWOfil01"), "several files and none is marked primary"),
        (add("FORge001"), "is for forge, not for this pack's loader (Fabric)"),
        (add("MCver001"), "does not list Minecraft 1.20.1"),
        (replace("mods/lithium.jar", NEWER), "Modrinth does not know this file by its hash"),
    ];
    for (edit, want) in cases {
        let e = h.plan(vec![edit.clone()]).expect_err("refused");
        assert!(msg(&e).contains(want), "{edit:?}: {e}");
    }
}

#[test]
fn quilt_packs_accept_fabric_versions_and_unknown_loaders_refuse() {
    let h = H::with_pack(pack_bytes(&index_json(json!({"minecraft": "1.20.1", "quilt-loader": "0.26.0"}))));
    h.mount_identify();
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    h.plan(vec![add(DEP)]).expect("Quilt loads Fabric mods");

    let h = H::with_pack(pack_bytes(&index_json(json!({"minecraft": "1.20.1"}))));
    h.mount_identify();
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let e = h.plan(vec![add(DEP)]).expect_err("no loader");
    assert!(msg(&e).contains("does not name both its Minecraft version and its mod loader"), "{e}");
}

#[test]
fn path_collisions_are_refused() {
    let h = H::new();
    h.mount_identify();
    h.mount_version(version("LITHver0", DEP_PROJECT, "1", "Lithium.jar"));
    h.mount_version(version("EXTRAv01", DEP_PROJECT, "1", "extra.jar"));
    h.mount_version(version("SAMEv001", DEP_PROJECT, "1", "same.jar"));
    let mut same2 = version("SAMEv002", OTHER_PROJECT, "2", "same.jar");
    same2["files"][0]["hashes"]["sha1"] = json!("3".repeat(40));
    h.mount_version(same2);

    let e = h.plan(vec![add("LITHver0")]).expect_err("collides with mods/lithium.jar (case ignored)");
    assert!(msg(&e).contains("more than once"), "{e}");
    let e = h.plan(vec![add("EXTRAv01")]).expect_err("an override would replace it");
    assert!(msg(&e).contains("overrides/ folder also has mods/extra.jar"), "{e}");
    h.plan(vec![remove_override("overrides/mods/extra.jar"), add("EXTRAv01")]).expect("fine without the override");
    let e = h.plan(vec![add("SAMEv001"), add("SAMEv002")]).expect_err("two additions, one path");
    assert!(msg(&e).contains("more than once"), "{e}");
    // A file the pack already lists by hash.
    let mut dup = version("DUPhash1", DEP_PROJECT, "1", "renamed.jar");
    dup["files"][0]["hashes"]["sha1"] = json!(lithium_sha1());
    h.mount_version(dup);
    let e = h.plan(vec![add("DUPhash1")]).expect_err("already listed");
    assert!(msg(&e).contains("already lists this exact file as mods/lithium.jar"), "{e}");
}

#[test]
fn an_addition_must_be_required_by_a_file_the_copy_keeps() {
    // Nothing in the pack requires it.
    let h = H::new();
    h.mount_identified(json!({ sodium_sha1(): version(CURRENT, PROJECT, "0.5.8", "sodium-0.5.8.jar") }));
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let e = h.plan(vec![add(DEP)]).expect_err("not required");
    assert!(matches!(e, Error::Invalid(_)), "{e}");
    assert!(msg(&e).contains("Add Mod 11.0.0 11.0.0: no file the copy keeps requires Mod 11.0.0"), "{e}");

    // The only file that requires it is removed by the same plan (in either order).
    let h = H::new();
    h.mount_identify();
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    for edits in [vec![remove("mods/sodium-0.5.8.jar"), add(DEP)], vec![add(DEP), remove("mods/sodium-0.5.8.jar")]] {
        let e = h.plan(edits).expect_err("requirer removed");
        assert!(msg(&e).contains("no file the copy keeps requires"), "{e}");
    }
    // A dependency that names only a version counts once that version's project is known.
    let h = H::new();
    let mut current = version(CURRENT, PROJECT, "0.5.8", "sodium-0.5.8.jar");
    current["dependencies"] = json!([{"project_id": null, "version_id": "DEPold01", "dependency_type": "required"}]);
    h.mount_identified(json!({ sodium_sha1(): current }));
    h.mount_version(version("DEPold01", DEP_PROJECT, "10.0.0", "cloth-config-10.jar"));
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let plan = h.plan(vec![add(DEP)]).expect("required through a version");
    assert!(plan.ops[0].detail.contains("required by mods/sodium-0.5.8.jar"), "{}", plan.ops[0].detail);
}

#[test]
fn an_override_jar_can_require_an_addition() {
    // By slug: the side folder gives the env when Modrinth does not know the sides.
    let pack = pack_with(&index_json(fabric_deps()), &[("client-overrides/mods/needy.jar", needy_jar("needy", "cloth_config"))]);
    let h = H::build(pack, json!([project(DEP_PROJECT, "cloth-config", "Cloth Config", None, None)]), json!({"hits": []}));
    h.mount_identified(json!({}));
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let plan = h.plan(vec![add(DEP)]).expect("plan");
    let d = &plan.ops[0].detail;
    assert!(d.contains("required by client-overrides/mods/needy.jar") && d.contains("client required, server unsupported"), "{d}");
    // Removing that jar removes the reason.
    let e = h.plan(vec![remove_override("client-overrides/mods/needy.jar"), add(DEP)]).expect_err("no requirer");
    assert!(msg(&e).contains("no file the copy keeps requires Cloth Config"), "{e}");

    // By `resolve_mod_id` (the search finds the project for the mod id).
    let pack = pack_with(&index_json(fabric_deps()), &[("overrides/mods/needy.jar", needy_jar("needy", "clothy"))]);
    let hit = json!({"project_id": DEP_PROJECT, "slug": "clothy", "title": "Clothy", "project_type": "mod"});
    let h = H::build(pack, json!([]), json!({"hits": [hit]}));
    h.mount_identified(json!({}));
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let plan = h.plan(vec![add(DEP)]).expect("plan");
    assert!(plan.ops[0].detail.contains("required by overrides/mods/needy.jar"), "{}", plan.ops[0].detail);
    assert!(plan.ops[0].detail.contains("it has no env"), "{}", plan.ops[0].detail);
}

#[test]
fn an_addition_the_copy_already_has_is_refused() {
    // A declared file of the same project.
    let h = H::new();
    let mut current = version(CURRENT, PROJECT, "0.5.8", "sodium-0.5.8.jar");
    current["dependencies"] = json!([required(DEP_PROJECT)]);
    h.mount_identified(json!({ sodium_sha1(): current, lithium_sha1(): version("LITHcur1", DEP_PROJECT, "10.0.0", "lithium.jar") }));
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let e = h.plan(vec![add(DEP)]).expect_err("already declared");
    assert!(msg(&e).contains("the pack already has Mod 11.0.0 as mods/lithium.jar"), "{e}");
    h.plan(vec![remove("mods/lithium.jar"), add(DEP)]).expect("fine once that file is removed");
    // Two versions of one project.
    let mut dep2 = version("DEPver02", DEP_PROJECT, "11.0.1", "cloth-config-11.0.1.jar");
    dep2["files"][0]["hashes"]["sha1"] = json!("3".repeat(40));
    h.mount_version(dep2);
    let e = h.plan(vec![remove("mods/lithium.jar"), add(DEP), add("DEPver02")]).expect_err("twice");
    assert!(msg(&e).contains("another edit already adds"), "{e}");

    // An override jar whose mod id is the project's slug.
    let pack = pack_with(&index_json(fabric_deps()), &[("overrides/mods/cc.jar", fabric_jar("cloth_config"))]);
    let h = H::build(pack, json!([project(DEP_PROJECT, "cloth-config", "Cloth Config", Some("required"), Some("required"))]), json!({"hits": []}));
    h.mount_identify();
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let e = h.plan(vec![add(DEP)]).expect_err("override provides it");
    assert!(msg(&e).contains("the pack's override jar overrides/mods/cc.jar already provides Cloth Config (mod id cloth_config)"), "{e}");

    // An override jar whose mod id resolves to the project.
    let hit = json!({"project_id": DEP_PROJECT, "slug": "extra", "title": "Extra", "project_type": "mod"});
    let h = H::build(pack_bytes(&index_json(fabric_deps())), json!([]), json!({"hits": [hit]}));
    h.mount_identify();
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let e = h.plan(vec![add(DEP)]).expect_err("override resolves to it");
    assert!(msg(&e).contains("override jar overrides/mods/extra.jar already provides"), "{e}");
}

#[test]
fn an_addition_warns_when_a_duplicate_cannot_be_ruled_out() {
    let files = json!([
        {"path": "mods/sodium-0.5.8.jar", "hashes": {"sha1": sodium_sha1(), "sha512": "a".repeat(128)}, "downloads": []},
        {"path": "mods/unknown.jar", "hashes": {"sha1": "9".repeat(40), "sha512": "9".repeat(128)}, "downloads": []}
    ]);
    let h = H::with_pack(pack_bytes(&index_with(fabric_deps(), files)));
    h.mount_identify();
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let plan = h.plan(vec![add(DEP)]).expect("plan");
    let w = warning(&plan, "cannot rule out");
    assert!(w.contains("1 declared jar that Modrinth does not identify (mods/unknown.jar)"), "{w}");
}

#[test]
fn the_copy_index_never_lists_more_than_the_scanner_reads() {
    let mut files = vec![json!({"path": "mods/sodium-0.5.8.jar", "hashes": {"sha1": sodium_sha1(), "sha512": "a".repeat(128)}, "downloads": []})];
    for i in 1..MAX_INDEX_FILES {
        files.push(json!({"path": format!("config/f{i}.txt"), "hashes": {"sha1": lithium_sha1(), "sha512": "b".repeat(128)}}));
    }
    let h = H::with_pack(pack_bytes(&index_with(fabric_deps(), Value::Array(files))));
    h.mount_identify();
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let e = h.plan(vec![add(DEP)]).expect_err("over the cap");
    assert!(msg(&e).contains(&format!("would list {} files, more than the {MAX_INDEX_FILES}", MAX_INDEX_FILES + 1)), "{e}");
    // Exactly at the cap is fine.
    h.plan(vec![remove("config/f1.txt"), add(DEP)]).expect("at the cap");
}

// ── Plans ────────────────────────────────────────────────────────────────────

#[test]
fn plans_expire_are_single_use_and_one_per_pack() {
    let h = H::new();
    h.store.set_ttl(Duration::ZERO);
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    let e = h.save(&plan.id, &h.dest("x.mrpack"), false).expect_err("expired");
    assert!(matches!(e, Error::NotFound { .. }), "{e}");
    assert!(msg(&e).contains("expired or was already used"), "{e}");
    assert!(h.store.peek(&plan.id).is_err());

    h.store.set_ttl(PLAN_TTL);
    let a = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan a");
    let b = h.plan_offline(vec![remove("resourcepacks/pack.zip")]).expect("plan b");
    assert!(!h.store.contains(&a.id), "a newer plan of the same pack replaces it");
    assert!(h.store.contains(&b.id));
    assert_eq!(h.store.peek(&b.id).expect("peek").ops[0].subject, "resourcepacks/pack.zip");
    for bad in ["", "../../x", &"G".repeat(32)] {
        assert!(h.store.peek(bad).is_err());
        assert!(h.save(bad, &h.dest("x.mrpack"), false).is_err());
    }
    assert!(h.out_names().is_empty());
}

#[test]
fn a_failed_save_never_puts_back_a_plan_a_newer_one_replaced() {
    let h = H::new();
    let a = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan a");
    let (st, store, id) = (h.st.clone(), h.store.clone(), h.id.clone());
    let newer = std::rc::Rc::new(std::cell::RefCell::new(None));
    let seen = newer.clone();
    hook::set(move |stage, _, _| {
        if stage == Stage::BeforeMove {
            let b = plan(&st, &store, None, &id, &[remove("resourcepacks/pack.zip")]).expect("plan b");
            *seen.borrow_mut() = Some(b.id);
            return Err(std::io::Error::other("injected (test)"));
        }
        Ok(())
    });
    let e = h.save(&a.id, &h.dest("copy.mrpack"), false).expect_err("injected");
    hook::clear();
    assert!(msg(&e).contains("injected"), "{e}");
    let b = newer.borrow().clone().expect("plan b made");
    assert!(!h.store.contains(&a.id), "the older plan stays gone");
    assert!(h.store.contains(&b));
    assert!(h.out_names().is_empty());
}

#[test]
fn concurrent_saves_of_one_plan_write_one_copy() {
    let h = H::new();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    let (one, two) = (h.dest("one.mrpack"), h.dest("two.mrpack"));
    let (st, store) = (&h.st, &h.store);
    let results: Vec<Result<SavedPack>> = std::thread::scope(|s| {
        let a = s.spawn(|| save(st, store, &plan.id, &one, false));
        let b = s.spawn(|| save(st, store, &plan.id, &two, false));
        vec![a.join().expect("thread"), b.join().expect("thread")]
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1, "{results:?}");
    assert!(results.iter().any(|r| matches!(r, Err(Error::NotFound { .. }))), "{results:?}");
    assert_eq!(h.out_names().len(), 1, "one copy, no temp left: {:?}", h.out_names());
}

// ── Destinations ─────────────────────────────────────────────────────────────

#[test]
fn the_opened_pack_is_never_the_destination() {
    let h = H::new();
    let before = h.pack_sha1();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    let e = h.save(&plan.id, &h.pack, true).expect_err("the pack itself");
    assert!(msg(&e).contains("is an opened pack"), "{e}");
    #[cfg(windows)]
    {
        let upper = h.pack.with_file_name("MY PACK.MRPACK");
        let e = h.save(&plan.id, &upper, true).expect_err("same file, other case");
        assert!(msg(&e).contains("is an opened pack"), "{e}");
    }
    let e = h.save(&plan.id, &h.dest("copy.zip"), false).expect_err("extension");
    assert!(msg(&e).contains("does not end in .mrpack"), "{e}");
    assert_eq!(h.pack_sha1(), before);
    assert!(h.store.contains(&plan.id), "a refused save keeps the plan");
    // Next to the pack is fine.
    let next = h.pack.with_file_name("My Pack (fixed).mrpack");
    h.save(&plan.id, &next, false).expect("save next to it");
    assert_eq!(h.pack_sha1(), before);
}

#[test]
fn an_opened_pack_under_another_name_is_never_replaced() {
    let h = H::new();
    let before = h.pack_sha1();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");

    // A hard link to the pack (another path, the same file).
    let link = h.dest("alias.mrpack");
    std::fs::hard_link(&h.pack, &link).expect("hard link");
    let e = h.save(&plan.id, &link, true).expect_err("hard link");
    assert!(msg(&e).contains("is an opened pack"), "{e}");

    // A folder alias of the pack's folder.
    let alias_dir = h.dir.join("alias-dir");
    let made = {
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&alias_dir)
                .arg(h.dir.join("Downloads"))
                .output()
                .is_ok_and(|o| o.status.success())
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(h.dir.join("Downloads"), &alias_dir).is_ok()
        }
    };
    if made {
        let e = h.save(&plan.id, &alias_dir.join("My Pack.mrpack"), true).expect_err("folder alias");
        assert!(msg(&e).contains("is an opened pack"), "{e}");
    } else {
        eprintln!("skipped the folder-alias case: a junction or symlink could not be made here");
    }

    // The administrative share of the pack's drive (Windows; only where it is reachable).
    #[cfg(windows)]
    {
        let s = h.pack.display().to_string();
        if let Some(rest) = s.strip_prefix("C:\\") {
            let unc = PathBuf::from(format!("\\\\localhost\\C$\\{rest}"));
            if std::fs::metadata(&unc).is_ok() {
                let e = h.save(&plan.id, &unc, true).expect_err("network-share alias");
                assert!(msg(&e).contains("is an opened pack"), "{e}");
            } else {
                eprintln!("skipped the network-share case: \\\\localhost\\C$ is not reachable here");
            }
        }
    }

    // Another opened pack, by its path and through a hard link.
    let second = h.open_second_pack();
    let second_sha1 = sha1_of(&std::fs::read(&second).expect("read"));
    let e = h.save(&plan.id, &second, true).expect_err("second pack");
    assert!(msg(&e).contains("is an opened pack"), "{e}");
    let link2 = h.dest("alias2.mrpack");
    std::fs::hard_link(&second, &link2).expect("hard link");
    let e = h.save(&plan.id, &link2, true).expect_err("second pack, hard link");
    assert!(msg(&e).contains("is an opened pack"), "{e}");

    assert_eq!(h.pack_sha1(), before);
    assert_eq!(sha1_of(&std::fs::read(&second).expect("read")), second_sha1);
    assert!(h.store.contains(&plan.id));
    assert_eq!(h.out_names(), vec!["alias.mrpack".to_string(), "alias2.mrpack".to_string()]);
}

#[test]
fn a_hard_link_that_appears_right_before_the_replacing_rename_is_refused() {
    let h = H::new();
    let before = h.pack_sha1();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    let dest = h.dest("copy.mrpack");
    std::fs::write(&dest, b"mine").expect("write");
    let pack = h.pack.clone();
    hook::set(move |stage, _, dest| {
        if stage == Stage::BeforeMove {
            std::fs::remove_file(dest)?;
            std::fs::hard_link(&pack, dest)?;
        }
        Ok(())
    });
    let e = h.save(&plan.id, &dest, true).expect_err("swapped for the pack");
    hook::clear();
    assert!(msg(&e).contains("is an opened pack"), "{e}");
    assert_eq!(h.pack_sha1(), before);
    assert_eq!(h.out_names(), vec!["copy.mrpack".to_string()], "temp removed");
}

#[test]
fn existing_files_are_never_replaced_unconfirmed_and_temps_are_cleaned() {
    let h = H::new();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    let dest = h.dest("copy.mrpack");
    std::fs::write(&dest, b"mine").expect("write");
    let e = h.save(&plan.id, &dest, false).expect_err("exists");
    assert!(matches!(e, Error::Conflict(_)), "{e}");
    assert_eq!(std::fs::read(&dest).expect("read"), b"mine");
    assert_eq!(h.out_names(), vec!["copy.mrpack".to_string()]);
    assert!(h.store.contains(&plan.id), "another name may still be chosen");

    // A failure right before the move: the temp file goes, the plan stays.
    let fresh = h.dest("fresh.mrpack");
    hook::set(|stage, temp, _| {
        if stage == Stage::BeforeMove {
            assert!(temp.exists());
            return Err(std::io::Error::other("injected (test)"));
        }
        Ok(())
    });
    let e = h.save(&plan.id, &fresh, false).expect_err("injected");
    hook::clear();
    assert!(msg(&e).contains("injected"), "{e}");
    assert_eq!(h.out_names(), vec!["copy.mrpack".to_string()], "temp removed, nothing at the destination");

    // Something appears at the destination meanwhile: the no-replace rename refuses it.
    hook::set(|stage, _, dest| if stage == Stage::BeforeMove { std::fs::write(dest, b"racer") } else { Ok(()) });
    let e = h.save(&plan.id, &fresh, false).expect_err("race");
    hook::clear();
    assert!(matches!(e, Error::Conflict(_)), "{e}");
    assert_eq!(std::fs::read(&fresh).expect("read"), b"racer");
    assert_eq!(h.out_names(), vec!["copy.mrpack".to_string(), "fresh.mrpack".to_string()]);

    // Replacing the exact path the dialog confirmed.
    let saved = h.save(&plan.id, &dest, true).expect("confirmed replace");
    assert_eq!(PathBuf::from(saved.path), dest);
    assert_eq!(paths_of(&index_of(&std::fs::read(&dest).expect("read"))), vec!["mods/sodium-0.5.8.jar", "resourcepacks/pack.zip"]);
    assert_eq!(h.out_names(), vec!["copy.mrpack".to_string(), "fresh.mrpack".to_string()]);
}

#[test]
fn a_name_that_needed_the_extension_never_replaces_a_file() {
    let h = H::new();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    // The dialog confirmed `copy`; `copy.mrpack` is another file the user never confirmed.
    let existing = h.dest("copy.mrpack");
    std::fs::write(&existing, b"mine").expect("write");
    let (dest, may_replace) = destination(h.dest("copy")).expect("dest");
    assert_eq!((dest.clone(), may_replace), (existing.clone(), false));
    let e = h.save(&plan.id, &dest, may_replace).expect_err("not confirmed");
    assert!(matches!(e, Error::Conflict(_)), "{e}");
    assert_eq!(std::fs::read(&existing).expect("read"), b"mine");
    // A confirmed `.mrpack` name (any case) may be replaced.
    assert_eq!(destination(h.dest("Copy.MRPACK")).expect("dest"), (h.dest("Copy.MRPACK"), true));
    assert!(destination(h.dest("x.txt:evil")).is_err());
}

#[test]
fn stale_temp_files_are_removed_and_nothing_else() {
    let h = H::new();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    let old = h.dest(".modpack-doctor-pack-0123456789abcdef.tmp");
    let young = h.dest(".modpack-doctor-pack-fedcba9876543210.tmp");
    let other = h.dest(".modpack-doctor-pack-notmine.tmp");
    let old_dir = h.dest(".modpack-doctor-pack-aaaaaaaaaaaaaaaa.tmp");
    for p in [&old, &young, &other] {
        std::fs::write(p, b"x").expect("write");
    }
    std::fs::create_dir(&old_dir).expect("mkdir");
    let two_hours_ago = SystemTime::now() - Duration::from_secs(2 * 3600);
    set_mtime(&old, two_hours_ago);
    set_mtime(&other, two_hours_ago);
    h.save(&plan.id, &h.dest("copy.mrpack"), false).expect("save");
    assert_eq!(h.out_names(), vec![
        ".modpack-doctor-pack-aaaaaaaaaaaaaaaa.tmp".to_string(),
        ".modpack-doctor-pack-fedcba9876543210.tmp".to_string(),
        ".modpack-doctor-pack-notmine.tmp".to_string(),
        "copy.mrpack".to_string(),
    ]);
    assert!(is_temp_name(".modpack-doctor-pack-0123456789abcdef.tmp"));
    for bad in [".modpack-doctor-pack-0123456789ABCDEF.tmp", ".modpack-doctor-pack-0123.tmp", "x.modpack-doctor-pack-0123456789abcdef.tmp", ".modpack-doctor-pack-0123456789abcdef.tmp.mrpack"] {
        assert!(!is_temp_name(bad), "{bad}");
    }
}

#[test]
fn a_pack_changed_since_planning_is_refused_and_the_plan_dropped() {
    let h = H::new();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    // The temp-dir pack is replaced by another valid pack.
    let other = index_json(json!({"minecraft": "1.20.4", "fabric-loader": "0.15.11"}));
    std::fs::write(&h.pack, pack_bytes(&other)).expect("rewrite");
    let e = h.save(&plan.id, &h.dest("copy.mrpack"), false).expect_err("changed");
    assert!(matches!(e, Error::Conflict(_)), "{e}");
    assert!(msg(&e).contains("changed since the fixed copy was planned"), "{e}");
    assert!(h.out_names().is_empty());
    assert!(!h.store.contains(&plan.id), "a stale plan is dropped");
}

#[test]
fn a_pack_whose_mtime_alone_changed_is_refused() {
    let h = H::new();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    set_mtime(&h.pack, SystemTime::now() + Duration::from_secs(3600));
    let e = h.save(&plan.id, &h.dest("copy.mrpack"), false).expect_err("touched");
    assert!(msg(&e).contains("changed since the fixed copy was planned"), "{e}");
    assert!(!h.store.contains(&plan.id));
    assert!(h.out_names().is_empty());
}

#[test]
fn a_pack_that_changes_while_it_is_copied_is_refused() {
    let h = H::new();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    let pack = h.pack.clone();
    hook::set(move |stage, _, _| {
        if stage == Stage::Written {
            OpenOptions::new().write(true).open(&pack)?.set_modified(SystemTime::now() + Duration::from_secs(60))?;
        }
        Ok(())
    });
    let e = h.save(&plan.id, &h.dest("copy.mrpack"), false).expect_err("changed meanwhile");
    hook::clear();
    assert!(matches!(e, Error::Conflict(_)), "{e}");
    assert!(h.out_names().is_empty(), "temp removed: {:?}", h.out_names());
    assert!(!h.store.contains(&plan.id));
}

#[test]
fn a_copy_that_does_not_read_back_is_never_moved_into_place() {
    let h = H::new();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    hook::set(|stage, temp, _| if stage == Stage::Written { std::fs::write(temp, b"not a zip") } else { Ok(()) });
    let e = h.save(&plan.id, &h.dest("copy.mrpack"), false).expect_err("bad copy");
    hook::clear();
    assert!(matches!(e, Error::Internal(_)), "{e}");
    assert!(msg(&e).contains("did not read back correctly"), "{e}");
    assert!(h.out_names().is_empty(), "temp removed: {:?}", h.out_names());
    assert!(h.store.contains(&plan.id), "the plan may be tried again");
    h.save(&plan.id, &h.dest("copy.mrpack"), false).expect("then it works");
}

#[test]
fn a_closed_pack_cannot_be_planned_or_saved() {
    let h = H::new();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    h.st.remove_opened_pack(&h.id).expect("close");
    assert!(h.save(&plan.id, &h.dest("copy.mrpack"), false).is_err(), "the guard no longer allows reading it");
    assert!(h.plan_offline(vec![remove("mods/lithium.jar")]).is_err());
    assert!(h.out_names().is_empty());
}

// ── Wording ──────────────────────────────────────────────────────────────────

#[test]
fn refusals_are_copy_sentences() {
    // Two entries that are one file on Windows: the scan refuses the whole pack.
    let index = index_json(fabric_deps());
    let h = H::with_pack(raw_zip(&[(INDEX_NAME, index.as_bytes()), ("overrides/mods/A.jar", b"a"), ("overrides/mods/a.jar", b"b")], &[]));
    let e = h.plan_offline(vec![remove("mods/lithium.jar")]).expect_err("refused");
    let m = msg(&e);
    assert!(m.contains("the pack cannot be copied safely because the pack has entries named"), "{m}");
    assert!(!m.contains("scanned") && !m.contains(": The"), "{m}");
    // An index of another format version.
    let bad = index.replace("\"formatVersion\":1", "\"formatVersion\":2");
    let h = H::with_pack(pack_bytes(&bad));
    let m = msg(&h.plan_offline(vec![remove("mods/lithium.jar")]).expect_err("refused"));
    assert!(m.contains("the pack cannot be copied because the pack's modrinth.index.json has formatVersion 2; only formatVersion 1 is supported."), "{m}");
    assert!(!m.contains("could not be listed"), "{m}");

    assert_eq!(as_reason("The pack has 3 entries, more than the 2 Modpack Doctor reads, so it was not scanned (it may be a zip bomb)."), "the pack has 3 entries, more than the 2 Modpack Doctor reads (it may be a zip bomb)");
    assert_eq!(as_reason("ZIP64 thing."), "ZIP64 thing");
    // Write failures name the folder (disk full, no permission, …), not "please report this".
    let dir = Path::new("out");
    let SaveError::Keep(e) = write_error(dir, Path::new("p.mrpack"), ZipError::Io(std::io::Error::other("disk full"))) else { panic!("kept") };
    assert!(matches!(e, Error::Io { .. }), "{e}");
    let SaveError::Keep(e) = write_error(dir, dir, ZipError::Io(std::io::ErrorKind::PermissionDenied.into())) else { panic!("kept") };
    assert!(matches!(e, Error::Permission { .. }), "{e}");
}

#[test]
fn download_links_follow_the_core_allowlist_rule() {
    for ok in [
        "https://cdn.modrinth.com/data/a/versions/b/x.jar",
        "HTTPS://cdn.modrinth.com/x",
        "https://CDN.MODRINTH.COM:443/x",
        "https://github.com/a/b/releases/download/1/x.jar",
        "https://raw.githubusercontent.com/a/b/x.jar",
        "https://gitlab.com/a/b/-/x.jar",
        "https://gitlab.com?x",
    ] {
        assert!(download_allowed(ok), "{ok}");
    }
    for bad in [
        "",
        "http://cdn.modrinth.com/x",
        "https://evil.example/x",
        "https://cdn.modrinth.com@evil.example/x",
        "https://cdn.modrinth.com:8443/x",
        "https://evil.github.com/x",
        "https://github.com.evil.example/x",
        "https://cdn.modrinth.com./x",
        "https://[::1]/x",
        "https://cdn.modr\u{131}nth.com/x",
        "https://xn--cdn-modrnth-ub.com/x",
        "https://cdn.modrinth.com/a b",
        "https://cdn.modrinth.com\\x",
        "cdn.modrinth.com/x",
        "invalid:not-a-list",
        "https://:443/x",
    ] {
        assert!(!download_allowed(bad), "{bad}");
    }
    assert!(!download_allowed(&format!("https://cdn.modrinth.com/{}", "x".repeat(5000))));
}

// ── Names ────────────────────────────────────────────────────────────────────

#[test]
fn copy_names() {
    assert_eq!(default_copy_name("My Pack.mrpack"), "My Pack (fixed).mrpack");
    assert_eq!(default_copy_name("pack.MRPACK"), "pack (fixed).mrpack");
    assert_eq!(default_copy_name(".mrpack"), "mrpack (fixed).mrpack");
    assert_eq!(default_copy_name("... .mrpack"), "modpack (fixed).mrpack");
    assert_eq!(default_copy_name("a:b?.mrpack"), "a-b- (fixed).mrpack");
    assert_eq!(default_copy_name("a\u{202E}b.mrpack"), "ab (fixed).mrpack");
    assert!(default_copy_name(&format!("{}.mrpack", "x".repeat(400))).chars().count() <= MAX_DEFAULT_NAME);
    let p = |s: &str| PathBuf::from(s);
    assert_eq!(enforce_mrpack_extension(p("/d/copy.mrpack")).expect("ok"), p("/d/copy.mrpack"));
    assert_eq!(enforce_mrpack_extension(p("/d/copy.MRPACK")).expect("ok"), p("/d/copy.MRPACK"));
    assert_eq!(enforce_mrpack_extension(p("/d/copy")).expect("ok"), p("/d/copy.mrpack"));
    assert_eq!(enforce_mrpack_extension(p("/d/copy.zip")).expect("ok"), p("/d/copy.zip.mrpack"));
    assert!(enforce_mrpack_extension(p("/d/notes.txt:evil")).is_err());
}
