use std::collections::HashSet;
use std::fs;

use serde_json::json;

use super::*;
use crate::model::{GridSort, LoaderInfo, LoaderKind, Side, ThemePref};

const ID: &str = "0123456789abcdef";
const OTHER_ID: &str = "fedcba9876543210";

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => panic!("not an object"),
    }
}

fn abs(t: &tempfile::TempDir, name: &str) -> String {
    t.path().join(name).display().to_string()
}

fn known(ids: &[&str]) -> HashSet<String> {
    ids.iter().map(|s| s.to_string()).collect()
}

fn ov(mc: &str) -> PackOverride {
    PackOverride { mc_version: Some(mc.into()), loader: None, side: None }
}

#[test]
fn decode_missing_fields_take_defaults() {
    let d = decode(&Map::new());
    assert_eq!(d.settings, Settings::default());
    assert!(!d.lossy());
    let d = decode(&obj(json!({ "theme": "light", "includeBeta": true })));
    assert_eq!(d.settings.theme, ThemePref::Light);
    assert!(d.settings.include_beta);
    assert!(d.settings.modrinth_enabled, "missing field keeps its default");
    assert!(!d.lossy());
}

#[test]
fn decode_ignores_but_preserves_unknown_keys() {
    let d = decode(&obj(json!({ "gridSort": "severity", "futureFeature": { "x": 1 } })));
    assert_eq!(d.settings.grid_sort, GridSort::Severity);
    assert!(!d.lossy());
    assert_eq!(d.extra.get("futureFeature"), Some(&json!({ "x": 1 })));
    let out = encode(&d.settings, &d.extra).expect("encode");
    assert_eq!(out.get("futureFeature"), Some(&json!({ "x": 1 })));
    assert_eq!(out.get("gridSort"), Some(&json!("severity")));
    // Every Settings field is written.
    for k in KNOWN_KEYS {
        assert!(out.contains_key(*k), "missing {k}");
    }
}

#[test]
fn decode_resets_invalid_fields_and_drops_invalid_entries() {
    let t = tempfile::tempdir().expect("tempdir");
    let good = abs(&t, "Pack ü");
    let doc = obj(json!({
        "theme": "purple",
        "modrinthEnabled": "yes",
        "inspectorWidth": 9999,
        "manualFolders": ["relative/folder", good, good, 42],
        "launcherRoots": [
            { "launcher": "manual", "path": good },
            { "launcher": "prism", "path": good },
            { "launcher": "nope", "path": good },
        ],
        "watched": ["zz", ID, ID],
        "overrides": {
            "not-an-id": { "mcVersion": "1.20.1", "loader": null, "side": null },
            ID: { "mcVersion": " 1.21.1 ", "loader": { "kind": "fabric", "version": "" }, "side": "server" },
            OTHER_ID: "garbage",
        },
    }));
    let d = decode(&doc);
    let s = &d.settings;
    assert_eq!(s.theme, ThemePref::System);
    assert!(s.modrinth_enabled);
    assert_eq!(s.inspector_width, INSPECTOR_WIDTH_MAX);
    assert_eq!(s.manual_folders, vec![good.clone()]);
    assert_eq!(s.launcher_roots, vec![LauncherRoot { launcher: Launcher::Prism, path: good.clone() }]);
    assert_eq!(s.watched, vec![ID.to_string()]);
    assert_eq!(s.overrides.len(), 1);
    let o = &s.overrides[ID];
    assert_eq!(o.mc_version.as_deref(), Some("1.21.1"));
    assert_eq!(o.loader, Some(LoaderInfo { kind: LoaderKind::Fabric, version: None }));
    assert_eq!(o.side, Some(Side::Server));
    assert!(d.lossy());
    assert!(d.problems.len() >= 7, "{:?}", d.problems);
}

#[test]
fn decode_clamps_small_width_without_flagging_loss() {
    let d = decode(&obj(json!({ "inspectorWidth": 10 })));
    assert_eq!(d.settings.inspector_width, INSPECTOR_WIDTH_MIN);
    assert!(!d.lossy());
}

#[test]
fn corrupt_file_falls_back_to_defaults_and_keeps_a_backup() {
    let t = tempfile::tempdir().expect("tempdir");
    let path = t.path().join(SETTINGS_FILE);
    fs::write(&path, b"{ \"theme\": \"dark\", oops").expect("write");
    let (svc, log) = SettingsService::load(Box::new(FileStore::new(&path)));
    assert_eq!(svc.get(), Settings::default());
    assert!(log.iter().any(|l| l.contains("not valid JSON")), "{log:?}");
    assert_eq!(fs::read(backup_path(&path)).expect("bak"), b"{ \"theme\": \"dark\", oops");
    // The file was rewritten with valid defaults.
    let again = FileStore::new(&path).read().expect("read");
    assert!(matches!(again, RawDoc::Doc(ref m) if decode(m).settings == Settings::default()));
}

#[test]
fn non_object_json_is_corrupt() {
    assert!(matches!(parse_bytes(b"[1, 2]"), RawDoc::Corrupt(_)));
    assert!(matches!(parse_bytes(b"null"), RawDoc::Corrupt(_)));
    assert!(matches!(parse_bytes(b"{}"), RawDoc::Doc(_)));
}

#[test]
fn lossy_decode_backs_up_and_rewrites() {
    let t = tempfile::tempdir().expect("tempdir");
    let path = t.path().join(SETTINGS_FILE);
    let original = r#"{"theme":"dark","gridSort":"chaos","future":true}"#;
    fs::write(&path, original).expect("write");
    let (svc, _) = SettingsService::load(Box::new(FileStore::new(&path)));
    assert_eq!(svc.get().theme, ThemePref::Dark);
    assert_eq!(svc.get().grid_sort, GridSort::Name);
    assert_eq!(fs::read_to_string(backup_path(&path)).expect("bak"), original);
    let RawDoc::Doc(m) = FileStore::new(&path).read().expect("read") else { panic!("not a doc") };
    assert_eq!(m.get("gridSort"), Some(&json!("name")));
    assert_eq!(m.get("future"), Some(&json!(true)), "unknown keys survive the rewrite");
}

#[test]
fn clean_file_is_not_rewritten_or_backed_up() {
    let t = tempfile::tempdir().expect("tempdir");
    let path = t.path().join(SETTINGS_FILE);
    fs::write(&path, r#"{"theme":"light"}"#).expect("write");
    let (svc, log) = SettingsService::load(Box::new(FileStore::new(&path)));
    assert_eq!(svc.get().theme, ThemePref::Light);
    assert!(log.is_empty(), "{log:?}");
    assert!(!backup_path(&path).exists());
    assert_eq!(fs::read_to_string(&path).expect("read"), r#"{"theme":"light"}"#);
}

#[test]
fn missing_file_uses_defaults_without_writing() {
    let t = tempfile::tempdir().expect("tempdir");
    let path = t.path().join("sub").join(SETTINGS_FILE);
    let (svc, log) = SettingsService::load(Box::new(FileStore::new(&path)));
    assert_eq!(svc.get(), Settings::default());
    assert!(log.is_empty());
    assert!(!path.exists());
}

#[test]
fn persistence_round_trip() {
    let t = tempfile::tempdir().expect("tempdir");
    let path = t.path().join("nested").join(SETTINGS_FILE);
    let (svc, _) = SettingsService::load(Box::new(FileStore::new(&path)));
    let patch = SettingsPatch {
        theme: Some(ThemePref::Light),
        overrides: Some([(ID.to_string(), Some(ov("1.20.1")))].into_iter().collect()),
        modrinth_enabled: Some(false),
        include_beta: Some(true),
        grid_sort: Some(GridSort::Severity),
        inspector_width: Some(500),
        auto_check_updates: Some(true),
    };
    let (saved, ()) = svc.update(|s| apply_patch(s, patch, &known(&[ID]), &HashSet::new())).expect("update");
    let (reloaded, log) = SettingsService::load(Box::new(FileStore::new(&path)));
    assert!(log.is_empty(), "{log:?}");
    assert_eq!(reloaded.get(), saved);
    assert_eq!(saved.inspector_width, 500);
    assert_eq!(saved.overrides[ID], ov("1.20.1"));
    assert!(!saved.modrinth_enabled);
    assert!(saved.auto_check_updates);
}

#[test]
fn auto_check_updates_is_off_by_default() {
    assert!(!Settings::default().auto_check_updates);
    let d = decode(&Map::new());
    assert!(!d.settings.auto_check_updates);
}

#[test]
fn settings_stored_before_auto_check_updates_load_with_it_off() {
    // A settings.json written by 0.1.x: every field of its day, but no `autoCheckUpdates`.
    let t = tempfile::tempdir().expect("tempdir");
    let path = t.path().join(SETTINGS_FILE);
    let old = json!({
        "theme": "dark",
        "manualFolders": [],
        "launcherRoots": [],
        "watched": [],
        "overrides": {},
        "modrinthEnabled": true,
        "includeBeta": true,
        "gridSort": "severity",
        "inspectorWidth": 400
    });
    fs::write(&path, serde_json::to_vec_pretty(&old).expect("json")).expect("write");
    let (svc, log) = SettingsService::load(Box::new(FileStore::new(&path)));
    assert!(log.is_empty(), "a missing field is not a problem: {log:?}");
    let s = svc.get();
    assert!(!s.auto_check_updates);
    assert_eq!((s.theme, s.include_beta, s.grid_sort, s.inspector_width), (ThemePref::Dark, true, GridSort::Severity, 400));
    // Loading does not rewrite the file (nothing was lost).
    assert!(!backup_path(&path).exists());
    let stored: Value = serde_json::from_slice(&fs::read(&path).expect("read")).expect("json");
    assert_eq!(stored, old);
    // The next change writes the field.
    svc.update(|s| apply_patch(s, SettingsPatch { theme: Some(ThemePref::Light), ..Default::default() }, &HashSet::new(), &HashSet::new()))
        .expect("update");
    let stored: Value = serde_json::from_slice(&fs::read(&path).expect("read")).expect("json");
    assert_eq!(stored["autoCheckUpdates"], json!(false));
}

#[test]
fn auto_check_updates_patch_and_round_trip() {
    let t = tempfile::tempdir().expect("tempdir");
    let path = t.path().join(SETTINGS_FILE);
    let (svc, _) = SettingsService::load(Box::new(FileStore::new(&path)));
    let none = HashSet::new();
    // Turning it on persists it.
    let (on, ()) = svc
        .update(|s| apply_patch(s, SettingsPatch { auto_check_updates: Some(true), ..Default::default() }, &none, &none))
        .expect("on");
    assert!(on.auto_check_updates);
    let (reloaded, log) = SettingsService::load(Box::new(FileStore::new(&path)));
    assert!(log.is_empty(), "{log:?}");
    assert!(reloaded.get().auto_check_updates);
    // A patch without the field leaves it alone.
    let (same, ()) = reloaded
        .update(|s| apply_patch(s, SettingsPatch { include_beta: Some(true), ..Default::default() }, &none, &none))
        .expect("other");
    assert!(same.auto_check_updates);
    // Turning it off persists too.
    reloaded
        .update(|s| apply_patch(s, SettingsPatch { auto_check_updates: Some(false), ..Default::default() }, &none, &none))
        .expect("off");
    assert!(!SettingsService::load(Box::new(FileStore::new(&path))).0.get().auto_check_updates);
    // An invalid stored value falls back to off (and is reported).
    let d = decode(&obj(json!({ "autoCheckUpdates": "yes" })));
    assert!(!d.settings.auto_check_updates);
    assert!(d.lossy());
    // The IPC patch accepts the camelCase key, and omits nothing else.
    let p: SettingsPatch = serde_json::from_value(json!({ "autoCheckUpdates": true })).expect("patch");
    assert_eq!(p, SettingsPatch { auto_check_updates: Some(true), ..Default::default() });
}

#[test]
fn apply_patch_clamps_inspector_width() {
    let mut s = Settings::default();
    let none = HashSet::new();
    apply_patch(&mut s, SettingsPatch { inspector_width: Some(100), ..Default::default() }, &none, &HashSet::new()).expect("ok");
    assert_eq!(s.inspector_width, 280);
    apply_patch(&mut s, SettingsPatch { inspector_width: Some(10_000), ..Default::default() }, &none, &HashSet::new()).expect("ok");
    assert_eq!(s.inspector_width, 640);
    apply_patch(&mut s, SettingsPatch { inspector_width: Some(420), ..Default::default() }, &none, &HashSet::new()).expect("ok");
    assert_eq!(s.inspector_width, 420);
}

#[test]
fn apply_patch_rejects_overrides_for_unknown_instances_atomically() {
    let mut s = Settings::default();
    let patch = SettingsPatch {
        theme: Some(ThemePref::Dark),
        overrides: Some([(ID.to_string(), Some(ov("1.20.1"))), (OTHER_ID.to_string(), Some(ov("1.21")))].into_iter().collect()),
        ..Default::default()
    };
    let err = apply_patch(&mut s, patch, &known(&[ID]), &HashSet::new()).expect_err("unknown id");
    assert!(matches!(err, Error::Invalid(ref m) if m.contains(OTHER_ID)), "{err}");
    assert_eq!(s, Settings::default(), "nothing applied on error");
}

#[test]
fn apply_patch_refuses_overrides_for_opened_packs_atomically() {
    let mut s = Settings::default();
    s.overrides.insert(OTHER_ID.into(), ov("1.20.1"));
    let before = s.clone();
    let patch = SettingsPatch {
        theme: Some(ThemePref::Dark),
        overrides: Some([(ID.to_string(), Some(ov("1.21")))].into_iter().collect()),
        ..Default::default()
    };
    // Known (opened packs are in the registry) but session-only.
    let err = apply_patch(&mut s, patch, &known(&[ID, OTHER_ID]), &known(&[OTHER_ID, ID])).expect_err("pack");
    assert!(matches!(err, Error::Invalid(ref m) if m.starts_with("Pack identity overrides for an opened .mrpack are not saved")), "{err}");
    assert_eq!(s, before, "nothing applied on error");
    // Removing one (e.g. an override saved by an older build) is still allowed.
    let patch = SettingsPatch { overrides: Some([(OTHER_ID.to_string(), None)].into_iter().collect()), ..Default::default() };
    apply_patch(&mut s, patch, &known(&[OTHER_ID]), &known(&[OTHER_ID])).expect("removal");
    assert!(s.overrides.is_empty());
    // Other instances are unaffected.
    let patch = SettingsPatch { overrides: Some([(ID.to_string(), Some(ov("1.21")))].into_iter().collect()), ..Default::default() };
    apply_patch(&mut s, patch, &known(&[ID, OTHER_ID]), &known(&[OTHER_ID])).expect("folder instance");
    assert!(s.overrides.contains_key(ID));
}

#[test]
fn apply_patch_null_removes_override_even_for_unknown_instance() {
    let mut s = Settings::default();
    s.overrides.insert(ID.into(), ov("1.20.1"));
    s.overrides.insert(OTHER_ID.into(), ov("1.21"));
    let patch = SettingsPatch { overrides: Some([(ID.to_string(), None)].into_iter().collect()), ..Default::default() };
    apply_patch(&mut s, patch, &HashSet::new(), &HashSet::new()).expect("removal needs no known id");
    assert!(!s.overrides.contains_key(ID));
    assert!(s.overrides.contains_key(OTHER_ID), "other overrides untouched");
}

#[test]
fn apply_patch_normalises_and_bounds_override_versions() {
    let mut s = Settings::default();
    let k = known(&[ID]);
    let blank = PackOverride {
        mc_version: Some("   ".into()),
        loader: Some(LoaderInfo { kind: LoaderKind::Neoforge, version: Some(" 21.1.5 ".into()) }),
        side: None,
    };
    let patch = SettingsPatch { overrides: Some([(ID.to_string(), Some(blank))].into_iter().collect()), ..Default::default() };
    apply_patch(&mut s, patch, &k, &HashSet::new()).expect("ok");
    assert_eq!(s.overrides[ID].mc_version, None);
    assert_eq!(s.overrides[ID].loader.as_ref().and_then(|l| l.version.as_deref()), Some("21.1.5"));

    let long = ov(&"9".repeat(200));
    let patch = SettingsPatch { overrides: Some([(ID.to_string(), Some(long))].into_iter().collect()), ..Default::default() };
    assert!(matches!(apply_patch(&mut s, patch, &k, &HashSet::new()), Err(Error::Invalid(_))));
}

/// A store whose writes always fail.
struct FailingStore;

impl SettingsStore for FailingStore {
    fn read(&self) -> Result<RawDoc> {
        Ok(RawDoc::Missing)
    }
    fn write(&self, _: &Map<String, Value>) -> Result<()> {
        Err(Error::Permission { path: "settings.json".into() })
    }
    fn backup(&self) -> Result<()> {
        Ok(())
    }
}

#[test]
fn failed_persist_does_not_commit() {
    let (svc, _) = SettingsService::load(Box::new(FailingStore));
    let res = svc.update(|s| {
        s.theme = ThemePref::Dark;
        Ok(())
    });
    assert!(matches!(res, Err(Error::Permission { .. })));
    assert_eq!(svc.get().theme, ThemePref::System);
}

#[test]
fn unchanged_update_does_not_write() {
    let store = std::sync::Arc::new(MemoryStore::default());
    struct Shared(std::sync::Arc<MemoryStore>);
    impl SettingsStore for Shared {
        fn read(&self) -> Result<RawDoc> {
            self.0.read()
        }
        fn write(&self, d: &Map<String, Value>) -> Result<()> {
            self.0.write(d)
        }
        fn backup(&self) -> Result<()> {
            self.0.backup()
        }
    }
    let (svc, _) = SettingsService::load(Box::new(Shared(store.clone())));
    svc.update(|_| Ok(())).expect("noop");
    assert!(store.doc.lock().expect("lock").is_none());
    svc.update(|s| {
        s.include_beta = true;
        Ok(())
    })
    .expect("write");
    assert!(store.doc.lock().expect("lock").is_some());
}

#[test]
fn instance_id_shape() {
    assert!(is_instance_id(ID));
    assert!(!is_instance_id("0123456789ABCDEF"));
    assert!(!is_instance_id("0123456789abcde"));
    assert!(!is_instance_id("0123456789abcdeg"));
}
