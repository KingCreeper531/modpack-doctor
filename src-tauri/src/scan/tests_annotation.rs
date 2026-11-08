//! Legacy Forge `@Mod` annotations: scanner-level tests with hand-assembled class files
//! (`annotation::build_class`) inside in-memory jars.

use super::annotation::{build_class, build_container_class};
use super::jar::{scan_into, Budget, JarCtx, Limits, DEFAULT_LIMITS};
use super::legacy::parse_dependency_string;
use super::*;
use crate::model::{Dependency, DependencyKind, LoaderKind, ModEnvironment, ModMeta, RangeSyntax, RawRange};
use crate::test_support::JarBuilder;

const DESC: &str = "Lnet/minecraftforge/fml/common/Mod;";
const CPW: &str = "Lcpw/mods/fml/common/Mod;";

fn ctx(depth: u32) -> JarCtx {
    JarCtx {
        id: "mods/a.jar".into(),
        path: "mods/a.jar".into(),
        file_name: "a.jar".into(),
        depth,
        parent_id: None,
        disabled: false,
        mtime_ms: 0,
    }
}

fn run_with(b: JarBuilder, limits: Limits) -> (JarRecord, Vec<ScanIssue>) {
    let (mut out, mut issues) = (Vec::new(), Vec::new());
    scan_into(&ctx(0), &b.build(), &mut Budget::new(limits), &mut out, &mut issues);
    (out.remove(0), issues)
}

fn run(b: JarBuilder) -> (JarRecord, Vec<ScanIssue>) {
    run_with(b, DEFAULT_LIMITS)
}

fn maven(s: &str) -> RawRange {
    RawRange { syntax: RangeSyntax::Maven, raw: vec![s.to_string()], unrepresentable: None }
}

fn any() -> RawRange {
    RawRange { syntax: RangeSyntax::Maven, raw: Vec::new(), unrepresentable: None }
}

fn dep<'a>(m: &'a ModMeta, id: &str) -> &'a Dependency {
    m.deps.iter().find(|d| d.mod_id == id).unwrap_or_else(|| panic!("no dep {id} in {:?}", m.deps))
}

fn mod_class(class: &str, strings: &[(&str, &str)], bools: &[(&str, bool)]) -> Vec<u8> {
    build_class(class, DESC, strings, bools, true)
}

fn by_id<'a>(r: &'a JarRecord, id: &str) -> &'a ModMeta {
    r.mods.iter().find(|m| m.mod_id == id).unwrap_or_else(|| panic!("no mod {id}"))
}

#[test]
fn annotation_only_mod() {
    let class = mod_class(
        "com/example/MyMod",
        &[
            ("modid", "examplemod"),
            ("name", "Example Mod"),
            ("version", "1.4.2"),
            ("dependencies", "required-after:forge@[14.23.5.2768,);required-after:baubles@[1.5.2,);after:jei"),
            ("acceptedMinecraftVersions", "[1.12.2]"),
        ],
        &[("clientSideOnly", true)],
    );
    let (r, issues) = run(JarBuilder::new().file("com/example/MyMod.class", &class).file("com/example/Other.class", mod_class("com/example/Other", &[], &[])));
    assert!(issues.is_empty(), "{issues:?}");
    assert_eq!(r.status, JarStatus::Ok, "{:?}", r.status);
    assert_eq!(r.loaders, vec![LoaderKind::Legacyforge]);
    assert_eq!(r.mods.len(), 1);
    let m = &r.mods[0];
    assert_eq!(m.mod_id, "examplemod");
    assert_eq!(m.name.as_deref(), Some("Example Mod"));
    assert_eq!(m.version, "1.4.2");
    assert_eq!(m.loader, LoaderKind::Legacyforge);
    assert_eq!(m.environment, ModEnvironment::Client);
    assert_eq!(m.mc_range, Some(maven("[1.12.2]")));
    assert_eq!(m.loader_range, Some(maven("[14.23.5.2768,)")));
    assert_eq!(dep(m, "minecraft").kind, DependencyKind::Required);
    assert_eq!(dep(m, "minecraft").range, maven("[1.12.2]"));
    assert_eq!(dep(m, "baubles").kind, DependencyKind::Required);
    assert_eq!(dep(m, "baubles").range, maven("[1.5.2,)"));
    assert_eq!(dep(m, "jei").kind, DependencyKind::Optional);
    assert_eq!(dep(m, "jei").range, any());
    assert_eq!(m.metadata_file, "com/example/MyMod.class");
    assert!(m.metadata_excerpt.contains("@Mod("), "{}", m.metadata_excerpt);
    assert!(m.metadata_excerpt.contains(r#"modid = "examplemod""#), "{}", m.metadata_excerpt);
    assert!(m.metadata_excerpt.contains("com.example.MyMod"), "{}", m.metadata_excerpt);
    assert!(m.metadata_excerpt.contains("clientSideOnly = true"), "{}", m.metadata_excerpt);
    assert_eq!(r.max_class_major, Some(52), "class versions still come from the same pass");
}

#[test]
fn legacy_1_7_10_descriptor_and_server_only() {
    let class = build_class(
        "cpw/example/Old",
        CPW,
        &[("modid", "OldMod"), ("version", "1.7.10-2.0"), ("dependencies", "required-after:Forge@[10.13.4.1558,);after:NotEnoughItems")],
        &[("serverSideOnly", true)],
        false,
    );
    let (r, _) = run(JarBuilder::new().file("cpw/example/Old.class", class));
    let m = by_id(&r, "OldMod");
    assert_eq!(m.loader_range, Some(maven("[10.13.4.1558,)")), "Forge (1.7.10 id) is the loader dependency");
    assert_eq!(m.environment, ModEnvironment::Server);
    assert_eq!(m.mc_range, None, "no acceptedMinecraftVersions: FML accepts the running version");
    assert!(m.deps.iter().all(|d| d.mod_id != "minecraft"));
    assert_eq!(dep(m, "NotEnoughItems").kind, DependencyKind::Optional);
    assert!(m.metadata_excerpt.contains("cpw.mods.fml.common.Mod"), "{}", m.metadata_excerpt);
}

#[test]
fn accepted_minecraft_versions_widening() {
    let class = mod_class("a/M", &[("modid", "m"), ("acceptedMinecraftVersions", "[1.12]")], &[]);
    let (r, _) = run(JarBuilder::new().file("a/M.class", class));
    assert_eq!(r.mods[0].mc_range, Some(maven("[1.12,1.12.2]")));
}

#[test]
fn merge_with_mcmod_info() {
    let info = r#"[
        {"modid":"examplemod","name":"Example (mcmod)","version":"9.9","mcversion":"1.12.2","description":"d"},
        {"modid":"companion","name":"Companion","version":"1"}
    ]"#;
    let class = mod_class(
        "com/example/MyMod",
        &[
            ("modid", "examplemod"),
            ("name", "Example (annotation)"),
            ("version", "1.0.0"),
            ("dependencies", "required-after:codechickenlib@[3.2,)"),
            ("acceptedMinecraftVersions", "[1.12.2]"),
        ],
        &[],
    );
    let extra = mod_class("com/example/Extra", &[("modid", "extra"), ("version", "2")], &[]);
    let (r, _) = run(JarBuilder::new().mcmod_info(info).file("com/example/MyMod.class", class).file("com/example/Extra.class", extra));
    assert_eq!(r.status, JarStatus::Ok);
    assert_eq!(r.mods.iter().map(|m| m.mod_id.as_str()).collect::<Vec<_>>(), vec!["examplemod", "companion", "extra"]);
    let m = by_id(&r, "examplemod");
    assert_eq!(m.name.as_deref(), Some("Example (mcmod)"), "mcmod.info wins for the name");
    assert_eq!(m.version, "1.0.0", "FML compares the annotation's version");
    assert_eq!(dep(m, "codechickenlib").kind, DependencyKind::Required, "annotation deps added: mcmod.info lacks them");
    assert_eq!(m.mc_range, Some(maven("[1.12.2]")));
    assert_eq!(m.metadata_file, "com/example/MyMod.class");
    assert!(m.metadata_excerpt.contains("name from mcmod.info"), "{}", m.metadata_excerpt);
    // No annotation: the mcmod.info entry stays as it was.
    let c = by_id(&r, "companion");
    assert_eq!(c.metadata_file, "mcmod.info");
    assert!(c.deps.is_empty());
    // Annotation-only id in the same jar.
    assert_eq!(by_id(&r, "extra").metadata_file, "com/example/Extra.class");
    assert_eq!(by_id(&r, "extra").name, None);
}

#[test]
fn merge_respects_use_dependency_information() {
    let info = r#"[{"modid":"m","name":"M","version":"1","useDependencyInformation":true,"requiredMods":["fromInfo"]}]"#;
    let strings = [("modid", "m"), ("version", "${version}"), ("dependencies", "required-after:fromAnnotation"), ("acceptedMinecraftVersions", "[1.12.2]")];
    // Opted in: FML uses mcmod.info's lists; MC range still from the annotation.
    let (r, _) = run(JarBuilder::new().mcmod_info(info).file("a/M.class", mod_class("a/M", &strings, &[])));
    let m = by_id(&r, "m");
    assert!(m.deps.iter().any(|d| d.mod_id == "fromInfo"));
    assert!(m.deps.iter().all(|d| d.mod_id != "fromAnnotation"));
    assert_eq!(m.mc_range, Some(maven("[1.12.2]")));
    assert_eq!(m.version, "1", "a placeholder version falls back to mcmod.info");
    assert!(m.metadata_excerpt.contains("dependencies from mcmod.info"), "{}", m.metadata_excerpt);
    // `useMetadata = false` overrides the opt-in.
    let (r, _) = run(JarBuilder::new().mcmod_info(info).file("a/M.class", mod_class("a/M", &strings, &[("useMetadata", false)])));
    let m = by_id(&r, "m");
    assert!(m.deps.iter().any(|d| d.mod_id == "fromAnnotation"));
    assert!(m.deps.iter().all(|d| d.mod_id != "fromInfo"));
}

#[test]
fn broken_mcmod_info_with_annotation_is_ok() {
    let (r, _) = run(JarBuilder::new().mcmod_info("{ nope").file("a/M.class", mod_class("a/M", &[("modid", "m")], &[])));
    assert_eq!(r.status, JarStatus::Ok, "{:?}", r.status);
    assert_eq!(r.mods.len(), 1);
    assert_eq!(r.metadata_errors.len(), 1);
    assert_eq!(r.metadata_errors[0].file, "mcmod.info");
}

#[test]
fn duplicate_and_placeholder_ids() {
    let (r, _) = run(
        JarBuilder::new()
            .file("a/A.class", mod_class("a/A", &[("modid", "same"), ("version", "1")], &[]))
            .file("a/B.class", mod_class("a/B", &[("modid", "same"), ("version", "2")], &[]))
            .file("a/C.class", mod_class("a/C", &[("modid", "${modid}")], &[])),
    );
    assert_eq!(r.mods.len(), 1, "{:?}", r.mods);
    assert_eq!(r.mods[0].version, "1", "first class wins");
}

#[test]
fn dependency_strings() {
    let d = parse_dependency_string(
        " required-after:forge@[14.23.5.2779,) ; required-before:early ;before:later@[2,);after:jei@[4.15,);\
         required:plain;required-client:render;client-after:clientopt;server-required-after:srv;after:*;before:*;\
         after:range@(,3];;  ",
    );
    let get = |id: &str| d.iter().find(|x| x.mod_id == id).unwrap_or_else(|| panic!("no {id} in {d:?}"));
    assert_eq!(get("forge").kind, DependencyKind::Required);
    assert_eq!(get("forge").range, maven("[14.23.5.2779,)"));
    assert_eq!(get("early").kind, DependencyKind::Required);
    assert_eq!(get("later").kind, DependencyKind::Optional);
    assert_eq!(get("later").range, maven("[2,)"));
    assert_eq!(get("jei").kind, DependencyKind::Optional);
    assert_eq!(get("plain").kind, DependencyKind::Required);
    assert_eq!(get("render").kind, DependencyKind::Required);
    assert_eq!(get("render").side.as_deref(), Some("CLIENT"));
    assert_eq!(get("clientopt").kind, DependencyKind::Optional);
    assert_eq!(get("clientopt").side.as_deref(), Some("CLIENT"));
    assert_eq!(get("srv").side.as_deref(), Some("SERVER"));
    assert_eq!(get("range").range, maven("(,3]"));
    assert!(d.iter().all(|x| x.mod_id != "*"), "`*` is ordering only");
    assert_eq!(d.len(), 9);

    // Invalid entries are dropped, the rest kept.
    let d = parse_dependency_string("bogus:a;required:;:b;after-before:c;client-server-required:d;required-after;x:y:z;after:ok;required-after:*;after:*@[1,)");
    assert_eq!(d.iter().map(|x| x.mod_id.as_str()).collect::<Vec<_>>(), vec!["ok"]);
    assert!(parse_dependency_string("").is_empty());
    // A later required entry upgrades an optional one; a later optional one does not downgrade.
    let d = parse_dependency_string("after:x;required-after:x@[2,);after:x@[9,)");
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].kind, DependencyKind::Required);
    assert_eq!(d[0].range, maven("[2,)"));
    // `modid@` with an empty range = any version.
    assert_eq!(parse_dependency_string("required-after:y@")[0].range, any());
}

#[test]
fn malformed_class_files_never_break_the_scan() {
    let good = mod_class("a/M", &[("modid", "m")], &[]);
    let mut b = JarBuilder::new().file("a/M.class", &good);
    // Truncated copies of a real @Mod class, plus garbage that contains the descriptor.
    for n in [0usize, 4, 9, 30, good.len() / 2, good.len() - 1] {
        b = b.file(&format!("bad/T{n}.class"), &good[..n]);
    }
    let mut garbage = vec![0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52, 0xFF, 0xFF];
    garbage.extend_from_slice(DESC.as_bytes());
    b = b.file("bad/G.class", &garbage).file("bad/Empty.class", b"");
    let (r, issues) = run(b);
    assert_eq!(r.status, JarStatus::Ok, "{:?}", r.status);
    assert!(issues.is_empty(), "{issues:?}");
    assert_eq!(r.mods.iter().map(|m| m.mod_id.as_str()).collect::<Vec<_>>(), vec!["m"]);
}

#[test]
fn only_jars_legacy_fml_searches() {
    let class = mod_class("a/M", &[("modid", "m")], &[]);
    // A 1.13+ / Fabric / Quilt jar: never searched.
    let (r, _) = run(JarBuilder::new().mods_toml("[[mods]]\nmodId=\"modern\"\nversion=\"1\"\n").file("a/M.class", &class));
    assert_eq!(r.mods.iter().map(|m| m.mod_id.as_str()).collect::<Vec<_>>(), vec!["modern"]);
    let (r, _) = run(JarBuilder::new().fabric_mod_json(r#"{"id":"fab","version":"1"}"#).file("a/M.class", &class));
    assert_eq!(r.mods.len(), 1);
    // Coremod / tweaker jars FML keeps out of mod discovery…
    for attr in ["FMLCorePlugin: a.Plugin", "TweakClass: org.spongepowered.asm.launch.MixinTweaker"] {
        let (r, _) = run(JarBuilder::new().file("META-INF/MANIFEST.MF", format!("Manifest-Version: 1.0\n{attr}\n")).file("a/M.class", &class));
        assert!(r.mods.is_empty(), "{attr}: {:?}", r.mods);
    }
    // …unless the manifest says they contain a mod.
    let manifest = "Manifest-Version: 1.0\nFMLCorePlugin: a.Plugin\nFMLCorePluginContainsFMLMod: true\n";
    let (r, _) = run(JarBuilder::new().file("META-INF/MANIFEST.MF", manifest).file("a/M.class", &class));
    assert_eq!(r.mods.len(), 1);
    // Nested jars are not searched (legacy FML does not load jar-in-jar mods this way).
    let (mut out, mut issues) = (Vec::new(), Vec::new());
    scan_into(&ctx(1), &JarBuilder::new().file("a/M.class", &class).build(), &mut Budget::new(DEFAULT_LIMITS), &mut out, &mut issues);
    assert!(out[0].mods.is_empty());
}

const API: &str = "Lnet/minecraftforge/fml/common/API;";
const DUMMY: &str = "net/minecraftforge/fml/common/DummyModContainer";

#[test]
fn api_package_provides_its_id() {
    // RTG: `rtg/api/package-info.class` carries @API(owner="rtg", provides="rtgapi").
    let api = build_class("rtg/api/package-info", API, &[("owner", "rtg"), ("provides", "rtgapi"), ("apiVersion", "6.1")], &[], true);
    let (r, _) = run(
        JarBuilder::new()
            .file("rtg/RTG.class", mod_class("rtg/RTG", &[("modid", "rtg"), ("dependencies", "required-after:rtgapi")], &[]))
            .file("rtg/api/package-info.class", &api),
    );
    assert_eq!(r.mods.len(), 1, "an API is never its own entry: {:?}", r.mods);
    let m = &r.mods[0];
    assert_eq!(m.provides, vec!["rtgapi"]);
    assert!(m.metadata_excerpt.contains(r#"also provides "rtgapi""#), "{}", m.metadata_excerpt);
    // No owner match: the first legacy entry gets it (here an mcmod.info one, excerpt untouched).
    let lib_api = build_class("baubles/api/package-info", API, &[("owner", "baubles"), ("provides", "Baubles|API")], &[], true);
    let (r, _) = run(JarBuilder::new().mcmod_info(r#"[{"modid":"fantasticlib","version":"1"}]"#).file("baubles/api/package-info.class", &lib_api));
    assert_eq!(r.mods[0].provides, vec!["Baubles|API"]);
    assert!(!r.mods[0].metadata_excerpt.contains("also provides"));
    // A jar with no legacy entry: nothing to attach to (known gap), and no entry is invented.
    let (r, _) = run(JarBuilder::new().file("baubles/api/package-info.class", &lib_api));
    assert!(r.mods.is_empty());
}

#[test]
fn coremod_container_ids() {
    // IvToolkit: coremod (no FMLCorePluginContainsFMLMod), mcmod.info says "IvToolkit", the
    // container registers "ivtoolkit"; its @Mod class is ignored (FML skips the jar for mods).
    let container = build_container_class("ivorius/ivtoolkit/IvToolkitCoreContainer", DUMMY, &[("modId", "ivtoolkit"), ("version", "1.3.3")]);
    let ignored_mod = mod_class("ivorius/ivtoolkit/IvToolkit", &[("modid", "ignored")], &[]);
    let (r, issues) = run(
        JarBuilder::new()
            .file("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\nFMLCorePlugin: ivorius.ivtoolkit.IvToolkitLoadingPlugin\n")
            .mcmod_info(r#"[{"modid":"IvToolkit","version":"1.3.3"}]"#)
            .file("ivorius/ivtoolkit/IvToolkitCoreContainer.class", &container)
            .file("ivorius/ivtoolkit/IvToolkit.class", &ignored_mod),
    );
    assert!(issues.is_empty(), "{issues:?}");
    assert_eq!(r.mods.iter().map(|m| m.mod_id.as_str()).collect::<Vec<_>>(), vec!["IvToolkit", "ivtoolkit"]);
    let c = by_id(&r, "ivtoolkit");
    assert_eq!(c.version, "1.3.3");
    assert_eq!(c.loader, LoaderKind::Legacyforge);
    assert!(c.deps.is_empty() && c.mc_range.is_none());
    assert_eq!(c.metadata_file, "ivorius/ivtoolkit/IvToolkitCoreContainer.class");
    assert!(c.metadata_excerpt.contains("DummyModContainer"), "{}", c.metadata_excerpt);

    // TNT Utilities: coremod that also holds a mod → both the @Mod and the container count.
    let tntu = mod_class("ljfa/tntutils/TNTUtils", &[("modid", "tnt_utilities"), ("dependencies", "required-after:tnt_utilities_core")], &[]);
    let core = build_container_class("ljfa/tntutils/asm/TntuCoremodContainer", DUMMY, &[("modId", "tnt_utilities_core")]);
    let manifest = "Manifest-Version: 1.0\nFMLCorePluginContainsFMLMod: true\nFMLCorePlugin: ljfa.tntutils.asm.TntuPlugin\n";
    let (r, _) = run(JarBuilder::new().file("META-INF/MANIFEST.MF", manifest).file("ljfa/tntutils/TNTUtils.class", &tntu).file("ljfa/tntutils/asm/TntuCoremodContainer.class", &core));
    assert_eq!(r.mods.iter().map(|m| m.mod_id.as_str()).collect::<Vec<_>>(), vec!["tnt_utilities", "tnt_utilities_core"]);
    assert_eq!(by_id(&r, "tnt_utilities_core").version, "", "no literal version: unknown");

    // A container id the jar already declares is not repeated.
    let (r, _) = run(
        JarBuilder::new()
            .file("META-INF/MANIFEST.MF", manifest)
            .file("a/M.class", mod_class("a/M", &[("modid", "same")], &[]))
            .file("a/C.class", build_container_class("a/C", DUMMY, &[("modId", "same")])),
    );
    assert_eq!(r.mods.len(), 1);
    assert_eq!(r.mods[0].metadata_file, "a/M.class");
    // Not a coremod: FML never instantiates the container, so it is ignored.
    let (r, _) = run(JarBuilder::new().file("a/C.class", build_container_class("a/C", DUMMY, &[("modId", "nope")])));
    assert!(r.mods.is_empty());
}

fn small(limits: Limits) -> Limits {
    Limits { class_cap: 2_000, class_budget: 100_000, max_class_reads: 1_000, max_mod_annotations: 64, ..limits }
}

#[test]
fn oversized_class_is_skipped() {
    let mut big = mod_class("a/Big", &[("modid", "big")], &[]);
    big.extend(std::iter::repeat_n(0u8, 3_000)); // trailing bytes: still a valid @Mod class
    let ok = mod_class("a/Ok", &[("modid", "ok")], &[]);
    let (r, issues) = run_with(JarBuilder::new().file("a/Big.class", &big).file("a/Ok.class", &ok), small(DEFAULT_LIMITS));
    assert_eq!(r.mods.iter().map(|m| m.mod_id.as_str()).collect::<Vec<_>>(), vec!["ok"]);
    assert!(issues.is_empty(), "{issues:?}");
    // Under the default 512 KiB cap the padded class is read.
    let (r, _) = run(JarBuilder::new().file("a/Big.class", &big));
    assert_eq!(r.mods.len(), 1);
}

#[test]
fn class_budget_stops_the_search_outer_classes_first() {
    let filler = |i: usize| mod_class(&format!("z/F{i}$Inner"), &[], &[]);
    let mut b = JarBuilder::new();
    for i in 0..20 {
        b = b.file(&format!("a/F{i}$Inner.class"), filler(i));
    }
    // Listed after the inner classes, but outer classes are searched first.
    b = b.file("z/Main.class", mod_class("z/Main", &[("modid", "main")], &[]));
    let one = filler(0).len() as u64;
    let limits = Limits { class_budget: one * 3, ..small(DEFAULT_LIMITS) };
    let (r, issues) = run_with(b, limits);
    assert_eq!(r.mods.iter().map(|m| m.mod_id.as_str()).collect::<Vec<_>>(), vec!["main"]);
    assert_eq!(issues.len(), 1, "{issues:?}");
    assert!(issues[0].message.contains("@Mod") && issues[0].message.contains("unpack to more than"), "{}", issues[0].message);
    assert_eq!(r.packages, vec!["a", "z"], "packages still come from every entry name");
    assert_eq!(r.max_class_major, Some(52), "sampled classes the search skipped are read for their header");
}

#[test]
fn class_read_and_annotation_count_limits() {
    let mut b = JarBuilder::new();
    for i in 0..5 {
        b = b.file(&format!("a/M{i}.class"), mod_class(&format!("a/M{i}"), &[("modid", &format!("m{i}"))], &[]));
    }
    let (r, issues) = run_with(b.clone(), Limits { max_mod_annotations: 2, ..small(DEFAULT_LIMITS) });
    assert_eq!(r.mods.len(), 2);
    assert_eq!(issues.len(), 1, "{issues:?}");
    assert!(issues[0].message.contains("limit of 2 @Mod"), "{}", issues[0].message);
    let (r, issues) = run_with(b, Limits { max_class_reads: 3, ..small(DEFAULT_LIMITS) });
    assert_eq!(r.mods.len(), 3);
    assert!(issues[0].message.contains("more than 3 class files"), "{}", issues[0].message);
}
