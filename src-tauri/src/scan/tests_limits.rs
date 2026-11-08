//! Tests for scoping (PathGuard / links), zip-bomb limits, and module names.

use std::path::Path;

use super::jar::{scan_into, Budget, JarCtx, Limits, DEFAULT_LIMITS};
use super::tests::guard_for;
use super::*;
use crate::test_support::JarBuilder;

fn ctx() -> JarCtx {
    JarCtx {
        id: "mods/a.jar".into(),
        path: "mods/a.jar".into(),
        file_name: "a.jar".into(),
        depth: 0,
        parent_id: None,
        disabled: false,
        mtime_ms: 0,
    }
}

fn run(bytes: &[u8], limits: Limits) -> (Vec<JarRecord>, Vec<ScanIssue>) {
    let (mut out, mut issues) = (Vec::new(), Vec::new());
    scan_into(&ctx(), bytes, &mut Budget::new(limits), &mut out, &mut issues);
    (out, issues)
}

/// Incompressible bytes, so deflated size ≈ inflated size.
fn noise(n: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

fn small_jar(id: &str, blob: usize) -> JarBuilder {
    JarBuilder::new().fabric_mod_json(&format!(r#"{{"id":"{id}","version":"1"}}"#)).file("blob.bin", noise(blob, blob as u64 + 7))
}

// ----- PathGuard / links --------------------------------------------------------------------

/// Directory link that needs no privilege: junction on Windows, symlink elsewhere.
fn link_dir(target: &Path, link: &Path) {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().expect("mklink");
        assert!(out.status.success(), "mklink /J failed: {out:?}");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).expect("symlink");
}

/// File symlink; false where the OS refuses (Windows without Developer Mode).
fn link_file(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

struct Layout {
    _tmp: tempfile::TempDir,
    inst: std::path::PathBuf,
    outside: std::path::PathBuf,
}

fn layout() -> Layout {
    let tmp = tempfile::tempdir().expect("tempdir");
    let inst = tmp.path().join("inst");
    let outside = tmp.path().join("outside");
    small_jar("outside", 10).write_to(&outside, "x.jar");
    small_jar("inside", 10).write_to(&inst.join("storage"), "y.jar");
    std::fs::create_dir_all(inst.join("mods")).expect("mkdir");
    Layout { _tmp: tmp, inst, outside }
}

#[test]
fn junction_outside_root_is_unreadable_and_not_read() {
    let l = layout();
    link_dir(&l.outside, &l.inst.join("mods").join("ext"));
    link_dir(&l.inst.join("storage"), &l.inst.join("mods").join("int"));
    let guard = guard_for(&l.inst);
    let paths = vec!["mods/ext/x.jar".to_string(), "mods/int/y.jar".to_string()];
    let res = scan_paths(&l.inst, &paths, "i", &guard, |_| {}, |_| {}).expect("scan");
    let ext = res.jars.iter().find(|r| r.id == "mods/ext/x.jar").expect("ext");
    match &ext.status {
        JarStatus::Unreadable { reason } => {
            assert!(reason.contains("outside the folders"), "{reason}");
            assert!(reason.contains("mods/ext/x.jar") && !reason.contains("outside\\") , "relative path only: {reason}");
        }
        s => panic!("expected unreadable, got {s:?}"),
    }
    assert!(ext.sha1.is_empty() && ext.mods.is_empty(), "outside file must not be read");
    assert!(res.issues.iter().any(|i| i.subject == "mods/ext/x.jar"));
    let int = res.jars.iter().find(|r| r.id == "mods/int/y.jar").expect("int");
    assert_eq!(int.status, JarStatus::Ok);
    assert_eq!(int.mods[0].mod_id, "inside");
}

#[test]
fn linked_mods_dir_outside_root_needs_its_target_registered() {
    let l = layout();
    std::fs::remove_dir(l.inst.join("mods")).expect("rmdir");
    link_dir(&l.outside, &l.inst.join("mods"));
    let guard = guard_for(&l.inst);
    let err = scan_mods_dir(&l.inst, "i", &guard, |_| {}, |_| {}).expect_err("outside scope");
    assert!(matches!(err, Error::OutsideScope { .. }), "{err:?}");
    // Discovery registers the canonical target of a linked mods/ as a root.
    guard.add_root(&l.outside).expect("add target");
    let res = scan_mods_dir(&l.inst, "i", &guard, |_| {}, |_| {}).expect("scan");
    assert_eq!(res.jars.len(), 1);
    assert_eq!(res.jars[0].status, JarStatus::Ok);
}

#[test]
fn file_symlinks_respect_scope() {
    let l = layout();
    let mods = l.inst.join("mods");
    if !link_file(&l.outside.join("x.jar"), &mods.join("evil.jar")) {
        eprintln!("file symlinks unavailable here (Windows without Developer Mode); skipped");
        return;
    }
    assert!(link_file(&l.inst.join("storage").join("y.jar"), &mods.join("good.jar")));
    let res = scan_mods_dir(&l.inst, "i", &guard_for(&l.inst), |_| {}, |_| {}).expect("scan");
    let evil = res.jars.iter().find(|r| r.id == "mods/evil.jar").expect("evil");
    assert!(matches!(&evil.status, JarStatus::Unreadable { reason } if reason.contains("outside the folders")), "{:?}", evil.status);
    assert!(evil.sha1.is_empty());
    let good = res.jars.iter().find(|r| r.id == "mods/good.jar").expect("good");
    assert_eq!(good.status, JarStatus::Ok);
}

#[test]
fn folder_named_like_jar_is_corrupt_in_scan_paths() {
    let l = layout();
    std::fs::create_dir_all(l.inst.join("mods").join("dir.jar")).expect("mkdir");
    let res = scan_paths(&l.inst, &["mods/dir.jar".to_string()], "i", &guard_for(&l.inst), |_| {}, |_| {}).expect("scan");
    match &res.jars[0].status {
        JarStatus::Corrupt { reason } => assert!(reason.contains("folder"), "{reason}"),
        s => panic!("expected corrupt, got {s:?}"),
    }
    // scan_mods_dir does not list it at all.
    let res = scan_mods_dir(&l.inst, "i", &guard_for(&l.inst), |_| {}, |_| {}).expect("scan");
    assert!(res.jars.is_empty());
}

#[test]
fn lexical_join_accepts_legal_names_and_refuses_escapes() {
    let root = Path::new("root");
    for ok in ["mods/a?b.jar", "mods/a*b|c\"<d>.jar", "mods/aux.jar", "mods/x.jar.", "./mods/a.jar"] {
        assert!(lexical_join(root, ok).is_some(), "{ok} refused");
    }
    for bad in ["", "../a.jar", "mods/../../a.jar", "/etc/passwd", "\\\\server\\share\\a.jar"] {
        assert!(lexical_join(root, bad).is_none(), "{bad} accepted");
    }
    #[cfg(windows)]
    assert!(lexical_join(root, "C:/x.jar").is_none());
    #[cfg(unix)]
    assert!(lexical_join(root, "mods/we:ird.jar").is_some());
}

#[cfg(unix)]
#[test]
fn unix_names_with_reserved_characters_scan() {
    let l = layout();
    small_jar("weird", 10).write_to(&l.inst.join("mods"), "we:ird?*.jar");
    let res = scan_mods_dir(&l.inst, "i", &guard_for(&l.inst), |_| {}, |_| {}).expect("scan");
    assert_eq!(res.jars.len(), 1);
    assert_eq!(res.jars[0].status, JarStatus::Ok, "{:?}", res.jars[0].status);
}

// ----- zip-bomb limits ----------------------------------------------------------------------

const SMALL: Limits = Limits {
    metadata_cap: 4_000,
    nested_cap: 20_000,
    inflated_budget: 100_000,
    max_nested_records: 8,
    class_cap: 2_000,
    class_budget: 10_000,
    max_class_reads: 50,
    max_mod_annotations: 2,
};

#[test]
fn default_limits_match_the_documented_values() {
    assert_eq!(DEFAULT_LIMITS.metadata_cap, 8 * 1024 * 1024);
    assert_eq!(DEFAULT_LIMITS.nested_cap, 64 * 1024 * 1024);
    assert_eq!(DEFAULT_LIMITS.inflated_budget, 256 * 1024 * 1024);
    assert_eq!(DEFAULT_LIMITS.max_nested_records, 512);
    assert_eq!(DEFAULT_LIMITS.class_cap, 512 * 1024);
    assert_eq!(DEFAULT_LIMITS.class_budget, 64 * 1024 * 1024);
    assert_eq!(DEFAULT_LIMITS.max_class_reads, 65_536);
    assert_eq!(DEFAULT_LIMITS.max_mod_annotations, 64);
}

#[test]
fn metadata_cap_default() {
    let pad = " ".repeat(8 * 1024 * 1024);
    let bytes = JarBuilder::new().fabric_mod_json(&format!(r#"{{"id":"big","version":"1"}}{pad}"#)).class("a/A.class", 61).build();
    let (out, issues) = run(&bytes, DEFAULT_LIMITS);
    match &out[0].status {
        JarStatus::Corrupt { reason } => assert!(reason.contains("fabric.mod.json") && reason.contains("8 MiB"), "{reason}"),
        s => panic!("expected corrupt, got {s:?}"),
    }
    assert_eq!(out[0].packages, vec!["a"]);
    assert_eq!(issues.len(), 1);
    // Just under the cap is fine.
    let pad = " ".repeat(8 * 1024 * 1024 - 64);
    let bytes = JarBuilder::new().fabric_mod_json(&format!(r#"{{"id":"big","version":"1"}}{pad}"#)).build();
    assert_eq!(run(&bytes, DEFAULT_LIMITS).0[0].status, JarStatus::Ok);
}

#[test]
fn oversized_metadata_entry_is_refused() {
    let json = format!(r#"{{"id":"x","version":"1","description":"{}"}}"#, "y".repeat(5_000));
    let (out, _) = run(&JarBuilder::new().fabric_mod_json(&json).build(), SMALL);
    assert!(matches!(&out[0].status, JarStatus::Corrupt { reason } if reason.contains("4000 bytes")), "{:?}", out[0].status);
}

#[test]
fn nested_cap_skips_only_the_big_jar() {
    let bytes = JarBuilder::new()
        .fabric_mod_json(r#"{"id":"p","version":"1","jars":[{"file":"big.jar"},{"file":"ok.jar"}]}"#)
        .nested("big.jar", small_jar("big", 30_000))
        .nested("ok.jar", small_jar("ok", 1_000))
        .build();
    let (out, issues) = run(&bytes, SMALL);
    assert_eq!(out[0].status, JarStatus::Ok, "parent record kept");
    assert_eq!(out[0].nested, vec!["mods/a.jar!/ok.jar"]);
    assert_eq!(out.len(), 2);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].subject, "mods/a.jar!/big.jar");
    assert!(issues[0].message.contains("20000 bytes"), "{}", issues[0].message);
}

#[test]
fn repeated_declarations_produce_one_record() {
    let inner = small_jar("inner", 100);
    let jars: Vec<String> = (0..1000).map(|_| r#"{"file":"META-INF/jars/inner.jar"}"#.to_string()).collect();
    let fabric = format!(r#"{{"id":"p","version":"1","jars":[{}]}}"#, jars.join(","));
    let jj_entry = r#"{"identifier":{"group":"g","artifact":"inner"},"version":{"range":"[1,)","artifactVersion":"1"},"path":"META-INF/jars/inner.jar"}"#;
    let jarjar = format!(r#"{{"jars":[{}]}}"#, vec![jj_entry; 50].join(","));
    let bytes = JarBuilder::new()
        .fabric_mod_json(&fabric)
        .file("META-INF/jarjar/metadata.json", jarjar)
        .nested("META-INF/jars/inner.jar", inner)
        .build();
    let (out, issues) = run(&bytes, DEFAULT_LIMITS);
    assert_eq!(out.len(), 2, "one parent + one nested record");
    assert_eq!(out[0].nested.len(), 1);
    assert!(out[1].jarjar.is_some(), "jarjar info kept");
    assert!(issues.is_empty(), "{issues:?}");
}

#[test]
fn nested_record_limit() {
    let mut b = JarBuilder::new();
    let files: Vec<String> = (0..12).map(|i| format!(r#"{{"file":"n{i}.jar"}}"#)).collect();
    b = b.fabric_mod_json(&format!(r#"{{"id":"p","version":"1","jars":[{}]}}"#, files.join(",")));
    for i in 0..12 {
        b = b.nested(&format!("n{i}.jar"), small_jar(&format!("n{i}"), 10));
    }
    let (out, issues) = run(&b.build(), SMALL);
    assert_eq!(out.len(), 1 + SMALL.max_nested_records as usize);
    assert_eq!(out[0].nested.len(), SMALL.max_nested_records as usize);
    assert_eq!(issues.len(), 1, "{issues:?}");
    assert!(issues[0].message.contains("more than 8 nested jars"), "{}", issues[0].message);
}

#[test]
fn nested_record_limit_spans_levels() {
    // 3 children, each with 3 grandchildren = 12 nested records; limit 8.
    let mut outer = JarBuilder::new()
        .fabric_mod_json(r#"{"id":"p","version":"1","jars":[{"file":"c0.jar"},{"file":"c1.jar"},{"file":"c2.jar"}]}"#);
    for c in 0..3 {
        let mut child = JarBuilder::new()
            .fabric_mod_json(&format!(r#"{{"id":"c{c}","version":"1","jars":[{{"file":"g0.jar"}},{{"file":"g1.jar"}},{{"file":"g2.jar"}}]}}"#));
        for g in 0..3 {
            child = child.nested(&format!("g{g}.jar"), small_jar(&format!("g{c}{g}"), 10));
        }
        outer = outer.nested(&format!("c{c}.jar"), child);
    }
    let (out, issues) = run(&outer.build(), SMALL);
    assert_eq!(out.len(), 1 + 8);
    assert_eq!(issues.len(), 1, "{issues:?}");
}

#[test]
fn total_inflated_budget_stops_descent() {
    let files: Vec<String> = (0..6).map(|i| format!(r#"{{"file":"n{i}.jar"}}"#)).collect();
    let mut b = JarBuilder::new().fabric_mod_json(&format!(r#"{{"id":"p","version":"1","jars":[{}]}}"#, files.join(",")));
    for i in 0..6 {
        // ~18 KB each (under the 20 KB nested cap); budget 100 KB fits five at most.
        b = b.nested(&format!("n{i}.jar"), small_jar(&format!("n{i}"), 18_000));
    }
    let limits = Limits { max_nested_records: 100, ..SMALL };
    let (out, issues) = run(&b.build(), limits);
    assert_eq!(out[0].status, JarStatus::Ok, "parent record kept");
    let scanned = out.len() - 1;
    assert!((1..6).contains(&scanned), "scanned {scanned}");
    assert_eq!(out[0].nested.len(), scanned);
    assert_eq!(issues.len(), 1, "{issues:?}");
    assert_eq!(issues[0].subject, "mods/a.jar");
    assert!(issues[0].message.contains("unpack to more than 100000 bytes"), "{}", issues[0].message);
}

// ----- module names -------------------------------------------------------------------------

#[test]
fn module_name_from_module_info() {
    let mi = super::module_info::build_module_info("com.example.mymod");
    let r = &run(
        &JarBuilder::new()
            .file("module-info.class", &mi)
            .file("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\nAutomatic-Module-Name: not.this\r\n\r\n")
            .class("com/example/A.class", 61)
            .build(),
        DEFAULT_LIMITS,
    )
    .0[0];
    assert_eq!(r.module_name.as_deref(), Some("com.example.mymod"));
    assert_eq!(r.packages, vec!["com.example"]);

    let mi = super::module_info::build_module_info("org.versioned");
    let r = &run(&JarBuilder::new().file("META-INF/versions/9/module-info.class", &mi).build(), DEFAULT_LIMITS).0[0];
    assert_eq!(r.module_name.as_deref(), Some("org.versioned"));
}

#[test]
fn module_name_from_manifest_or_none() {
    let r = &run(
        &JarBuilder::new().file("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\nAutomatic-Module-Name: org.auto.name\n").build(),
        DEFAULT_LIMITS,
    )
    .0[0];
    assert_eq!(r.module_name.as_deref(), Some("org.auto.name"));
    // A broken module-info falls back to the manifest.
    let r = &run(
        &JarBuilder::new()
            .file("module-info.class", b"\xCA\xFE\xBA\xBEjunk")
            .file("META-INF/MANIFEST.MF", "Automatic-Module-Name: fallback.name\n")
            .build(),
        DEFAULT_LIMITS,
    )
    .0[0];
    assert_eq!(r.module_name.as_deref(), Some("fallback.name"));
    let r = &run(&JarBuilder::new().class("a/A.class", 61).build(), DEFAULT_LIMITS).0[0];
    assert_eq!(r.module_name, None);
}
