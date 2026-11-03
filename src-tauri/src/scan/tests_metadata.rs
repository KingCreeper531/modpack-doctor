//! Per-file metadata errors and build-template placeholders, reproducing real jars from a
//! NeoForge 1.21.1 pack that loads fine.

use super::jar::{scan_into, Budget, JarCtx, DEFAULT_LIMITS};
use super::*;
use crate::model::{LoaderKind, RangeSyntax, RawRange};
use crate::test_support::JarBuilder;

fn run(b: JarBuilder) -> (Vec<JarRecord>, Vec<ScanIssue>) {
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
    scan_into(&ctx, &b.build(), &mut Budget::new(DEFAULT_LIMITS), &mut out, &mut issues);
    (out, issues)
}

fn unrepresentable(syntax: RangeSyntax, text: &str) -> Option<RawRange> {
    Some(RawRange { syntax, raw: Vec::new(), unrepresentable: Some(text.to_string()) })
}

fn neoforge_toml(mod_id: &str, mc: &str) -> String {
    format!(
        r#"modLoader="javafml"
loaderVersion="[4,)"
license="MIT"
[[mods]]
modId="{mod_id}"
version="1.0.0"
displayName="Test"
[[dependencies.{mod_id}]]
    modId="neoforge"
    type="required"
    versionRange="[21.1,)"
    ordering="NONE"
    side="BOTH"
[[dependencies.{mod_id}]]
    modId="minecraft"
    type="required"
    versionRange="{mc}"
    ordering="NONE"
    side="BOTH"
"#
    )
}

/// The NeoForge MDK template, left unexpanded by a misconfigured build.
const MDK_TEMPLATE: &str = r#"# This is an example mods.toml file. It contains the data relating to the loading mods.
# There are several mandatory fields (#mandatory), and many more that are optional (#optional).
modLoader="javafml" #mandatory
# A version range to match for said mod loader - for regular FML @Mod it will be the FML version.
loaderVersion="${loader_version_range}" #mandatory
license="${mod_license}"
[[mods]] #mandatory
modId="${mod_id}" #mandatory
version="${mod_version}" #mandatory
displayName="${mod_name}" #mandatory
authors="${mod_authors}" #optional
description='''${mod_description}'''
[[mixins]]
config="${mod_id}.mixins.json"
[[dependencies.${mod_id}]] #optional
    modId="neoforge" #mandatory
    type="required" #mandatory
    versionRange="${neo_version_range}" #mandatory
    ordering="NONE"
    side="BOTH"
[[dependencies.${mod_id}]]
    modId="minecraft"
    type="required"
    versionRange="${minecraft_version_range}"
    ordering="NONE"
    side="BOTH"
"#;

#[test]
fn create_radar_empty_mods_toml_with_valid_neoforge_toml() {
    let (out, issues) = run(
        JarBuilder::new()
            .file("META-INF/mods.toml", "")
            .neoforge_mods_toml(&neoforge_toml("create_radar", "[1.21.1]"))
            .class("com/happysg/radar/CreateRadar.class", 65),
    );
    let r = &out[0];
    assert_eq!(r.status, JarStatus::Ok);
    assert_eq!(r.loaders, vec![LoaderKind::Neoforge]);
    assert_eq!(r.mods.len(), 1);
    assert_eq!(r.mods[0].metadata_file, "META-INF/neoforge.mods.toml");
    assert_eq!(r.metadata_errors.len(), 1);
    assert_eq!(r.metadata_errors[0].file, "META-INF/mods.toml");
    assert!(r.metadata_errors[0].reason.contains("empty"), "{}", r.metadata_errors[0].reason);
    assert!(issues.is_empty(), "metadata errors alone raise no ScanIssue: {issues:?}");
}

#[test]
fn numismaticsutils_template_mods_toml_with_valid_neoforge_toml() {
    let (out, issues) = run(
        JarBuilder::new()
            .file("META-INF/mods.toml", MDK_TEMPLATE)
            .neoforge_mods_toml(&neoforge_toml("numismaticsutils", "[1.21.1]")),
    );
    let r = &out[0];
    assert_eq!(r.status, JarStatus::Ok);
    assert_eq!(r.mods.len(), 1);
    assert_eq!(r.mods[0].mod_id, "numismaticsutils");
    assert_eq!(r.metadata_errors.len(), 1);
    assert_eq!(r.metadata_errors[0].file, "META-INF/mods.toml");
    assert!(issues.is_empty());
    assert!(r.mixin_configs.is_empty(), "nothing taken from the failed file");
}

#[test]
fn template_that_is_valid_toml_fails_on_placeholder_mod_id() {
    let quoted = MDK_TEMPLATE.replace("[[dependencies.${mod_id}]]", "[[dependencies.\"${mod_id}\"]]");
    let (out, _) = run(JarBuilder::new().mods_toml(&quoted).neoforge_mods_toml(&neoforge_toml("x", "[1.21.1]")));
    let r = &out[0];
    assert_eq!(r.status, JarStatus::Ok);
    assert_eq!(r.metadata_errors.len(), 1);
    assert!(r.metadata_errors[0].reason.contains("${mod_id}") && r.metadata_errors[0].reason.contains("placeholder"));
}

#[test]
fn create_stuff_additions_both_files_valid() {
    let (out, _) = run(
        JarBuilder::new()
            .mods_toml(&neoforge_toml("create_sa", "[1.20.4]"))
            .neoforge_mods_toml(&neoforge_toml("create_sa", "[1.21.1]")),
    );
    let r = &out[0];
    assert_eq!(r.status, JarStatus::Ok);
    assert!(r.metadata_errors.is_empty());
    assert_eq!(r.mods.len(), 2);
    let by_file = |f: &str| r.mods.iter().find(|m| m.metadata_file == f).expect("mod for file");
    let maven = |s: &str| Some(RawRange { syntax: RangeSyntax::Maven, raw: vec![s.into()], unrepresentable: None });
    assert_eq!(by_file("META-INF/mods.toml").mc_range, maven("[1.20.4]"));
    assert_eq!(by_file("META-INF/neoforge.mods.toml").mc_range, maven("[1.21.1]"));
    assert!(r.mods.iter().all(|m| m.loader == LoaderKind::Neoforge && m.mod_id == "create_sa"));
}

#[test]
fn only_metadata_file_broken_is_corrupt() {
    for b in [
        JarBuilder::new().file("META-INF/mods.toml", "").class("a/A.class", 61),
        JarBuilder::new().mods_toml(MDK_TEMPLATE).class("a/A.class", 61),
        JarBuilder::new().fabric_mod_json(r#"{"id":"${mod_id}","version":"1"}"#).class("a/A.class", 61),
        JarBuilder::new().file("META-INF/mods.toml", "").fabric_mod_json("{ broken").class("a/A.class", 61),
    ] {
        let (out, issues) = run(b);
        let r = &out[0];
        assert!(matches!(r.status, JarStatus::Corrupt { .. }), "{:?}", r.status);
        assert!(!r.metadata_errors.is_empty());
        assert_eq!(r.packages, vec!["a"], "packages still listed");
        assert_eq!(issues.len(), 1, "Corrupt keeps its ScanIssue");
    }
    // No metadata at all is not corrupt (a plain library jar).
    let (out, _) = run(JarBuilder::new().class("a/A.class", 61));
    assert_eq!(out[0].status, JarStatus::Ok);
    assert!(out[0].metadata_errors.is_empty());
}

#[test]
fn nested_jars_get_the_same_treatment() {
    let inner = JarBuilder::new().file("META-INF/mods.toml", "").neoforge_mods_toml(&neoforge_toml("inner", "[1.21.1]"));
    let jarjar = r#"{"jars":[{"identifier":{"group":"g","artifact":"inner"},"version":{"range":"[1,)","artifactVersion":"1"},"path":"META-INF/jarjar/inner.jar"}]}"#;
    let (out, issues) = run(
        JarBuilder::new()
            .neoforge_mods_toml(&neoforge_toml("outer", "[1.21.1]"))
            .file("META-INF/jarjar/metadata.json", jarjar)
            .nested("META-INF/jarjar/inner.jar", inner),
    );
    assert_eq!(out.len(), 2);
    assert_eq!(out[1].status, JarStatus::Ok);
    assert_eq!(out[1].metadata_errors.len(), 1);
    assert!(issues.is_empty());
}

#[test]
fn placeholder_ranges_are_unrepresentable() {
    let toml = r#"modLoader="javafml"
loaderVersion="${loader_version_range}"
[[mods]]
modId="placed"
version="${mod_version}"
[[dependencies.placed]]
modId="neoforge"
type="required"
versionRange="${neo_version_range}"
[[dependencies.placed]]
modId="minecraft"
type="required"
versionRange="[1.21,${mc_max})"
"#;
    let (out, _) = run(JarBuilder::new().neoforge_mods_toml(toml));
    let r = &out[0];
    assert_eq!(r.status, JarStatus::Ok);
    assert!(r.metadata_errors.is_empty(), "placeholders outside modId are not errors");
    let m = &r.mods[0];
    assert_eq!(m.version, "${mod_version}");
    assert_eq!(m.language_range, unrepresentable(RangeSyntax::Maven, "${loader_version_range}"));
    assert_eq!(m.loader_range, unrepresentable(RangeSyntax::Maven, "${neo_version_range}"));
    assert_eq!(m.mc_range, unrepresentable(RangeSyntax::Maven, "[1.21,${mc_max})"));

    let fabric = r#"{"id":"fab","version":"${version}","depends":{"minecraft":"${minecraft_version}","fabricloader":[">=0.15","${loader}"],"fabric-api":"*"}}"#;
    let (out, _) = run(JarBuilder::new().fabric_mod_json(fabric));
    let m = &out[0].mods[0];
    assert_eq!(out[0].status, JarStatus::Ok);
    assert_eq!(m.version, "${version}");
    assert_eq!(m.mc_range, unrepresentable(RangeSyntax::Fabric, "${minecraft_version}"));
    assert_eq!(m.loader_range, unrepresentable(RangeSyntax::Fabric, r#"[">=0.15","${loader}"]"#));
    assert_eq!(m.deps.iter().find(|d| d.mod_id == "fabric-api").map(|d| d.range.raw.clone()), Some(vec!["*".to_string()]));

    let quilt = r#"{"quilt_loader":{"id":"q","version":"1","depends":[
        {"id":"minecraft","versions":"${mc}"},
        {"id":"quilt_loader","versions":{"all":[">=0.19","${max}"]}}]}}"#;
    let (out, _) = run(JarBuilder::new().quilt_mod_json(quilt));
    let m = &out[0].mods[0];
    assert_eq!(m.mc_range, unrepresentable(RangeSyntax::Fabric, "${mc}"));
    assert_eq!(m.loader_range, unrepresentable(RangeSyntax::Fabric, r#"{"all":[">=0.19","${max}"]}"#));
}
