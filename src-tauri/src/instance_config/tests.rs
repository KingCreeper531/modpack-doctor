use std::fs;
use std::path::{Path, PathBuf};

use super::*;

struct Fixture {
    _tmp: tempfile::TempDir,
    game: PathBuf,
    guard: PathGuard,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().expect("tempdir");
    let game = dunce::canonicalize(tmp.path()).expect("canon");
    fs::create_dir_all(game.join("config")).expect("mkdir");
    let guard = PathGuard::new();
    guard.add_root(&game).expect("root");
    Fixture { _tmp: tmp, game, guard }
}

fn write(game: &Path, rel: &str, contents: impl AsRef<[u8]>) {
    fs::write(game.join(rel), contents).expect("write");
}

fn read(f: &Fixture) -> (Option<LoaderConfig>, Vec<ScanIssue>) {
    read_loader_config(&f.game, &f.guard)
}

fn ov(mod_id: &str, entries: &[&str]) -> FmlDependencyOverride {
    FmlDependencyOverride { mod_id: mod_id.into(), entries: entries.iter().map(|s| s.to_string()).collect() }
}

/// What NeoForge 21.1 writes by default, plus nothing else.
const DEFAULT_FML_TOML: &str = r#"#Disables File Watcher.
disableConfigWatcher = false
earlyWindowControl = true
maxThreads = -1
#dependencyOverrides.targetMod = ["-dep1", "+dep2"]
dependencyOverrides = {}
"#;

#[test]
fn missing_files_give_nothing_and_no_issues() {
    let f = fixture();
    assert_eq!(read(&f), (None, Vec::new()));
    // No config folder at all.
    fs::remove_dir(f.game.join("config")).expect("rmdir");
    assert_eq!(read(&f), (None, Vec::new()));
}

#[test]
fn default_fml_toml_has_no_overrides() {
    let f = fixture();
    write(&f.game, FML_TOML, DEFAULT_FML_TOML);
    let (cfg, issues) = read(&f);
    assert!(issues.is_empty(), "{issues:?}");
    let cfg = cfg.expect("config");
    assert_eq!(cfg.source_files, vec![FML_TOML.to_string()]);
    assert!(cfg.fml_dependency_overrides.is_empty());
    assert_eq!(cfg.connector, None);
}

#[test]
fn fml_overrides_in_every_toml_form() {
    let mut issues = Vec::new();
    // Dotted keys, as in FML's own comment; a single string; quoted key.
    let dotted = r#"
dependencyOverrides.zeta = ["-create", "+jei"]
dependencyOverrides.alpha = "-minecraft"
dependencyOverrides."odd-id" = []
"#;
    assert_eq!(parse_fml_toml(dotted, &mut issues), vec![ov("alpha", &["-minecraft"]), ov("zeta", &["-create", "+jei"])]);
    // Table header.
    let table = "maxThreads = -1\n[dependencyOverrides]\nmymod = [\"-neoforge\", \"-curios\"]\n";
    assert_eq!(parse_fml_toml(table, &mut issues), vec![ov("mymod", &["-neoforge", "-curios"])]);
    // Inline table; entries without a prefix are kept raw (src/core ignores them, like FML).
    let inline = "dependencyOverrides = { mymod = [\"curios\", \"-jei\", \"\"] }\n";
    assert_eq!(parse_fml_toml(inline, &mut issues), vec![ov("mymod", &["curios", "-jei", ""])]);
    assert!(issues.is_empty(), "{issues:?}");
}

#[test]
fn broken_fml_toml_is_an_issue_not_a_failure() {
    let f = fixture();
    write(&f.game, FML_TOML, "dependencyOverrides = { mymod = [\"-jei\" }\n");
    let (cfg, issues) = read(&f);
    let cfg = cfg.expect("file exists");
    assert_eq!(cfg.source_files, vec![FML_TOML.to_string()]);
    assert!(cfg.fml_dependency_overrides.is_empty());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].subject, FML_TOML);
    assert!(issues[0].message.starts_with("is not valid TOML"), "{}", issues[0].message);
    assert!(!issues[0].message.contains(&f.game.display().to_string()), "no absolute path");
}

#[test]
fn wrong_shapes_in_fml_toml() {
    let mut issues = Vec::new();
    assert!(parse_fml_toml("dependencyOverrides = \"-jei\"\n", &mut issues).is_empty());
    assert!(issues[0].message.contains("not a table"), "{issues:?}");

    let mut issues = Vec::new();
    let got = parse_fml_toml("dependencyOverrides.a = [\"-x\", 3, \"+y\"]\ndependencyOverrides.b = 7\n", &mut issues);
    assert_eq!(got, vec![ov("a", &["-x", "+y"])]);
    assert_eq!(issues.len(), 2, "{issues:?}");
    assert!(issues.iter().all(|i| i.message.contains("not a string")));
}

#[test]
fn byte_order_mark_is_accepted() {
    let f = fixture();
    write(&f.game, FML_TOML, "\u{feff}dependencyOverrides.a = \"-b\"\n");
    let (cfg, issues) = read(&f);
    assert!(issues.is_empty(), "{issues:?}");
    assert_eq!(cfg.expect("config").fml_dependency_overrides, vec![ov("a", &["-b"])]);
}

#[test]
fn oversized_and_non_utf8_files_are_not_read() {
    let f = fixture();
    let mut big = String::from("dependencyOverrides.a = \"-b\"\n");
    big.push_str(&"#".repeat(MAX_CONFIG_BYTES as usize));
    write(&f.game, FML_TOML, big);
    write(&f.game, CONNECTOR_JSON, [0x7b, 0xff, 0xfe, 0x7d]);
    let (cfg, issues) = read(&f);
    let cfg = cfg.expect("files exist");
    assert_eq!(cfg.source_files, vec![FML_TOML.to_string(), CONNECTOR_JSON.to_string()]);
    assert!(cfg.fml_dependency_overrides.is_empty());
    assert_eq!(cfg.connector, None);
    assert_eq!(issues.len(), 2, "{issues:?}");
    assert!(issues[0].message.contains("larger than 256 KiB"), "{issues:?}");
    assert!(issues[1].message.contains("not UTF-8"), "{issues:?}");
}

#[test]
fn exactly_the_cap_is_read() {
    let f = fixture();
    let head = "dependencyOverrides.a = \"-b\"\n";
    let pad = MAX_CONFIG_BYTES as usize - head.len();
    write(&f.game, FML_TOML, format!("{head}{}", "#".repeat(pad)));
    let (cfg, issues) = read(&f);
    assert!(issues.is_empty(), "{issues:?}");
    assert_eq!(cfg.expect("config").fml_dependency_overrides, vec![ov("a", &["-b"])]);
}

#[test]
fn a_folder_named_like_the_file_is_an_issue() {
    let f = fixture();
    fs::create_dir_all(f.game.join(FML_TOML)).expect("mkdir");
    let (cfg, issues) = read(&f);
    assert_eq!(cfg.expect("listed").source_files, vec![FML_TOML.to_string()]);
    assert!(issues[0].message.contains("not a regular file"), "{issues:?}");
}

#[test]
fn files_outside_the_guard_roots_are_not_read() {
    let f = fixture();
    write(&f.game, FML_TOML, "dependencyOverrides.a = \"-b\"\n");
    let empty = PathGuard::new();
    let (cfg, issues) = read_loader_config(&f.game, &empty);
    assert!(cfg.expect("listed").fml_dependency_overrides.is_empty());
    assert_eq!(issues.len(), 1);
    assert!(issues[0].message.contains("outside the folders"), "{issues:?}");
}

#[test]
fn default_connector_json() {
    let f = fixture();
    // Exactly what Connector 1.21.x writes when the file is missing.
    write(
        &f.game,
        CONNECTOR_JSON,
        r#"{
  "version": 1,
  "hiddenMods": [],
  "globalModAliases": {
    "playeranimator": "player-animator",
    "cloth_config": "cloth-config2"
  },
  "enableMixinSafeguard": true
}"#,
    );
    let (cfg, issues) = read(&f);
    assert!(issues.is_empty(), "{issues:?}");
    let cfg = cfg.expect("config");
    assert_eq!(cfg.source_files, vec![CONNECTOR_JSON.to_string()]);
    assert_eq!(
        cfg.connector,
        Some(ConnectorConfigFile {
            hidden_mods: Some(vec![]),
            global_mod_aliases: Some(vec![
                ConnectorAlias { mod_id: "cloth_config".into(), aliases: vec!["cloth-config2".into()] },
                ConnectorAlias { mod_id: "playeranimator".into(), aliases: vec!["player-animator".into()] },
            ]),
            invalid_fields: vec![],
        })
    );
}

#[test]
fn connector_json_shapes() {
    let mut issues = Vec::new();
    let got = parse_connector_json(r#"{"hiddenMods":["jei","emi"],"globalModAliases":{"a":["b","c"]}}"#, &mut issues).expect("object");
    assert_eq!(got.hidden_mods, Some(vec!["jei".into(), "emi".into()]));
    assert_eq!(got.global_mod_aliases, Some(vec![ConnectorAlias { mod_id: "a".into(), aliases: vec!["b".into(), "c".into()] }]));
    assert!(issues.is_empty());

    // Absent fields stay None (src/core decides what Connector does then).
    let got = parse_connector_json("{}", &mut issues).expect("object");
    assert_eq!((got.hidden_mods, got.global_mod_aliases, got.invalid_fields.len()), (None, None, 0));

    let got = parse_connector_json(
        r#"{"version":2,"hiddenMods":"jei","globalModAliases":{"a":1},"enableMixinSafeguard":"yes"}"#,
        &mut issues,
    )
    .expect("object");
    assert_eq!(got.invalid_fields, vec!["enableMixinSafeguard", "globalModAliases", "hiddenMods", "version"]);
    assert_eq!((got.hidden_mods, got.global_mod_aliases), (None, None));
    assert_eq!(issues.len(), 1);
    assert!(issues[0].message.contains("does not accept"), "{issues:?}");

    let mut issues = Vec::new();
    assert_eq!(parse_connector_json("[1]", &mut issues), None);
    assert_eq!(parse_connector_json("{\"version\": 1,", &mut issues), None);
    assert_eq!(issues.len(), 2, "{issues:?}");
    assert!(issues[1].message.starts_with("is not valid JSON"), "{issues:?}");
}

#[test]
fn attach_sets_field_and_keeps_issue_order() {
    let f = fixture();
    write(&f.game, FML_TOML, "dependencyOverrides = 3\n");
    write(&f.game, CONNECTOR_JSON, "{\"hiddenMods\":[\"jei\"]}");
    let mut res = ScanResult {
        instance_id: "x".into(),
        started_at_ms: 0,
        duration_ms: 0,
        jars: vec![],
        declared: vec![],
        unverified_downloads: vec![],
        issues: vec![ScanIssue { subject: "mods/z.jar".into(), message: "m".into() }],
        loader_config: None,
    };
    attach(&mut res, &f.game, &f.guard);
    let subjects: Vec<&str> = res.issues.iter().map(|i| i.subject.as_str()).collect();
    assert_eq!(subjects, vec![FML_TOML, "mods/z.jar"]);
    let cfg = res.loader_config.clone().expect("set");
    assert_eq!(cfg.connector.and_then(|c| c.hidden_mods), Some(vec!["jei".to_string()]));

    // The field is omitted from JSON when absent, and camelCase when present.
    let mut empty = res.clone();
    empty.loader_config = None;
    let json = serde_json::to_value(&empty).expect("json");
    assert!(json.get("loaderConfig").is_none());
    let back: ScanResult = serde_json::from_value(json).expect("round trip without the field");
    assert_eq!(back.loader_config, None);
}
