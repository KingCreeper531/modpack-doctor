//! Fixed copies of opened packs. Temp dirs only (every pack is built in one), no real network:
//! Modrinth is a wiremock server driven through the real `ModrinthClient`.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};
use zip::write::SimpleFileOptions;

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

fn fabric_jar(id: &str) -> Vec<u8> {
    JarBuilder::new()
        .fabric_mod_json(&format!(r#"{{"schemaVersion":1,"id":"{id}","version":"1.0.0"}}"#))
        .class(&format!("com/{id}/Main.class"), 61)
        .build()
}

/// The standard index: three declared files (one with an `env` and an unknown field), unknown
/// fields at the root and in `dependencies`.
fn index_json(deps: Value) -> String {
    json!({
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": "1.0.0",
        "name": "My Pack",
        "summary": "kept",
        "x-custom": {"keep": [1, 2, 3]},
        "files": [
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
                "hashes": {"sha1": "6".repeat(40), "sha512": "b".repeat(128)},
                "downloads": ["https://cdn.modrinth.com/data/x/versions/y/lithium.jar"],
                "fileSize": 200
            },
            {
                "path": "resourcepacks/pack.zip",
                "hashes": {"sha1": "7".repeat(40), "sha512": "c".repeat(128)},
                "downloads": ["https://cdn.modrinth.com/data/z/versions/w/pack.zip"],
                "fileSize": 300
            }
        ],
        "dependencies": deps
    })
    .to_string()
}

fn fabric_deps() -> Value {
    json!({"minecraft": "1.20.1", "fabric-loader": "0.15.11", "x-future": "9"})
}

/// The standard pack: the index, two override jars directly in `mods/`, a config file and a
/// stray jar outside `mods/`.
fn pack_bytes(index: &str) -> Vec<u8> {
    JarBuilder::new()
        .file("modrinth.index.json", index)
        .file("overrides/mods/extra.jar", fabric_jar("extra"))
        .file("overrides/config/extra.toml", "a = 1")
        .file("overrides/stray.jar", fabric_jar("stray"))
        .file("client-overrides/mods/menu.jar", fabric_jar("menu"))
        .build()
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
        // Project titles: none known (the version name is used).
        h.mount(Mock::given(method("GET")).and(path("/v2/projects")).respond_with(ResponseTemplate::new(200).set_body_json(json!([]))));
        h
    }

    fn mount(&self, m: Mock) {
        self.rt.block_on(m.mount(&self.server));
    }

    fn mount_version(&self, v: Value) {
        let id = v["id"].as_str().expect("id").to_string();
        self.mount(Mock::given(method("GET")).and(path(format!("/v2/version/{id}"))).respond_with(ResponseTemplate::new(200).set_body_json(v)));
    }

    /// The pack's `mods/sodium-0.5.8.jar` is version CURRENT of PROJECT.
    fn mount_identify(&self) {
        let current = version(CURRENT, PROJECT, "0.5.8", "sodium-0.5.8.jar");
        self.mount(
            Mock::given(method("POST"))
                .and(path("/v2/version_files"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({ sodium_sha1(): current }))),
        );
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
        let mut v: Vec<String> =
            std::fs::read_dir(self.dir.join("out")).expect("ls").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
}

/// A Modrinth version JSON (Fabric, 1.20.1) with one primary CDN file.
fn version(id: &str, project: &str, number: &str, file: &str) -> Value {
    json!({
        "id": id,
        "project_id": project,
        "version_number": number,
        "name": format!("Mod {number}"),
        "game_versions": ["1.20.1"],
        "loaders": ["fabric"],
        "version_type": "release",
        "date_published": "2024-03-01T00:00:00Z",
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
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
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
fn an_added_dependency_has_no_env() {
    let h = H::new();
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let plan = h.plan(vec![add(DEP)]).expect("plan");
    assert_eq!(plan.ops[0].kind, PackFixOpKind::Add);
    assert_eq!(plan.ops[0].subject, "mods/cloth-config-11.jar");
    assert!(plan.ops[0].detail.contains("no env, so launchers install it on both client and server"), "{}", plan.ops[0].detail);
    let dest = h.dest("copy.mrpack");
    h.save(&plan.id, &dest, false).expect("save");
    let index = index_of(&std::fs::read(&dest).expect("read"));
    let last = index["files"].as_array().expect("files").last().expect("entry").clone();
    assert_eq!(last["path"], "mods/cloth-config-11.jar");
    assert!(last.get("env").is_none());
    let res = scan_copy(&dunce::canonicalize(&dest).expect("canon"));
    assert!(res.declared.iter().any(|d| d.path == "mods/cloth-config-11.jar" && d.client.is_none() && d.size == 4096));
}

#[test]
fn unsafe_entries_are_left_out_with_a_warning() {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default();
    zip.start_file(INDEX_NAME, opts).expect("start");
    zip.write_all(index_json(fabric_deps()).as_bytes()).expect("write");
    zip.start_file("../evil.txt", opts).expect("start");
    zip.write_all(b"evil").expect("write");
    zip.start_file("overrides/config/ok.toml", opts).expect("start");
    zip.write_all(b"a = 1").expect("write");
    let bytes = zip.finish().expect("finish").into_inner();
    let h = H::with_pack(bytes);
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    assert_eq!(plan.warnings.len(), 1);
    assert!(plan.warnings[0].contains("../evil.txt"), "{}", plan.warnings[0]);
    let dest = h.dest("copy.mrpack");
    h.save(&plan.id, &dest, false).expect("save");
    let names: Vec<String> = raw_entries(&std::fs::read(&dest).expect("read")).into_iter().map(|e| e.0).collect();
    assert_eq!(names, vec![INDEX_NAME.to_string(), "overrides/config/ok.toml".to_string()]);
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

    let sodium = "mods/sodium-0.5.8.jar";
    let cases = [
        (replace(sodium, "OTHver01"), "belongs to a different Modrinth project"),
        (replace(sodium, CURRENT), "already has version 0.5.8"),
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
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    h.plan(vec![add(DEP)]).expect("Quilt loads Fabric mods");

    let h = H::with_pack(pack_bytes(&index_json(json!({"minecraft": "1.20.1"}))));
    h.mount_version(version(DEP, DEP_PROJECT, "11.0.0", "cloth-config-11.jar"));
    let e = h.plan(vec![add(DEP)]).expect_err("no loader");
    assert!(msg(&e).contains("does not name both its Minecraft version and its mod loader"), "{e}");
}

#[test]
fn path_collisions_are_refused() {
    let h = H::new();
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
    dup["files"][0]["hashes"]["sha1"] = json!("6".repeat(40));
    h.mount_version(dup);
    let e = h.plan(vec![add("DUPhash1")]).expect_err("already listed");
    assert!(msg(&e).contains("already lists this exact file as mods/lithium.jar"), "{e}");
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
fn existing_files_are_never_replaced_unconfirmed_and_temps_are_cleaned() {
    let h = H::new();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    let dest = h.dest("copy.mrpack");
    std::fs::write(&dest, b"mine").expect("write");
    let e = h.save(&plan.id, &dest, false).expect_err("exists");
    assert!(matches!(e, Error::Conflict(_)), "{e}");
    assert_eq!(std::fs::read(&dest).expect("read"), b"mine");
    assert_eq!(h.out_names(), vec!["copy.mrpack".to_string()]);

    // A failure right before the move: the temp file goes, the plan stays.
    let fresh = h.dest("fresh.mrpack");
    hook::set(|temp, _| {
        assert!(temp.exists());
        Err(std::io::Error::other("injected (test)"))
    });
    let e = h.save(&plan.id, &fresh, false).expect_err("injected");
    hook::clear();
    assert!(msg(&e).contains("injected"), "{e}");
    assert_eq!(h.out_names(), vec!["copy.mrpack".to_string()], "temp removed, nothing at the destination");

    // Something appears at the destination meanwhile: the no-replace rename refuses it.
    hook::set(|_, dest| std::fs::write(dest, b"racer"));
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
fn a_pack_changed_since_planning_is_refused() {
    let h = H::new();
    let plan = h.plan_offline(vec![remove("mods/lithium.jar")]).expect("plan");
    // The temp-dir pack is replaced by another valid pack.
    let other = index_json(json!({"minecraft": "1.20.4", "fabric-loader": "0.15.11"}));
    std::fs::write(&h.pack, pack_bytes(&other)).expect("rewrite");
    let e = h.save(&plan.id, &h.dest("copy.mrpack"), false).expect_err("changed");
    assert!(matches!(e, Error::Conflict(_)), "{e}");
    assert!(msg(&e).contains("changed since the fixed copy was planned"), "{e}");
    assert!(h.out_names().is_empty());
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
