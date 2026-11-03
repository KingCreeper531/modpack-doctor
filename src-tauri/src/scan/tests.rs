//! Scanner tests. Fixture jars are built in-test with `JarBuilder`.

use std::sync::Mutex;

use sha1::{Digest, Sha1};
use sha2::Sha512;

use super::*;
use crate::model::{DependencyKind, JarJarInfo, LoaderKind, ModEnvironment, ModMeta, RangeSyntax, RawRange};
use crate::test_support::JarBuilder;

/// A guard whose only root is `root`.
pub(super) fn guard_for(root: &std::path::Path) -> PathGuard {
    let g = PathGuard::new();
    g.add_root(root).expect("add root");
    g
}

fn scan(b: JarBuilder) -> Vec<JarRecord> {
    scan_jar_bytes("mods/a.jar", "mods/a.jar", "a.jar", &b.build(), 0, None)
}

fn top(b: JarBuilder) -> JarRecord {
    let recs = scan(b);
    recs.into_iter().find(|r| r.id == "mods/a.jar").expect("top-level record")
}

fn maven(s: &str) -> RawRange {
    RawRange { syntax: RangeSyntax::Maven, raw: vec![s.to_string()], unrepresentable: None }
}

fn fabric(xs: &[&str]) -> RawRange {
    RawRange { syntax: RangeSyntax::Fabric, raw: xs.iter().map(|s| s.to_string()).collect(), unrepresentable: None }
}

fn dep<'a>(m: &'a ModMeta, id: &str) -> &'a crate::model::Dependency {
    m.deps.iter().find(|d| d.mod_id == id).unwrap_or_else(|| panic!("no dep {id}"))
}

const FORGE_TOML: &str = r#"
modLoader="javafml"
loaderVersion="[47,)"
license="MIT"
[[mods]]
modId="examplemod"
version="1.2.3"
displayName="Example Mod"
[[dependencies.examplemod]]
    modId="forge"
    mandatory=true
    versionRange="[47.1,)"
    ordering="NONE"
    side="BOTH"
[[dependencies.examplemod]]
    modId="minecraft"
    mandatory=true
    versionRange="[1.20.1,1.21)"
    side="BOTH"
[[dependencies.examplemod]]
    modId="jei"
    mandatory=false
    versionRange="[15,)"
    side="CLIENT"
"#;

#[test]
fn forge_mods_toml_with_forge_dep() {
    let r = top(JarBuilder::new().mods_toml(FORGE_TOML).class("com/example/Mod.class", 61));
    assert_eq!(r.status, JarStatus::Ok);
    assert_eq!(r.loaders, vec![LoaderKind::Forge]);
    let m = &r.mods[0];
    assert_eq!(m.mod_id, "examplemod");
    assert_eq!(m.version, "1.2.3");
    assert_eq!(m.name.as_deref(), Some("Example Mod"));
    assert_eq!(m.loader, LoaderKind::Forge);
    assert_eq!(m.language_loader.as_deref(), Some("javafml"));
    assert_eq!(m.language_range, Some(maven("[47,)")));
    assert_eq!(m.loader_range, Some(maven("[47.1,)")));
    assert_eq!(m.mc_range, Some(maven("[1.20.1,1.21)")));
    assert_eq!(dep(m, "forge").kind, DependencyKind::Required);
    assert_eq!(dep(m, "jei").kind, DependencyKind::Optional);
    assert_eq!(dep(m, "jei").side.as_deref(), Some("CLIENT"));
    assert_eq!(m.environment, ModEnvironment::Unknown);
    assert_eq!(m.metadata_file, "META-INF/mods.toml");
    assert_eq!(m.metadata_excerpt, FORGE_TOML);
}

#[test]
fn neoforge_1_20_4_mods_toml_classified_by_dependency() {
    let toml = r#"
modLoader="javafml"
loaderVersion="[2,)"
[[mods]]
modId="neomod"
version="1.0"
[[dependencies.neomod]]
modId="neoforge"
type="required"
versionRange="[20.4,)"
[[dependencies.neomod]]
modId="minecraft"
type="required"
versionRange="[1.20.4]"
"#;
    let r = top(JarBuilder::new().mods_toml(toml));
    assert_eq!(r.loaders, vec![LoaderKind::Neoforge]);
    let m = &r.mods[0];
    assert_eq!(m.loader, LoaderKind::Neoforge);
    assert_eq!(m.loader_range, Some(maven("[20.4,)")));
    assert_eq!(m.language_range, Some(maven("[2,)")));
    assert!(m.deps.iter().any(|d| d.mod_id == "neoforge"), "loader dep also kept in deps");
}

#[test]
fn mods_toml_without_loader_dep_is_forge() {
    let toml = "modLoader=\"javafml\"\nloaderVersion=\"[1,)\"\n[[mods]]\nmodId=\"plain\"\n";
    let r = top(JarBuilder::new().mods_toml(toml));
    assert_eq!(r.loaders, vec![LoaderKind::Forge]);
    assert_eq!(r.mods[0].loader_range, None);
    assert_eq!(r.mods[0].version, "1", "Forge default version");
}

#[test]
fn mods_toml_entries_classified_per_mod() {
    let toml = r#"
modLoader="javafml"
loaderVersion="[1,)"
[[mods]]
modId="a"
[[mods]]
modId="b"
[[dependencies.b]]
modId="neoforge"
mandatory=true
versionRange="[20.2,)"
"#;
    let r = top(JarBuilder::new().mods_toml(toml));
    assert_eq!(r.mods.len(), 2);
    assert_eq!(r.mods[0].loader, LoaderKind::Forge);
    assert_eq!(r.mods[1].loader, LoaderKind::Neoforge);
    assert_eq!(r.loaders, vec![LoaderKind::Forge, LoaderKind::Neoforge]);
}

#[test]
fn neoforge_mods_toml_1_20_5_types_and_mixins() {
    let toml = r#"
modLoader="javafml"
loaderVersion="[4,)"
[[mods]]
modId="newmod"
version="${file.jarVersion}"
displayName="New Mod"
[[mixins]]
config="newmod.mixins.json"
[[dependencies.newmod]]
modId="neoforge"
type="required"
versionRange="[21.0,)"
side="BOTH"
[[dependencies.newmod]]
modId="sodium"
type="incompatible"
versionRange="*"
[[dependencies.newmod]]
modId="optifine"
type="discouraged"
[[dependencies.newmod]]
modId="jei"
type="optional"
"#;
    let r = top(
        JarBuilder::new()
            .neoforge_mods_toml(toml)
            .file("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\nImplementation-Version: 3.4.5\r\nMixinConfigs: other.mixins.json\r\n\r\n"),
    );
    assert_eq!(r.status, JarStatus::Ok);
    let m = &r.mods[0];
    assert_eq!(m.loader, LoaderKind::Neoforge);
    assert_eq!(m.version, "3.4.5", "${{file.jarVersion}} resolved from the manifest");
    assert_eq!(m.metadata_file, "META-INF/neoforge.mods.toml");
    assert_eq!(dep(m, "neoforge").kind, DependencyKind::Required);
    assert_eq!(dep(m, "sodium").kind, DependencyKind::Incompatible);
    assert_eq!(dep(m, "optifine").kind, DependencyKind::Conflicts);
    assert_eq!(dep(m, "optifine").range.raw, Vec::<String>::new());
    assert_eq!(dep(m, "jei").kind, DependencyKind::Optional);
    assert_eq!(m.loader_range, Some(maven("[21.0,)")));
    assert_eq!(r.mixin_configs, vec!["newmod.mixins.json", "other.mixins.json"]);
}

#[test]
fn jar_version_placeholder_kept_without_manifest() {
    let r = top(JarBuilder::new().mods_toml("[[mods]]\nmodId=\"x\"\nversion=\"${file.jarVersion}\"\n"));
    assert_eq!(r.mods[0].version, "${file.jarVersion}");
}

#[test]
fn fabric_json5_lenient() {
    let json = r#"{
  // comment
  "schemaVersion": 1,
  "id": "fab",
  "version": "0.5.8",
  "name": "Fab",
  "environment": "client",
  "provides": ["fabby"],
  "depends": {
    "fabricloader": ">=0.15",
    "minecraft": ["~1.20.1", "1.20.2"],
    "fabric-api": "*",
  },
  "recommends": { "modmenu": "*" },
  "suggests": { "rei": "*" },
  "breaks": { "optifabric": "<1.0" },
  "conflicts": { "iris": "*" },
  /* block comment */
  "mixins": ["fab.mixins.json", { "config": "fab.client.mixins.json", "environment": "client" }],
  "jars": [ { "file": "META-INF/jars/lib.jar" } ],
}"#;
    let inner = JarBuilder::new().fabric_mod_json(r#"{"id":"lib","version":"1.0"}"#);
    let recs = scan(JarBuilder::new().fabric_mod_json(json).nested("META-INF/jars/lib.jar", inner));
    let r = &recs[0];
    assert_eq!(r.status, JarStatus::Ok, "{:?}", r.status);
    let m = &r.mods[0];
    assert_eq!((m.mod_id.as_str(), m.version.as_str(), m.name.as_deref()), ("fab", "0.5.8", Some("Fab")));
    assert_eq!(m.loader, LoaderKind::Fabric);
    assert_eq!(m.environment, ModEnvironment::Client);
    assert_eq!(m.provides, vec!["fabby"]);
    assert_eq!(m.loader_range, Some(fabric(&[">=0.15"])));
    assert_eq!(m.mc_range, Some(fabric(&["~1.20.1", "1.20.2"])));
    assert_eq!(dep(m, "modmenu").kind, DependencyKind::Recommended);
    assert_eq!(dep(m, "rei").kind, DependencyKind::Optional);
    assert_eq!(dep(m, "optifabric").kind, DependencyKind::Breaks);
    assert_eq!(dep(m, "iris").kind, DependencyKind::Conflicts);
    assert_eq!(r.mixin_configs, vec!["fab.client.mixins.json", "fab.mixins.json"]);
    assert_eq!(r.nested, vec!["mods/a.jar!/META-INF/jars/lib.jar"]);
    assert_eq!(recs.len(), 2);
    assert_eq!(recs[1].mods[0].mod_id, "lib");
    assert_eq!(recs[1].jarjar, None);
    assert_eq!(recs[1].mods[0].environment, ModEnvironment::Both, "Fabric default environment is *");
}

#[test]
fn fabric_raw_newline_in_string_still_parses() {
    let r = top(JarBuilder::new().fabric_mod_json("{\"id\":\"x\",\"version\":\"1\",\"description\":\"a\nb\"}"));
    assert_eq!(r.status, JarStatus::Ok);
    assert_eq!(r.mods[0].mod_id, "x");
}

#[test]
fn quilt_mod_json() {
    let json = r#"{
  "schema_version": 1,
  "quilt_loader": {
    "group": "org.example",
    "id": "quilty",
    "version": "2.0.0",
    "metadata": { "name": "Quilty" },
    "provides": ["q-api", { "id": "org.example:q-extra", "version": "1.0" }],
    "depends": [
      { "id": "quilt_loader", "versions": ">=0.19.0" },
      { "id": "minecraft", "versions": { "any": ["1.20.1", { "all": [">=1.20.2", "<1.21"] }] } },
      "org.quiltmc:qsl",
      { "id": "modmenu", "optional": true },
      [ { "id": "alt_a" }, "alt_b" ]
    ],
    "breaks": [ { "id": "badmod", "versions": "<2" } ],
    "jars": [ "META-INF/jars/inner.jar" ]
  },
  "mixin": "quilty.mixins.json",
  "minecraft": { "environment": "dedicated_server" }
}"#;
    let inner = JarBuilder::new().quilt_mod_json(r#"{"quilt_loader":{"id":"inner","version":"1"}}"#);
    let recs = scan(JarBuilder::new().quilt_mod_json(json).nested("META-INF/jars/inner.jar", inner));
    let r = &recs[0];
    assert_eq!(r.status, JarStatus::Ok, "{:?}", r.status);
    let m = &r.mods[0];
    assert_eq!(m.loader, LoaderKind::Quilt);
    assert_eq!(m.name.as_deref(), Some("Quilty"));
    assert_eq!(m.provides, vec!["q-api", "q-extra"]);
    assert_eq!(m.environment, ModEnvironment::Server);
    assert_eq!(m.loader_range, Some(fabric(&[">=0.19.0"])));
    assert_eq!(m.mc_range, Some(fabric(&["1.20.1", ">=1.20.2 <1.21"])));
    assert_eq!(dep(m, "qsl").kind, DependencyKind::Required);
    assert_eq!(dep(m, "modmenu").kind, DependencyKind::Optional);
    assert_eq!(dep(m, "alt_a").kind, DependencyKind::Optional);
    assert_eq!(dep(m, "alt_b").kind, DependencyKind::Optional);
    assert_eq!(dep(m, "badmod").kind, DependencyKind::Incompatible);
    assert_eq!(dep(m, "badmod").range, fabric(&["<2"]));
    assert_eq!(r.mixin_configs, vec!["quilty.mixins.json"]);
    assert_eq!(recs[1].id, "mods/a.jar!/META-INF/jars/inner.jar");
    assert_eq!(recs[1].mods[0].loader, LoaderKind::Quilt);
}

#[test]
fn mcmod_info_both_forms() {
    let arr = r#"[{"modid":"oldmod","name":"Old Mod","version":"1.0","mcversion":"1.12.2",
        "useDependencyInformation": true,
        "requiredMods":["Forge@[14.23.5,)","baubles"],"dependencies":["jei@[4.15,)"],"dependants":["addon"],}]"#;
    let r = top(JarBuilder::new().mcmod_info(arr));
    assert_eq!(r.status, JarStatus::Ok, "{:?}", r.status);
    assert_eq!(r.loaders, vec![LoaderKind::Legacyforge]);
    let m = &r.mods[0];
    assert_eq!(m.mod_id, "oldmod");
    assert_eq!(m.mc_range, None, "mcversion is never enforced");
    assert_eq!(m.loader_range, Some(maven("[14.23.5,)")));
    assert_eq!(dep(m, "baubles").kind, DependencyKind::Required);
    assert_eq!(dep(m, "jei").kind, DependencyKind::Optional);
    assert_eq!(dep(m, "jei").range, maven("[4.15,)"));
    assert_eq!(dep(m, "addon").kind, DependencyKind::Optional);

    let list = r#"{"modListVersion":2,"modList":[{"modid":"a","version":"1"},{"modid":"b","version":"2","mcversion":"${mcversion}"}]}"#;
    let r = top(JarBuilder::new().mcmod_info(list));
    assert_eq!(r.mods.iter().map(|m| m.mod_id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
    assert!(r.mods.iter().all(|m| m.mc_range.is_none()));
}

#[test]
fn mcmod_info_deps_need_use_dependency_information() {
    // Absent (default false) and explicit false: lists are ignored, as legacy FML does.
    for flag in ["", r#""useDependencyInformation": false,"#, r#""useDependencyInformation": "true","#] {
        let json = format!(
            r#"[{{"modid":"rl","version":"1","mcversion":"1.12",{flag}
                "requiredMods":["forge@[14.23.5.2847,)","llibrary@[1.7.19]"],"dependencies":["baubles"],"dependants":["x"]}}]"#
        );
        let r = top(JarBuilder::new().mcmod_info(&json));
        assert_eq!(r.status, JarStatus::Ok, "{:?}", r.status);
        let m = &r.mods[0];
        assert!(m.deps.is_empty(), "flag {flag:?}: {:?}", m.deps);
        assert_eq!(m.loader_range, None);
        assert_eq!(m.mc_range, None);
    }
    // Per entry: only the opted-in entry gets deps.
    let json = r#"[{"modid":"a","useDependencyInformation":true,"requiredMods":["b"]},{"modid":"b","requiredMods":["c"]}]"#;
    let r = top(JarBuilder::new().mcmod_info(json));
    assert_eq!(r.mods[0].deps.len(), 1);
    assert!(r.mods[1].deps.is_empty());
}

#[test]
fn multi_loader_jar() {
    let r = top(
        JarBuilder::new()
            .fabric_mod_json(r#"{"id":"multi","version":"1"}"#)
            .neoforge_mods_toml("[[mods]]\nmodId=\"multi\"\nversion=\"1\"\n")
            .mods_toml("[[mods]]\nmodId=\"multi\"\nversion=\"1\"\n"),
    );
    assert_eq!(r.status, JarStatus::Ok);
    assert_eq!(r.mods.len(), 3);
    assert_eq!(r.loaders, vec![LoaderKind::Neoforge, LoaderKind::Forge, LoaderKind::Fabric]);
}

#[test]
fn jarjar_and_fabric_nested_depth_two() {
    let leaf = JarBuilder::new().fabric_mod_json(r#"{"id":"leaf","version":"0.1"}"#).class("org/leaf/Leaf.class", 65);
    let mid = JarBuilder::new()
        .fabric_mod_json(r#"{"id":"mid","version":"1","jars":[{"file":"META-INF/jars/leaf.jar"}]}"#)
        .class("org/mid/Mid.class", 61)
        .nested("META-INF/jars/leaf.jar", leaf);
    let jarjar = r#"{"jars":[{"identifier":{"group":"org.mid","artifact":"mid"},
        "version":{"range":"[1,2)","artifactVersion":"1.0.0"},"path":"META-INF/jarjar/mid.jar","isObfuscated":false}]}"#;
    let recs = scan(
        JarBuilder::new()
            .mods_toml("[[mods]]\nmodId=\"outer\"\n")
            .file("META-INF/jarjar/metadata.json", jarjar)
            .class("com/outer/Outer.class", 61)
            .nested("META-INF/jarjar/mid.jar", mid),
    );
    let ids: Vec<&str> = recs.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["mods/a.jar", "mods/a.jar!/META-INF/jarjar/mid.jar", "mods/a.jar!/META-INF/jarjar/mid.jar!/META-INF/jars/leaf.jar"]
    );
    let (outer, mid, leaf) = (&recs[0], &recs[1], &recs[2]);
    assert_eq!(outer.nested, vec![mid.id.clone()]);
    assert_eq!(outer.packages, vec!["com.outer"], "nested contents are not the parent's packages");
    assert_eq!(mid.depth, 1);
    assert_eq!(mid.parent_id.as_deref(), Some("mods/a.jar"));
    assert_eq!(mid.path, "META-INF/jarjar/mid.jar");
    assert_eq!(mid.file_name, "mid.jar");
    assert_eq!(mid.mtime_ms, 0);
    assert_eq!(
        mid.jarjar,
        Some(JarJarInfo { group: "org.mid".into(), artifact: "mid".into(), range: Some("[1,2)".into()), version: Some("1.0.0".into()) })
    );
    assert_eq!(mid.nested, vec![leaf.id.clone()]);
    assert_eq!(leaf.depth, 2);
    assert_eq!(leaf.parent_id.as_deref(), Some(mid.id.as_str()));
    assert_eq!(leaf.max_class_major, Some(65));
    assert_eq!(leaf.packages, vec!["org.leaf"]);
    assert!(!leaf.sha1.is_empty() && leaf.size > 0);
}

#[test]
fn nesting_depth_is_capped() {
    let mut b = JarBuilder::new().fabric_mod_json(r#"{"id":"d6","version":"1"}"#);
    for d in (0..6).rev() {
        b = JarBuilder::new()
            .fabric_mod_json(&format!(r#"{{"id":"d{d}","version":"1","jars":[{{"file":"n.jar"}}]}}"#))
            .nested("n.jar", b);
    }
    let bytes = b.build();
    let mut out = Vec::new();
    let mut issues = Vec::new();
    let ctx = JarCtx {
        id: "mods/a.jar".into(),
        path: "mods/a.jar".into(),
        file_name: "a.jar".into(),
        depth: 0,
        parent_id: None,
        disabled: false,
        mtime_ms: 0,
    };
    jar::scan_into(&ctx, &bytes, &mut jar::Budget::new(jar::DEFAULT_LIMITS), &mut out, &mut issues);
    assert_eq!(out.iter().map(|r| r.depth).max(), Some(MAX_NESTED_DEPTH));
    assert_eq!(out.len(), MAX_NESTED_DEPTH as usize + 1);
    assert!(out.iter().find(|r| r.depth == MAX_NESTED_DEPTH).is_some_and(|r| r.nested.is_empty()));
    assert_eq!(issues.len(), 1, "{issues:?}");
    assert!(issues[0].message.contains("not scanned"));
}

#[test]
fn missing_nested_entry_is_an_issue_not_a_record() {
    let bytes = JarBuilder::new().fabric_mod_json(r#"{"id":"x","version":"1","jars":[{"file":"gone.jar"}]}"#).build();
    let ctx = JarCtx {
        id: "mods/a.jar".into(),
        path: "mods/a.jar".into(),
        file_name: "a.jar".into(),
        depth: 0,
        parent_id: None,
        disabled: false,
        mtime_ms: 0,
    };
    let (mut out, mut issues) = (Vec::new(), Vec::new());
    jar::scan_into(&ctx, &bytes, &mut jar::Budget::new(jar::DEFAULT_LIMITS), &mut out, &mut issues);
    assert_eq!(out.len(), 1);
    assert!(out[0].nested.is_empty());
    assert!(issues[0].message.contains("gone.jar"));
}

#[test]
fn packages_and_class_versions_exclude_meta_inf() {
    let r = top(
        JarBuilder::new()
            .class("com/a/A.class", 61)
            .class("com/a/B.class", 61)
            .class("com/a/sub/C.class", 52)
            .class("org/z/package-info.class", 60)
            .class("Root.class", 61)
            .class("META-INF/versions/21/com/mr/Only.class", 65)
            .class("meta-inf/versions/22/com/mr2/Only.class", 66)
            .file("com/bad/Bad.class", b"not a class file")
            .file("assets/x/readme.txt", "hi"),
    );
    assert_eq!(r.packages, vec!["com.a", "com.a.sub", "com.bad", "org.z"]);
    assert_eq!(r.max_class_major, Some(61), "multi-release overlays and bad magic ignored");
    let none = top(JarBuilder::new().file("data.txt", "x"));
    assert_eq!(none.max_class_major, None);
    assert!(none.packages.is_empty());
    assert!(none.loaders.is_empty() && none.mods.is_empty());
    assert_eq!(none.status, JarStatus::Ok);
}

#[test]
fn class_sample_covers_large_jars() {
    let mut b = JarBuilder::new();
    for i in 0..500 {
        b = b.class(&format!("p{}/C{i}.class", i % 7), if i == 499 { 65 } else { 61 });
    }
    let r = top(b);
    assert_eq!(r.packages.len(), 7);
    let major = r.max_class_major.expect("sampled");
    assert!(major == 61 || major == 65);
}

#[test]
fn unparseable_metadata_is_corrupt_but_lists_packages() {
    let r = top(JarBuilder::new().mods_toml("this is = = not toml [[").class("com/x/X.class", 61));
    match &r.status {
        JarStatus::Corrupt { reason } => assert!(reason.contains("META-INF/mods.toml"), "{reason}"),
        s => panic!("expected corrupt, got {s:?}"),
    }
    assert_eq!(r.packages, vec!["com.x"]);
    let r = top(JarBuilder::new().fabric_mod_json("{ \"version\": \"1\" }"));
    assert!(matches!(r.status, JarStatus::Corrupt { .. }));
    // One good + one bad file: good mods kept, status Ok, the bad file listed.
    let r = top(JarBuilder::new().fabric_mod_json(r#"{"id":"ok","version":"1"}"#).quilt_mod_json("{nope"));
    assert_eq!(r.status, JarStatus::Ok);
    assert_eq!(r.mods[0].mod_id, "ok");
    assert_eq!(r.metadata_errors.len(), 1);
    assert_eq!(r.metadata_errors[0].file, "quilt.mod.json");
}

#[test]
fn hashes_match_independent_digests() {
    // Known vectors.
    let (s1, s512) = jar::hash_bytes(b"abc");
    assert_eq!(s1, "a9993e364706816aba3e25717850c26c9cd0d89d");
    assert_eq!(
        s512,
        "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
    );
    // A real jar, larger than one hashing chunk, on disk, plus a nested jar.
    let blob: Vec<u8> = (0..300_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
    let inner = JarBuilder::new().file("blob.bin", &blob).fabric_mod_json(r#"{"id":"in","version":"1"}"#);
    let inner_bytes = inner.clone().build();
    let tmp = tempfile::tempdir().expect("tempdir");
    let path = JarBuilder::new()
        .fabric_mod_json(r#"{"id":"out","version":"1","jars":[{"file":"in.jar"}]}"#)
        .file("blob.bin", &blob)
        .nested("in.jar", inner)
        .write_to(&tmp.path().join("mods"), "h.jar");
    let file_bytes = std::fs::read(&path).expect("read");
    let res = scan_mods_dir(tmp.path(), "i", &guard_for(tmp.path()), |_| {}, |_| {}).expect("scan");
    let outer = &res.jars[0];
    assert_eq!(outer.sha1, hex::encode(Sha1::digest(&file_bytes)));
    assert_eq!(outer.sha512, hex::encode(Sha512::digest(&file_bytes)));
    assert_eq!(outer.size, file_bytes.len() as u64);
    assert!(outer.mtime_ms > 0);
    let nested = &res.jars[1];
    assert_eq!(nested.sha1, hex::encode(Sha1::digest(&inner_bytes)));
    assert_eq!(nested.sha512, hex::encode(Sha512::digest(&inner_bytes)));
    assert_eq!(nested.size, inner_bytes.len() as u64);
}

#[test]
fn corrupt_and_non_zip_files_do_not_stop_the_scan() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mods = tmp.path().join("mods");
    JarBuilder::new().fabric_mod_json(r#"{"id":"good","version":"1"}"#).write_to(&mods, "good.jar");
    let mut truncated = JarBuilder::new().fabric_mod_json(r#"{"id":"t","version":"1"}"#).build();
    truncated.truncate(truncated.len() / 2);
    std::fs::write(mods.join("truncated.jar"), &truncated).expect("write");
    std::fs::write(mods.join("text.jar"), "hello, I am not a zip").expect("write");
    std::fs::write(mods.join("empty.jar"), b"").expect("write");
    std::fs::write(mods.join("notes.txt"), "ignored").expect("write");
    std::fs::create_dir_all(mods.join("sub")).expect("mkdir");
    JarBuilder::new().write_to(&mods.join("sub"), "deep.jar");

    let res = scan_mods_dir(tmp.path(), "i", &guard_for(tmp.path()), |_| {}, |_| {}).expect("scan");
    let ids: Vec<&str> = res.jars.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec!["mods/empty.jar", "mods/good.jar", "mods/text.jar", "mods/truncated.jar"]);
    for r in &res.jars {
        if r.id == "mods/good.jar" {
            assert_eq!(r.status, JarStatus::Ok);
        } else {
            assert!(matches!(r.status, JarStatus::Corrupt { .. }), "{}: {:?}", r.id, r.status);
            assert!(!r.sha1.is_empty(), "corrupt files are still hashed");
            assert!(res.issues.iter().any(|i| i.subject == r.id), "issue for {}", r.id);
        }
    }
    assert_eq!(res.issues.len(), 3);
}

#[test]
fn disabled_ids_and_collision() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mods = tmp.path().join("mods");
    let j = || JarBuilder::new().fabric_mod_json(r#"{"id":"m","version":"1"}"#);
    j().write_to(&mods, "x.jar");
    j().write_to(&mods, "x.jar.disabled");
    j().write_to(&mods, "y.jar.disabled");
    JarBuilder::new()
        .fabric_mod_json(r#"{"id":"z","version":"1","jars":[{"file":"inner.jar"}]}"#)
        .nested("inner.jar", JarBuilder::new())
        .write_to(&mods, "Z.JAR.DISABLED");
    let res = scan_mods_dir(tmp.path(), "i", &guard_for(tmp.path()), |_| {}, |_| {}).expect("scan");
    let got: Vec<(&str, &str, bool)> = res.jars.iter().map(|r| (r.id.as_str(), r.path.as_str(), r.disabled)).collect();
    assert_eq!(
        got,
        vec![
            ("mods/Z.JAR", "mods/Z.JAR.DISABLED", true),
            ("mods/Z.JAR!/inner.jar", "inner.jar", true),
            ("mods/x.jar", "mods/x.jar", false),
            ("mods/x.jar#disabled", "mods/x.jar.disabled", true),
            ("mods/y.jar", "mods/y.jar.disabled", true),
        ]
    );
}

#[test]
fn non_ascii_file_names() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mods = tmp.path().join("mods");
    JarBuilder::new()
        .fabric_mod_json(r#"{"id":"uni","version":"1","name":"Jürgen's мод 日本"}"#)
        .class("com/ü/Ä.class", 61)
        .write_to(&mods, "Jürgen-мод-日本.jar");
    let res = scan_mods_dir(tmp.path(), "i", &guard_for(tmp.path()), |_| {}, |_| {}).expect("scan");
    assert_eq!(res.jars.len(), 1);
    let r = &res.jars[0];
    assert_eq!(r.id, "mods/Jürgen-мод-日本.jar");
    assert_eq!(r.file_name, "Jürgen-мод-日本.jar");
    assert_eq!(r.status, JarStatus::Ok);
    assert_eq!(r.mods[0].name.as_deref(), Some("Jürgen's мод 日本"));
    assert_eq!(r.packages, vec!["com.ü"]);
}

#[test]
fn scan_started_order_and_progress_counts() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mods = tmp.path().join("mods");
    for name in ["beta.jar", "Alpha.jar", "gamma.jar.disabled", "delta.jar", "broken.jar"] {
        JarBuilder::new().fabric_mod_json(r#"{"id":"m","version":"1"}"#).write_to(&mods, name);
    }
    std::fs::write(mods.join("broken.jar"), "nope").expect("write");
    let started: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let started_calls = Mutex::new(0);
    let progress: Mutex<Vec<ScanProgress>> = Mutex::new(Vec::new());
    let res = scan_mods_dir(
        tmp.path(),
        "inst",
        &guard_for(tmp.path()),
        |stubs| {
            *started_calls.lock().expect("lock") += 1;
            assert!(progress.lock().expect("lock").is_empty(), "ScanStarted precedes progress");
            *started.lock().expect("lock") = stubs.iter().map(|s| s.file_name.clone()).collect();
            let g = stubs.iter().find(|s| s.file_name == "gamma.jar.disabled").expect("gamma");
            assert!(g.disabled);
            assert_eq!(g.id, "mods/gamma.jar");
        },
        |p| progress.lock().expect("lock").push(p),
    )
    .expect("scan");
    assert_eq!(*started_calls.lock().expect("lock"), 1);
    assert_eq!(
        *started.lock().expect("lock"),
        vec!["Alpha.jar", "beta.jar", "broken.jar", "delta.jar", "gamma.jar.disabled"]
    );
    let progress = progress.into_inner().expect("lock");
    assert_eq!(progress.len(), 5);
    let mut dones: Vec<u32> = progress.iter().map(|p| p.done).collect();
    dones.sort_unstable();
    assert_eq!(dones, vec![1, 2, 3, 4, 5]);
    assert!(progress.iter().all(|p| p.total == 5 && p.instance_id == "inst"));
    assert!(progress.iter().all(|p| p.parsed == (p.jar_id != "mods/broken.jar")));
    assert_eq!(res.instance_id, "inst");
    assert!(res.started_at_ms > 0);
    assert!(res.declared.is_empty());
}

#[test]
fn missing_mods_dir_is_empty() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mut called = false;
    let res = scan_mods_dir(tmp.path(), "i", &guard_for(tmp.path()), |s| called = s.is_empty(), |_| panic!("no progress")).expect("scan");
    assert!(called);
    assert!(res.jars.is_empty() && res.issues.is_empty());
}

#[test]
fn scan_paths_overrides_and_unreadable() {
    let tmp = tempfile::tempdir().expect("tempdir");
    JarBuilder::new()
        .fabric_mod_json(r#"{"id":"y","version":"1"}"#)
        .write_to(&tmp.path().join("client-overrides").join("mods"), "y.jar");
    let paths = vec!["client-overrides\\mods\\y.jar".to_string(), "overrides/mods/missing.jar".to_string(), "../escape.jar".to_string()];
    let res = scan_paths(tmp.path(), &paths, "i", &guard_for(tmp.path()), |_| {}, |_| {}).expect("scan");
    let y = res.jars.iter().find(|r| r.id == "client-overrides/mods/y.jar").expect("y");
    assert_eq!(y.path, "client-overrides/mods/y.jar");
    assert_eq!(y.status, JarStatus::Ok);
    let missing = res.jars.iter().find(|r| r.id == "overrides/mods/missing.jar").expect("missing");
    assert!(matches!(missing.status, JarStatus::Unreadable { .. }));
    let escape = res.jars.iter().find(|r| r.id == "../escape.jar").expect("escape");
    assert!(matches!(escape.status, JarStatus::Unreadable { .. }));
    assert_eq!(res.issues.len(), 2);
}

#[test]
fn cache_skips_unchanged_jars_and_rekeys() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mods = tmp.path().join("mods");
    let j = || {
        JarBuilder::new()
            .fabric_mod_json(r#"{"id":"m","version":"1","jars":[{"file":"n.jar"}]}"#)
            .nested("n.jar", JarBuilder::new().fabric_mod_json(r#"{"id":"n","version":"1"}"#))
    };
    j().write_to(&mods, "x.jar.disabled");
    let cache = ScanCache::new();
    let first = scan_mods_dir_cached(tmp.path(), "i", &guard_for(tmp.path()), Some(&cache), |_| {}, |_| {}).expect("scan");
    assert_eq!(cache.len(), 1);
    assert_eq!(first.jars[0].id, "mods/x.jar");

    // Poison the cached entry so a hit is observable.
    {
        let mut map = cache.lock();
        let e = map.values_mut().next().expect("entry");
        e.records[0].mods[0].version = "cached".into();
    }
    // An enabled twin appears: the cached disabled jar must be re-keyed to `#disabled`.
    JarBuilder::new().fabric_mod_json(r#"{"id":"other","version":"1"}"#).write_to(&mods, "x.jar");
    let second = scan_mods_dir_cached(tmp.path(), "i", &guard_for(tmp.path()), Some(&cache), |_| {}, |_| {}).expect("scan");
    let dis = second.jars.iter().find(|r| r.id == "mods/x.jar#disabled").expect("rekeyed");
    assert_eq!(dis.mods[0].version, "cached", "served from cache");
    assert_eq!(dis.nested, vec!["mods/x.jar#disabled!/n.jar"]);
    let nested = second.jars.iter().find(|r| r.id == "mods/x.jar#disabled!/n.jar").expect("nested rekeyed");
    assert_eq!(nested.parent_id.as_deref(), Some("mods/x.jar#disabled"));
    assert_eq!(cache.len(), 2);

    // Removing a file prunes its entry.
    std::fs::remove_file(mods.join("x.jar")).expect("rm");
    scan_mods_dir_cached(tmp.path(), "i", &guard_for(tmp.path()), Some(&cache), |_| {}, |_| {}).expect("scan");
    assert_eq!(cache.len(), 1);
    cache.clear();
    assert!(cache.is_empty());
}

#[test]
fn output_is_deterministic() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mods = tmp.path().join("mods");
    for i in 0..20 {
        JarBuilder::new()
            .fabric_mod_json(&format!(r#"{{"id":"m{i}","version":"1"}}"#))
            .class(&format!("p{i}/C.class"), 61)
            .write_to(&mods, &format!("m{i}.jar"));
    }
    let a = scan_mods_dir(tmp.path(), "i", &guard_for(tmp.path()), |_| {}, |_| {}).expect("scan");
    let b = scan_mods_dir(tmp.path(), "i", &guard_for(tmp.path()), |_| {}, |_| {}).expect("scan");
    assert_eq!(a.jars, b.jars);
    let ids: Vec<&String> = a.jars.iter().map(|r| &r.id).collect();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted);
}
