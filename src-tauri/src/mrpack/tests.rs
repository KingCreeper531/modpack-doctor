//! `.mrpack` reading: index, declared files, override jars, zip safety and limits. Every pack is
//! built in a temp dir; nothing else is touched.

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::*;
use crate::model::{JarStatus, LoaderInfo, LoaderKind};
use crate::test_support::JarBuilder;

// ── Builders ─────────────────────────────────────────────────────────────────

/// A `.mrpack` zip under construction. Entry names are written verbatim (no validation), so
/// unsafe names can be produced.
struct Pack {
    zip: ZipWriter<Cursor<Vec<u8>>>,
}

impl Pack {
    fn new() -> Self {
        Pack { zip: ZipWriter::new(Cursor::new(Vec::new())) }
    }

    fn entry(mut self, name: &str, bytes: &[u8], method: CompressionMethod) -> Self {
        let opts = SimpleFileOptions::default().compression_method(method).large_file(bytes.len() as u64 >= u32::MAX as u64);
        self.zip.start_file(name, opts).expect("start_file");
        self.zip.write_all(bytes).expect("write");
        self
    }

    fn file(self, name: &str, bytes: &[u8]) -> Self {
        self.entry(name, bytes, CompressionMethod::Deflated)
    }

    fn stored(self, name: &str, bytes: &[u8]) -> Self {
        self.entry(name, bytes, CompressionMethod::Stored)
    }

    fn index(self, json: &str) -> Self {
        self.file(INDEX_NAME, json.as_bytes())
    }

    fn symlink(mut self, name: &str, target: &str) -> Self {
        self.zip.add_symlink(name, target, SimpleFileOptions::default()).expect("symlink");
        self
    }

    fn build(self) -> Vec<u8> {
        self.zip.finish().expect("finish").into_inner()
    }

    fn write(self, dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, self.build()).expect("write pack");
        dunce::canonicalize(&p).expect("canon")
    }
}

const SHA1: &str = "bcdbf37d2a6e3d8b0c1f2e3d4c5b6a798877665a";

fn sha512() -> String {
    "81c64f9c".repeat(16)
}

fn file_json(path: &str) -> String {
    format!(
        r#"{{"path":"{path}","hashes":{{"sha1":"{SHA1}","sha512":"{}"}},"env":{{"client":"required","server":"unsupported"}},"downloads":["https://cdn.modrinth.com/data/AANobbMI/versions/x/a.jar","https://example.com/a.jar"],"fileSize":971552}}"#,
        sha512()
    )
}

fn index_json(deps: &str, files: &[String]) -> String {
    format!(
        r#"{{"formatVersion":1,"game":"minecraft","versionId":"1.2.0","name":"My Pack","summary":"s","files":[{}],"dependencies":{deps}}}"#,
        files.join(",")
    )
}

fn fabric_jar(id: &str) -> Vec<u8> {
    JarBuilder::new()
        .fabric_mod_json(&format!(r#"{{"schemaVersion":1,"id":"{id}","version":"1.0.0","depends":{{"minecraft":">=1.20"}}}}"#))
        .class(&format!("com/{id}/Main.class"), 61)
        .build()
}

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

/// Guard with the pack registered by the read-only exact-file rule only (as the app does).
fn guard_for(pack: &Path) -> PathGuard {
    let g = PathGuard::new();
    g.set_read_only_files(&[pack.to_path_buf()]);
    g
}

fn scan(pack: &Path) -> ScanResult {
    scan_pack(&guard_for(pack), pack, "pack", |_| {}, |_| {}).expect("scan")
}

fn issue_for<'a>(res: &'a ScanResult, subject: &str) -> Vec<&'a ScanIssue> {
    res.issues.iter().filter(|i| i.subject == subject).collect()
}

fn has_issue(res: &ScanResult, needle: &str) -> bool {
    res.issues.iter().any(|i| i.message.contains(needle))
}

// ── Valid packs ──────────────────────────────────────────────────────────────

#[test]
fn valid_fabric_pack_describes_and_scans() {
    let t = tmp();
    let pack = Pack::new()
        .index(&index_json(
            r#"{"minecraft":"1.20.1","fabric-loader":"0.16.10","some-future-key":"9"}"#,
            &[file_json("mods/sodium.jar"), file_json("resourcepacks/x.zip")],
        ))
        .file("overrides/mods/extra.jar", &fabric_jar("extra"))
        .file("overrides/config/extra.toml", b"a = 1")
        .file("client-overrides/mods/client-only.jar", &fabric_jar("clientonly"))
        .file("server-overrides/mods/server-only.jar", &fabric_jar("serveronly"))
        .file("mods/not-an-override.jar", &fabric_jar("ignored"))
        .write(t.path(), "My Pack.mrpack");

    let inst = describe_pack(&pack);
    assert_eq!(inst.launcher, Launcher::Mrpack);
    assert_eq!(inst.root, pack.display().to_string());
    assert_eq!(inst.game_dir, inst.root);
    assert_eq!(inst.id, discovery::instance_id(&pack, Os::current()));
    assert_eq!(inst.name, "My Pack");
    assert_eq!(inst.metadata_source, MetadataSource::Mrpack);
    assert_eq!(inst.mc_version.as_deref(), Some("1.20.1"));
    assert_eq!(inst.loader, Some(LoaderInfo { kind: LoaderKind::Fabric, version: Some("0.16.10".into()) }));
    assert_eq!(inst.side, Side::Client);
    assert_eq!(inst.mod_count, 4, "one declared jar + three override jars");

    let mut stubs = Vec::new();
    let mut progress = std::sync::Mutex::new(Vec::new());
    let res = scan_pack(&guard_for(&pack), &pack, "pack", |s| stubs = s.to_vec(), |p| {
        progress.lock().expect("lock").push(p)
    })
    .expect("scan");
    let progress = progress.get_mut().expect("lock");
    assert_eq!(res.instance_id, "pack");
    assert_eq!(res.declared.len(), 2);
    let d = &res.declared[0];
    assert_eq!(d.path, "mods/sodium.jar");
    assert_eq!(d.sha1, SHA1);
    assert_eq!(d.sha512, sha512());
    assert_eq!(d.size, 971_552);
    assert_eq!(d.client.as_deref(), Some("required"));
    assert_eq!(d.server.as_deref(), Some("unsupported"));
    assert_eq!(d.downloads.len(), 2, "every download URL is passed through for src/core to judge");

    let ids: Vec<&str> = res.jars.iter().filter(|j| j.depth == 0).map(|j| j.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["client-overrides/mods/client-only.jar", "overrides/mods/extra.jar", "server-overrides/mods/server-only.jar"]
    );
    for j in &res.jars {
        assert_eq!(j.status, JarStatus::Ok, "{}", j.id);
        assert_eq!(j.path, j.id, "relPath is the path inside the zip");
        assert_eq!(j.sha1.len(), 40);
        assert_eq!(j.mods.len(), 1);
    }
    assert_eq!(stubs.iter().map(|s| s.file_name.as_str()).collect::<Vec<_>>(), vec!["client-only.jar", "extra.jar", "server-only.jar"]);
    assert_eq!(progress.len(), 3);
    assert!(progress.iter().all(|p| p.parsed && p.total == 3));
    assert!(res.issues.is_empty(), "{:?}", res.issues);
}

#[test]
fn loader_dependency_keys() {
    let t = tmp();
    let cases = [
        (r#"{"minecraft":"1.20.1","forge":"47.2.0"}"#, Some((LoaderKind::Forge, "47.2.0"))),
        (r#"{"minecraft":"1.21.1","neoforge":"21.1.77"}"#, Some((LoaderKind::Neoforge, "21.1.77"))),
        (r#"{"minecraft":"1.20.1","quilt-loader":"0.26.0"}"#, Some((LoaderKind::Quilt, "0.26.0"))),
        (r#"{"minecraft":"26.1","fabric-loader":"0.17.0","unknown-key":{"x":1}}"#, Some((LoaderKind::Fabric, "0.17.0"))),
        (r#"{"minecraft":"1.20.1","unknown-key":"1"}"#, None),
    ];
    for (i, (deps, want)) in cases.iter().enumerate() {
        let pack = Pack::new().index(&index_json(deps, &[])).write(t.path(), &format!("p{i}.mrpack"));
        let inst = describe_pack(&pack);
        assert_eq!(inst.metadata_source, MetadataSource::Mrpack, "{deps}");
        assert!(inst.mc_version.is_some(), "{deps}");
        let got = inst.loader.map(|l| (l.kind, l.version.unwrap_or_default()));
        assert_eq!(got, want.map(|(k, v)| (k, v.to_string())), "{deps}");
    }
}

#[test]
fn unusable_index_leaves_metadata_to_inference() {
    let t = tmp();
    let pack = Pack::new().index("{not json").write(t.path(), "Broken Pack.MRPACK");
    let inst = describe_pack(&pack);
    assert_eq!(inst.name, "Broken Pack");
    assert_eq!(inst.metadata_source, MetadataSource::Inferred);
    assert_eq!(inst.loader, None);
}

// ── Override precedence ──────────────────────────────────────────────────────

#[test]
fn override_precedence_is_recorded_and_both_copies_scanned() {
    let t = tmp();
    let pack = Pack::new()
        .index(&index_json(r#"{"minecraft":"1.20.1","fabric-loader":"0.16.10"}"#, &[]))
        .file("overrides/mods/same.jar", &fabric_jar("same"))
        .file("client-overrides/mods/same.jar", &fabric_jar("same"))
        .write(t.path(), "p.mrpack");
    let res = scan(&pack);
    let ids: Vec<&str> = res.jars.iter().map(|j| j.id.as_str()).collect();
    assert_eq!(ids, vec!["client-overrides/mods/same.jar", "overrides/mods/same.jar"]);
    let notes = issue_for(&res, "overrides/mods/same.jar");
    assert_eq!(notes.len(), 1, "{:?}", res.issues);
    assert!(notes[0].message.contains("client install") && notes[0].message.contains("client-overrides/mods/same.jar"));
}

// ── Zip safety ───────────────────────────────────────────────────────────────

#[test]
fn unsafe_entries_are_skipped_as_issues() {
    let t = tmp();
    let jar = fabric_jar("evil");
    let bad = [
        ("overrides/../../evil.jar", "\"..\""),
        ("/overrides/mods/abs.jar", "absolute"),
        ("C:/overrides/mods/drive.jar", "drive letter"),
        ("overrides\\mods\\back.jar", "backslash"),
        ("overrides/mods/n\0ul.jar", "NUL"),
        ("overrides/mods/CON.jar", "reserves"),
        ("overrides/aux/x.jar", "reserves"),
        ("overrides/mods/x.jar. ", "reserves"),
    ];
    let mut pack = Pack::new().index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[])).file("overrides/mods/good.jar", &jar);
    for (name, _) in &bad {
        pack = pack.file(name, &jar);
    }
    let pack = pack.symlink("overrides/mods/link.jar", "../../../../etc/passwd").write(t.path(), "p.mrpack");
    let res = scan(&pack);
    let ids: Vec<&str> = res.jars.iter().map(|j| j.id.as_str()).collect();
    assert_eq!(ids, vec!["overrides/mods/good.jar"], "only the safe entry is scanned");
    for (name, why) in &bad {
        let shown = display_name(name);
        let hits = issue_for(&res, &shown);
        assert_eq!(hits.len(), 1, "{name:?}: {:?}", res.issues);
        assert!(hits[0].message.contains(why), "{name:?}: {}", hits[0].message);
    }
    let link = issue_for(&res, "overrides/mods/link.jar");
    assert_eq!(link.len(), 1);
    assert!(link[0].message.contains("symbolic link"));
}

#[test]
fn path_problem_rules() {
    for ok in ["overrides/mods/a.jar", "mods/a b.jar", "overrides/", "config/x.y.toml", "mods/名前.jar"] {
        assert_eq!(archive::path_problem(ok), None, "{ok}");
    }
    for bad in ["", "/", "..", "a/../b", "/etc", "\\x", "a\\b", "C:x", "c:/x", "a\0b", "nul", "mods/LPT1.txt", "a/b:c", "a/ b ", "a/x."] {
        assert!(archive::path_problem(bad).is_some(), "{bad:?}");
    }
}

#[test]
fn many_unsafe_entries_are_summed_up() {
    let t = tmp();
    let mut pack = Pack::new();
    for i in 0..(MAX_ENTRY_ISSUES + 5) {
        pack = pack.file(&format!("../x{i}"), b"x");
    }
    let res = scan(&pack.write(t.path(), "p.mrpack"));
    // 100 individual entries, one summary, one "no index".
    assert_eq!(res.issues.len(), MAX_ENTRY_ISSUES + 2, "{:?}", res.issues.len());
    assert!(has_issue(&res, "5 more unsafe pack entries were skipped"));
}

#[test]
fn compression_ratio_over_limit_is_refused() {
    let t = tmp();
    // A jar padded with 4 MiB of zeros compresses far beyond 200:1.
    let bomb = JarBuilder::new().fabric_mod_json(r#"{"schemaVersion":1,"id":"bomb","version":"1"}"#).build();
    let mut padded = bomb.clone();
    padded.extend(std::iter::repeat_n(0u8, 4 * MIB as usize));
    let pack = Pack::new()
        .index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[]))
        .file("overrides/mods/bomb.jar", &padded)
        .stored("overrides/mods/fine.jar", &fabric_jar("fine"))
        .write(t.path(), "p.mrpack");
    let mut stubs = Vec::new();
    let res = scan_pack(&guard_for(&pack), &pack, "pack", |s| stubs = s.to_vec(), |_| {}).expect("scan");
    assert_eq!(stubs.len(), 1, "a refused jar is not announced");
    assert_eq!(res.jars.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(), vec!["overrides/mods/fine.jar"]);
    let hits = issue_for(&res, "overrides/mods/bomb.jar");
    assert_eq!(hits.len(), 1);
    assert!(hits[0].message.contains("compression ratio"), "{}", hits[0].message);
}

#[test]
fn compressed_index_bomb_is_refused() {
    let t = tmp();
    let mut json = index_json(r#"{"minecraft":"1.20.1"}"#, &[]).into_bytes();
    json.extend(std::iter::repeat_n(b' ', 2 * MIB as usize));
    let pack = Pack::new().file(INDEX_NAME, &json).write(t.path(), "p.mrpack");
    let res = scan(&pack);
    assert!(res.declared.is_empty());
    assert!(issue_for(&res, INDEX_NAME).iter().any(|i| i.message.contains("compression ratio")), "{:?}", res.issues);
}

/// Patch every central-directory header's uncompressed size (the declared size a zip bomb lies
/// about) so the archive claims far more than it holds.
fn inflate_declared_sizes(mut bytes: Vec<u8>, size: u32) -> Vec<u8> {
    let sig = [0x50, 0x4b, 0x01, 0x02];
    let mut i = 0;
    let mut patched = 0;
    while i + 46 <= bytes.len() {
        if bytes[i..i + 4] == sig {
            bytes[i + 24..i + 28].copy_from_slice(&size.to_le_bytes());
            patched += 1;
            i += 46;
        } else {
            i += 1;
        }
    }
    assert!(patched > 0);
    bytes
}

#[test]
fn total_declared_size_over_limit_refuses_the_pack() {
    let t = tmp();
    let raw = Pack::new()
        .index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[file_json("mods/a.jar")]))
        .stored("overrides/mods/a.jar", &fabric_jar("a"))
        .build();
    // 2 × 0xF000_0000 bytes ≈ 7.5 GiB declared.
    let bytes = inflate_declared_sizes(raw, 0xF000_0000);
    let pack = t.path().join("bomb.mrpack");
    std::fs::write(&pack, bytes).expect("write");
    let pack = dunce::canonicalize(&pack).expect("canon");
    let res = scan(&pack);
    assert!(res.jars.is_empty() && res.declared.is_empty(), "nothing is read");
    assert!(has_issue(&res, "MiB limit"), "{:?}", res.issues);
    // Opening still works (the scan explains the problem).
    assert_eq!(describe_pack(&pack).metadata_source, MetadataSource::Inferred);
}

#[test]
fn too_many_entries_refuses_the_pack() {
    let t = tmp();
    let mut pack = Pack::new().index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[]));
    for i in 0..MAX_ENTRIES {
        pack = pack.stored(&format!("overrides/config/{i}"), b"");
    }
    let res = scan(&pack.write(t.path(), "p.mrpack"));
    assert!(res.declared.is_empty());
    assert!(has_issue(&res, "entries, more than the 20000"), "{:?}", res.issues);
}

#[test]
fn not_a_zip_is_an_issue_not_an_error() {
    let t = tmp();
    let pack = t.path().join("fake.mrpack");
    std::fs::write(&pack, b"this is not a zip").expect("write");
    let pack = dunce::canonicalize(&pack).expect("canon");
    let mut started = false;
    let res = scan_pack(&guard_for(&pack), &pack, "pack", |s| started = s.is_empty(), |_| {}).expect("scan");
    assert!(started, "ScanStarted still fires (empty)");
    assert!(has_issue(&res, "not a valid .mrpack (zip) file"), "{:?}", res.issues);
    assert_eq!(describe_pack(&pack).name, "fake");
}

#[test]
fn damaged_override_jar_is_corrupt_record() {
    let t = tmp();
    let pack = Pack::new()
        .index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[]))
        .stored("overrides/mods/broken.jar", b"PK not really")
        .write(t.path(), "p.mrpack");
    let res = scan(&pack);
    assert_eq!(res.jars.len(), 1);
    assert!(matches!(res.jars[0].status, JarStatus::Corrupt { .. }));
    assert_eq!(issue_for(&res, "overrides/mods/broken.jar").len(), 1);
}

// ── Index limits ─────────────────────────────────────────────────────────────

fn index_issues(json: &[u8]) -> (Option<index::PackIndex>, Vec<ScanIssue>) {
    let mut issues = Vec::new();
    let idx = index::parse(json, &mut issues);
    (idx, issues)
}

#[test]
fn index_problems_are_issues() {
    let (idx, issues) = index_issues(b"{\"formatVersion\":1,");
    assert!(idx.is_none() && issues[0].message.contains("not valid JSON"));

    let (idx, issues) = index_issues(br#"{"formatVersion":2,"game":"minecraft","files":[]}"#);
    assert!(idx.is_none() && issues[0].message.contains("formatVersion 2"), "{issues:?}");

    let (idx, issues) = index_issues(br#"{"game":"minecraft","files":[]}"#);
    assert!(idx.is_none() && issues[0].message.contains("formatVersion none"));

    let (idx, issues) = index_issues(br#"{"formatVersion":1,"game":"terraria","files":[]}"#);
    assert!(idx.is_none() && issues[0].message.contains("terraria"));

    let (idx, issues) = index_issues(b"[1,2]");
    assert!(idx.is_none() && issues[0].message.contains("not a JSON object"));

    // A BOM is tolerated.
    let mut bom = b"\xEF\xBB\xBF".to_vec();
    bom.extend(index_json(r#"{"minecraft":"1.20.1"}"#, &[]).bytes());
    let (idx, issues) = index_issues(&bom);
    assert!(idx.is_some() && issues.is_empty(), "{issues:?}");
}

#[test]
fn bad_files_entries_are_skipped_one_by_one() {
    let no_sha512 = format!(r#"{{"path":"mods/a.jar","hashes":{{"sha1":"{SHA1}"}}}}"#);
    let short_sha1 = format!(r#"{{"path":"mods/b.jar","hashes":{{"sha1":"abc","sha512":"{}"}}}}"#, sha512());
    let files = [
        file_json("mods/ok.jar"),
        no_sha512,
        short_sha1,
        r#"{"path":"mods/c.jar"}"#.to_string(),
        file_json("../escape.jar"),
        file_json("/abs.jar"),
        file_json("C:/drive.jar"),
        file_json("mods\\\\back.jar"),
        file_json("mods/nul.jar"),
        file_json("mods/"),
        r#"{"hashes":{}}"#.to_string(),
        "42".to_string(),
    ];
    let json = index_json(r#"{"minecraft":"1.20.1"}"#, &files);
    let (idx, issues) = index_issues(json.as_bytes());
    let idx = idx.expect("index");
    assert_eq!(idx.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["mods/ok.jar"]);
    assert_eq!(issues.len(), files.len() - 1, "{issues:#?}");
    assert!(issues.iter().all(|i| i.subject == INDEX_NAME));
    assert!(issues[0].message.contains("files[1]") && issues[0].message.contains("sha512"));
    assert!(issues[1].message.contains("sha1"));
    assert!(issues[3].message.contains("\"..\""));
    assert!(issues[6].message.contains("backslash"));
    assert!(issues[7].message.contains("reserves"));
}

#[test]
fn index_over_file_count_limit_lists_nothing() {
    let files: Vec<String> = (0..=MAX_INDEX_FILES).map(|_| "{}".to_string()).collect();
    let json = index_json(r#"{"minecraft":"1.20.1","forge":"47.2.0"}"#, &files);
    let (idx, issues) = index_issues(json.as_bytes());
    let idx = idx.expect("metadata is still read");
    assert!(idx.files.is_empty());
    assert_eq!(idx.loader.map(|l| l.kind), Some(LoaderKind::Forge));
    assert_eq!(issues.len(), 1);
    assert!(issues[0].message.contains("10001 files"));
}

#[test]
fn index_over_size_limit_is_not_read() {
    let t = tmp();
    // Stored (ratio 1:1), so only the 8 MiB cap applies.
    let mut json = index_json(r#"{"minecraft":"1.20.1"}"#, &[]).into_bytes();
    json.resize(MAX_INDEX_BYTES as usize + 1, b' ');
    let pack = Pack::new().stored(INDEX_NAME, &json).write(t.path(), "p.mrpack");
    let res = scan(&pack);
    let hits = issue_for(&res, INDEX_NAME);
    assert_eq!(hits.len(), 1);
    assert!(hits[0].message.contains("8 MiB limit"), "{}", hits[0].message);
    assert_eq!(describe_pack(&pack).metadata_source, MetadataSource::Inferred);
}

#[test]
fn missing_index_is_an_issue() {
    let t = tmp();
    let pack = Pack::new().file("overrides/mods/a.jar", &fabric_jar("a")).write(t.path(), "p.mrpack");
    let res = scan(&pack);
    assert_eq!(res.jars.len(), 1, "override jars are still scanned");
    assert!(issue_for(&res, INDEX_NAME)[0].message.contains("has no modrinth.index.json"));
}

// ── Opening rules ────────────────────────────────────────────────────────────

#[test]
fn open_rule_on_metadata() {
    assert!(check_pack_meta("a.mrpack", false, true, MAX_PACK_BYTES).is_ok());
    assert!(check_pack_meta("A.MrPack", false, true, 0).is_ok());
    let too_big = check_pack_meta("a.mrpack", false, true, MAX_PACK_BYTES + 1).expect_err("over 512 MiB");
    assert!(too_big.contains("512 MiB"));
    assert!(check_pack_meta("a.mrpack", true, false, 0).expect_err("folder").contains("Add folder"));
    assert!(check_pack_meta("a.mrpack", false, false, 0).expect_err("device").contains("not a regular file"));
    for name in ["a.zip", "a.mrpack.zip", ".mrpack", "mrpack", "a.mrpac"] {
        assert!(check_pack_meta(name, false, true, 1).expect_err(name).contains(".mrpack"), "{name}");
    }
}

#[test]
fn open_rule_on_real_paths() {
    let t = tmp();
    let pack = Pack::new().index(&index_json("{}", &[])).write(t.path(), "ok.mrpack");
    assert_eq!(check_pack_file(&pack).expect("ok"), pack);
    let folder = t.path().join("folder.mrpack");
    std::fs::create_dir_all(&folder).expect("mkdir");
    assert!(check_pack_file(&folder).expect_err("folder").contains("Add folder"));
    let zip = t.path().join("pack.zip");
    std::fs::write(&zip, b"x").expect("write");
    assert!(check_pack_file(&zip).is_err());
    assert!(check_pack_file(&t.path().join("missing.mrpack")).expect_err("missing").contains("could not be read"));
}

// ── Scope and no writes ──────────────────────────────────────────────────────

fn listing(dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).expect("read_dir") {
        let e = e.expect("entry");
        let m = e.metadata().expect("meta");
        out.push((e.path(), m.len()));
        if m.is_dir() {
            out.extend(listing(&e.path()));
        }
    }
    out.sort();
    out
}

#[test]
fn scanning_writes_nothing_and_needs_the_guard_rule() {
    let t = tmp();
    let pack = Pack::new()
        .index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[file_json("mods/a.jar")]))
        .file("overrides/mods/a.jar", &fabric_jar("a"))
        .write(t.path(), "p.mrpack");
    let before = listing(t.path());
    let bytes_before = std::fs::read(&pack).expect("read");
    let _ = scan(&pack);
    let _ = describe_pack(&pack);
    assert_eq!(listing(t.path()), before);
    assert_eq!(std::fs::read(&pack).expect("read"), bytes_before);

    let err = scan_pack(&PathGuard::new(), &pack, "pack", |_| {}, |_| {}).expect_err("unregistered");
    assert!(matches!(err, Error::OutsideScope { .. }));
}

// ── Download links (never dropped silently) ──────────────────────────────────

fn downloads_of(json_downloads: &str) -> (Vec<String>, Vec<ScanIssue>) {
    let file = format!(
        r#"{{"path":"mods/a.jar","hashes":{{"sha1":"{SHA1}","sha512":"{}"}},"downloads":{json_downloads}}}"#,
        sha512()
    );
    let (idx, issues) = index_issues(index_json(r#"{"minecraft":"1.20.1"}"#, &[file]).as_bytes());
    let mut files = idx.expect("index").files;
    assert_eq!(files.len(), 1);
    (files.remove(0).downloads, issues)
}

#[test]
fn an_overlong_url_becomes_a_sentinel_not_nothing() {
    // Before: a > 4 KiB URL was dropped, so a file whose only link pointed elsewhere had no
    // link at all and no W-MRPACK-DOWNLOAD.
    let long = format!("https://evil.example/{}", "a".repeat(5000));
    let (dl, issues) = downloads_of(&format!(r#"["{long}"]"#));
    assert_eq!(dl, vec![index::TOO_LONG]);
    assert!(issues.iter().any(|i| i.message.contains("longer than 4096 bytes")), "{issues:?}");
    // A long allowlisted-looking one is not kept either (no truncated "https://cdn.modrinth.com/…").
    let long_cdn = format!("https://cdn.modrinth.com/{}", "a".repeat(5000));
    let (dl, _) = downloads_of(&format!(r#"["https://cdn.modrinth.com/data/x/a.jar","{long_cdn}"]"#));
    assert_eq!(dl, vec!["https://cdn.modrinth.com/data/x/a.jar", index::TOO_LONG]);
    // Exactly 4096 bytes is kept verbatim.
    let edge = format!("https://cdn.modrinth.com/{}", "b".repeat(4096 - "https://cdn.modrinth.com/".len()));
    let (dl, issues) = downloads_of(&format!(r#"["{edge}"]"#));
    assert_eq!(dl, vec![edge]);
    assert!(issues.is_empty());
}

#[test]
fn non_string_links_become_sentinels() {
    // Before: `[{"url":"https://evil"}]` or `[42]` vanished, leaving an empty list.
    let (dl, issues) = downloads_of(r#"[{"url":"https://evil.example/a.jar"}, 42, null, "https://cdn.modrinth.com/x.jar"]"#);
    assert_eq!(dl, vec![index::NOT_A_STRING, index::NOT_A_STRING, index::NOT_A_STRING, "https://cdn.modrinth.com/x.jar"]);
    assert!(issues.iter().any(|i| i.message.contains("3 download link(s)") && i.message.contains("not text")), "{issues:?}");
    // `downloads` that is not a list at all.
    let (dl, issues) = downloads_of(r#""https://evil.example/a.jar""#);
    assert_eq!(dl, vec![index::NOT_A_LIST]);
    assert!(issues.iter().any(|i| i.message.contains("not a list")));
    let (dl, _) = downloads_of(r#"{"0":"https://evil.example/a.jar"}"#);
    assert_eq!(dl, vec![index::NOT_A_LIST]);
    // Absent or null: no links, no note.
    let (dl, issues) = downloads_of("null");
    assert!(dl.is_empty() && issues.is_empty());
}

#[test]
fn links_past_the_cap_end_in_a_sentinel() {
    // Before: 16 allowlisted links hid a 17th that pointed elsewhere.
    let mut urls: Vec<String> = (0..70).map(|i| format!("\"https://cdn.modrinth.com/{i}.jar\"")).collect();
    urls.push("\"https://evil.example/x.jar\"".into());
    let (dl, issues) = downloads_of(&format!("[{}]", urls.join(",")));
    assert_eq!(dl.len(), index::MAX_DOWNLOADS);
    assert_eq!(dl.last().map(String::as_str), Some(index::MORE_URLS));
    assert_eq!(dl[0], "https://cdn.modrinth.com/0.jar");
    assert!(issues.iter().any(|i| i.message.contains("71 download links")), "{issues:?}");
    // Up to the cap, everything is kept as-is.
    let urls: Vec<String> = (0..index::MAX_DOWNLOADS).map(|i| format!("\"https://cdn.modrinth.com/{i}.jar\"")).collect();
    let (dl, issues) = downloads_of(&format!("[{}]", urls.join(",")));
    assert_eq!(dl.len(), index::MAX_DOWNLOADS);
    assert!(!dl.iter().any(|u| u.starts_with("invalid:")));
    assert!(issues.is_empty());
}

#[test]
fn sentinels_are_not_urls() {
    for s in [index::TOO_LONG, index::NOT_A_STRING, index::MORE_URLS, index::NOT_A_LIST] {
        assert!(!s.contains("://"), "{s} must not parse as an absolute URL in src/core");
    }
}

#[test]
fn duplicate_index_paths_keep_the_last() {
    let second = file_json("mods/a.jar").replace(SHA1, "ffffffffffffffffffffffffffffffffffffffff");
    let files = [file_json("mods/a.jar"), file_json("mods/b.jar"), second, file_json("mods/B.jar")];
    let (idx, issues) = index_issues(index_json(r#"{"minecraft":"1.20.1"}"#, &files).as_bytes());
    let idx = idx.expect("index");
    let got: Vec<(&str, &str)> = idx.files.iter().map(|f| (f.path.as_str(), f.sha1.as_str())).collect();
    assert_eq!(
        got,
        vec![("mods/b.jar", SHA1), ("mods/a.jar", "ffffffffffffffffffffffffffffffffffffffff"), ("mods/B.jar", SHA1)],
        "the later mods/a.jar wins, in its own position"
    );
    assert!(issues.iter().any(|i| i.message.contains("files[0] and files[2]") && i.message.contains("only files[2]")), "{issues:?}");
    assert!(issues.iter().any(|i| i.message.contains("differ only in letter case")), "{issues:?}");
    assert_eq!(issues.len(), 2);
}

// ── Duplicate entries, header consistency, central-directory limits ─────────

/// Replace every occurrence of `from` by `to` (same length) in the raw zip bytes, or only the
/// first one (the local header, which precedes the central directory).
fn patch_name(mut bytes: Vec<u8>, from: &str, to: &str, all: bool) -> Vec<u8> {
    assert_eq!(from.len(), to.len());
    let (f, t) = (from.as_bytes(), to.as_bytes());
    let mut hits = 0;
    let mut i = 0;
    while i + f.len() <= bytes.len() {
        if &bytes[i..i + f.len()] == f {
            bytes[i..i + f.len()].copy_from_slice(t);
            hits += 1;
            if !all {
                break;
            }
            i += f.len();
        } else {
            i += 1;
        }
    }
    assert!(hits > 0, "{from} not found");
    bytes
}

fn write_bytes(dir: &Path, name: &str, bytes: Vec<u8>) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, bytes).expect("write");
    dunce::canonicalize(&p).expect("canon")
}

fn refused_as_duplicate(res: &ScanResult) {
    assert!(res.declared.is_empty() && res.jars.is_empty(), "nothing is read: {:?}", res.jars);
    assert!(has_issue(res, "tools disagree about which copy counts"), "{:?}", res.issues);
}

#[test]
fn duplicate_index_entry_refuses_the_pack() {
    let t = tmp();
    let a = index_json(r#"{"minecraft":"1.20.1","fabric-loader":"0.16.10"}"#, &[file_json("mods/a.jar")]);
    let b = index_json(r#"{"minecraft":"1.20.1","forge":"47.2.0"}"#, &[file_json("mods/evil.jar")]);
    let raw = Pack::new().stored(INDEX_NAME, a.as_bytes()).stored("modrinth.index.jsoX", b.as_bytes()).build();
    let pack = write_bytes(t.path(), "p.mrpack", patch_name(raw, "modrinth.index.jsoX", INDEX_NAME, true));
    let mut started = None;
    let res = scan_pack(&guard_for(&pack), &pack, "pack", |s| started = Some(s.len()), |_| {}).expect("scan");
    refused_as_duplicate(&res);
    assert_eq!(started, Some(0));
    assert_eq!(describe_pack(&pack).metadata_source, MetadataSource::Inferred, "no index is trusted");
}

#[test]
fn duplicate_jar_entry_refuses_the_pack() {
    let t = tmp();
    let raw = Pack::new()
        .index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[]))
        .stored("overrides/mods/a.jar", &fabric_jar("good"))
        .stored("overrides/mods/X.jar", &fabric_jar("evil"))
        .build();
    let pack = write_bytes(t.path(), "p.mrpack", patch_name(raw, "overrides/mods/X.jar", "overrides/mods/a.jar", true));
    refused_as_duplicate(&scan(&pack));
}

#[test]
fn case_insensitive_duplicate_refuses_the_pack_but_folders_may_differ() {
    let t = tmp();
    let pack = Pack::new()
        .index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[]))
        .stored("overrides/mods/Sodium.jar", &fabric_jar("good"))
        .stored("overrides/mods/sodium.jar", &fabric_jar("evil"))
        .write(t.path(), "p.mrpack");
    let res = scan(&pack);
    refused_as_duplicate(&res);
    assert!(has_issue(&res, "same file on Windows"));

    let mut ok = Pack::new().index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[]));
    ok.zip.add_directory("overrides/Config/", SimpleFileOptions::default()).expect("dir");
    ok.zip.add_directory("overrides/config/", SimpleFileOptions::default()).expect("dir");
    let res = scan(&ok.stored("overrides/mods/a.jar", &fabric_jar("a")).write(t.path(), "ok.mrpack"));
    assert_eq!(res.jars.len(), 1, "two folder entries differing in case are harmless: {:?}", res.issues);
}

#[test]
fn local_header_name_mismatch_skips_that_entry() {
    let t = tmp();
    let raw = Pack::new()
        .index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[]))
        .stored("overrides/mods/aaa.jar", &fabric_jar("hidden"))
        .stored("overrides/mods/bbb.jar", &fabric_jar("fine"))
        .build();
    // Only the local header says `zzz.jar`; the central directory still says `aaa.jar`.
    let pack = write_bytes(t.path(), "p.mrpack", patch_name(raw, "overrides/mods/aaa.jar", "overrides/mods/zzz.jar", false));
    let res = scan(&pack);
    assert_eq!(res.jars.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(), vec!["overrides/mods/bbb.jar"]);
    let hits = issue_for(&res, "overrides/mods/aaa.jar");
    assert_eq!(hits.len(), 1, "{:?}", res.issues);
    assert!(hits[0].message.contains("local header does not match"), "{}", hits[0].message);

    // The index too: its entry is skipped, so the pack has no usable index.
    let raw = Pack::new().stored(INDEX_NAME, index_json(r#"{"minecraft":"1.20.1"}"#, &[]).as_bytes()).build();
    let pack = write_bytes(t.path(), "q.mrpack", patch_name(raw, INDEX_NAME, "modrinth.index.jsoX", false));
    let res = scan(&pack);
    assert!(issue_for(&res, INDEX_NAME).iter().any(|i| i.message.contains("local header does not match")), "{:?}", res.issues);
    assert_eq!(describe_pack(&pack).metadata_source, MetadataSource::Inferred);
}

/// A valid small zip with its (comment-less) EOCD patched by `f`.
fn patched_eocd(f: impl FnOnce(&mut [u8])) -> Vec<u8> {
    let mut bytes = Pack::new().index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[])).build();
    let at = bytes.len() - 22;
    assert_eq!(bytes[at..at + 4], [0x50, 0x4b, 0x05, 0x06]);
    f(&mut bytes[at..]);
    bytes
}

#[test]
fn oversized_central_directory_is_refused_before_parsing() {
    let t = tmp();
    // Entry count (both fields) far over the limit.
    let many = patched_eocd(|e| {
        e[8..10].copy_from_slice(&30_000u16.to_le_bytes());
        e[10..12].copy_from_slice(&30_000u16.to_le_bytes());
    });
    let res = scan(&write_bytes(t.path(), "many.mrpack", many.clone()));
    assert!(has_issue(&res, "30000 entries, more than the 20000"), "{:?}", res.issues);
    assert!(archive::check_central_directory(&mut Cursor::new(many)).is_err());
    // Central directory size over 20 000 × 600 bytes.
    let big = patched_eocd(|e| e[12..16].copy_from_slice(&(MAX_CD_BYTES as u32 + 1).to_le_bytes()));
    let err = archive::check_central_directory(&mut Cursor::new(big)).expect_err("cd size");
    assert!(err.contains("table of contents"), "{err}");
    // A normal pack passes.
    assert!(archive::check_central_directory(&mut Cursor::new(patched_eocd(|_| {}))).is_ok());
}

/// A ZIP64 tail (record + locator + EOCD with the ZIP64 markers) announcing `entries` and
/// `cd_size`; `gap` bytes of padding sit between the record the locator points at and the
/// locator.
fn zip64_tail(entries: u64, cd_size: u64, gap: usize) -> Vec<u8> {
    let mut bytes = Pack::new().index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[])).build();
    let eocd_at = bytes.len() - 22;
    let cd_offset = u64::from(u32::from_le_bytes(bytes[eocd_at + 16..eocd_at + 20].try_into().expect("4")));
    bytes.truncate(eocd_at);
    let rec_at = bytes.len() as u64;
    bytes.extend([0x50, 0x4b, 0x06, 0x06]);
    bytes.extend(44u64.to_le_bytes());
    bytes.extend(45u16.to_le_bytes());
    bytes.extend(45u16.to_le_bytes());
    bytes.extend(0u32.to_le_bytes());
    bytes.extend(0u32.to_le_bytes());
    bytes.extend(entries.to_le_bytes());
    bytes.extend(entries.to_le_bytes());
    bytes.extend(cd_size.to_le_bytes());
    bytes.extend(cd_offset.to_le_bytes());
    bytes.extend(std::iter::repeat_n(0u8, gap));
    bytes.extend([0x50, 0x4b, 0x06, 0x07]);
    bytes.extend(0u32.to_le_bytes());
    bytes.extend(rec_at.to_le_bytes());
    bytes.extend(1u32.to_le_bytes());
    bytes.extend([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0]);
    bytes
}

#[test]
fn zip64_end_records_are_checked_too() {
    let err = archive::check_central_directory(&mut Cursor::new(zip64_tail(5_000_000, 100, 0))).expect_err("count");
    assert!(err.contains("5000000 entries"), "{err}");
    let err = archive::check_central_directory(&mut Cursor::new(zip64_tail(1, 1 << 40, 0))).expect_err("size");
    assert!(err.contains("table of contents"), "{err}");
    let err = archive::check_central_directory(&mut Cursor::new(zip64_tail(1, 100, 2 * MIB as usize))).expect_err("gap");
    assert!(err.contains("ZIP64"), "{err}");
    // Plausible values pass the hand check (the zip library judges the rest).
    assert!(archive::check_central_directory(&mut Cursor::new(zip64_tail(1, 100, 0))).is_ok());
}

// ── Only mods/ jars are scanned ──────────────────────────────────────────────

#[test]
fn only_jars_directly_in_override_mods_are_scanned() {
    let t = tmp();
    let pack = Pack::new()
        .index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[]))
        .file("overrides/mods/a.jar", &fabric_jar("a"))
        .file("client-overrides/mods/b.JAR", &fabric_jar("b"))
        .file("server-overrides/mods/c.jar", &fabric_jar("c"))
        .file("overrides/mods/sub/nested.jar", &fabric_jar("nested"))
        .file("overrides/config/lib.jar", &fabric_jar("lib"))
        .file("client-overrides/loose.jar", &fabric_jar("loose"))
        .file("overrides/resourcepacks/x.zip", b"zip")
        .file("mods/outside.jar", &fabric_jar("outside"))
        .write(t.path(), "p.mrpack");
    let res = scan(&pack);
    let ids: Vec<&str> = res.jars.iter().filter(|j| j.depth == 0).map(|j| j.id.as_str()).collect();
    assert_eq!(ids, vec!["client-overrides/mods/b.JAR", "overrides/mods/a.jar", "server-overrides/mods/c.jar"]);
    for ignored in ["overrides/mods/sub/nested.jar", "overrides/config/lib.jar", "client-overrides/loose.jar"] {
        let hits = issue_for(&res, ignored);
        assert_eq!(hits.len(), 1, "{ignored}: {:?}", res.issues);
        assert!(hits[0].message.contains("not directly in a mods/ folder, so loaders ignore it"), "{}", hits[0].message);
    }
    assert_eq!(res.issues.len(), 3, "nothing about non-jars or jars outside the override folders: {:?}", res.issues);
    assert_eq!(describe_pack(&pack).mod_count, 3);
}

// ── Names, streams, resolved names ───────────────────────────────────────────

#[test]
fn display_names_drop_bidi_and_invisible_characters() {
    let t = tmp();
    let json = r#"{"formatVersion":1,"game":"minecraft","name":"\u202ekcap\u202c Good\u200b\u2066Pack\u2069\ufeff\u200f\u0007","files":[],"dependencies":{"minecraft":"1.20.1\u200e"}}"#;
    let pack = Pack::new().index(json).write(t.path(), "p.mrpack");
    let inst = describe_pack(&pack);
    assert_eq!(inst.name, "kcap GoodPack");
    assert_eq!(inst.mc_version, None, "a version with a format character is not trusted");
    // Only invisible characters: the file name is used instead.
    let json = r#"{"formatVersion":1,"game":"minecraft","name":"\u200b\u202e","files":[],"dependencies":{}}"#;
    let pack = Pack::new().index(json).write(t.path(), "Fallback.mrpack");
    assert_eq!(describe_pack(&pack).name, "Fallback");
    // Paths in issue subjects show them as `?`.
    assert_eq!(display_name("mods/\u{202E}raj.exe"), "mods/?raj.exe");
    assert_eq!(strip_hidden("a\u{00AD}b\u{E0041}c\u{2066}"), "abc");
}

#[test]
fn stream_names_are_never_packs() {
    assert!(check_pack_meta("notes.txt:hidden.mrpack", false, true, 1).expect_err("ads").contains("\":\""));
    assert!(has_stream_colon(Path::new("dir/notes.txt:x.mrpack")));
    assert!(!has_stream_colon(Path::new("dir/pack.mrpack")));
    #[cfg(windows)]
    {
        assert!(!has_stream_colon(Path::new(r"C:\Users\me\pack.mrpack")));
        assert!(!has_stream_colon(Path::new(r"\\?\C:\Users\me\pack.mrpack")));
        assert!(has_stream_colon(Path::new(r"C:\Users\me\notes.txt:x.mrpack")));
        assert!(has_stream_colon(Path::new(r"\\?\C:\Users\me\notes.txt:x.mrpack")));
    }
    let t = tmp();
    assert!(check_pack_file(&t.path().join("notes.txt:x.mrpack")).expect_err("ads").contains("\":\""));
}

#[test]
fn scan_rechecks_the_resolved_name() {
    // A registered file that is (no longer) named *.mrpack is not scanned.
    let t = tmp();
    let bytes =
        Pack::new().index(&index_json(r#"{"minecraft":"1.20.1"}"#, &[])).file("overrides/mods/a.jar", &fabric_jar("a")).build();
    let renamed = write_bytes(t.path(), "pack.zip", bytes);
    let res = scan(&renamed);
    assert!(res.jars.is_empty() && res.declared.is_empty());
    assert!(has_issue(&res, "The pack was not scanned: only Modrinth modpacks"), "{:?}", res.issues);
}
