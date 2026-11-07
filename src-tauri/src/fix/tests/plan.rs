//! Planning: every action and every refusal. Planning never mutates anything.

use serde_json::json;

use super::*;
use crate::error::Error;
use crate::model::{FileOp, PackOverride, WorkOrderKind};

fn invalid_containing(r: Result<WorkOrder>, needle: &str) -> String {
    match r {
        Err(e @ Error::Invalid(_)) => {
            let m = msg(&e);
            assert!(m.contains(needle), "expected \"{needle}\" in: {m}");
            m
        }
        Err(e) => panic!("expected Invalid containing \"{needle}\", got {e:?}"),
        Ok(o) => panic!("expected a refusal containing \"{needle}\", got order {:?}", o.ops),
    }
}

#[test]
fn disable_and_enable_become_renames_without_touching_anything() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar.disabled", "b");
    let before = h.tree();
    let o = h.plan(vec![disable("mods/a.jar"), enable("mods/b.jar")]).expect("plan");
    assert_eq!(o.kind, WorkOrderKind::Fix);
    assert_eq!(o.instance_id, h.id());
    assert_eq!(o.title, "Disable a.jar, enable b.jar");
    assert_eq!(o.ops.len(), 2);
    assert_eq!(o.ops[0].op, FileOp::Rename { from: "mods/a.jar".into(), to: "mods/a.jar.disabled".into() });
    assert_eq!(o.ops[1].op, FileOp::Rename { from: "mods/b.jar.disabled".into(), to: "mods/b.jar".into() });
    assert_eq!(o.ops[1].action_index, 1);
    let backup_dir = PathBuf::from(&o.backup_dir);
    assert!(backup_dir.starts_with(h.backups.join(h.id())), "{}", o.backup_dir);
    assert!(fsops::is_absent(&backup_dir), "planning must not create the snapshot");
    assert_eq!(h.tree(), before, "planning mutated the mods folder");
    assert!(h.st.fixes.contains(&o.id));
    assert_eq!(o.id.len(), 32);
    // No Modrinth request for local-only actions.
    assert!(h.rt.block_on(h.server.received_requests()).unwrap_or_default().is_empty());
}

#[test]
fn twin_ids_resolve_to_the_disabled_file() {
    let h = H::new();
    h.jar("x.jar", "x");
    h.jar("x.jar.disabled", "x");
    // `mods/x.jar#disabled` is the disabled twin; enabling it would overwrite `x.jar`.
    invalid_containing(h.plan(vec![enable("mods/x.jar#disabled")]), "already exists");
    // Disabling the enabled one would overwrite the twin.
    invalid_containing(h.plan(vec![disable("mods/x.jar")]), "already exists");
    invalid_containing(h.plan(vec![disable("mods/x.jar#disabled")]), "already disabled");
}

#[test]
fn already_in_that_state_is_refused() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar.disabled", "b");
    invalid_containing(h.plan(vec![enable("mods/a.jar")]), "Enable a.jar: the jar is already enabled");
    invalid_containing(h.plan(vec![disable("mods/b.jar")]), "Disable b.jar: the jar is already disabled");
}

#[test]
fn missing_and_malformed_jar_ids_are_refused() {
    let h = H::new();
    invalid_containing(h.plan(vec![disable("mods/missing.jar")]), "Disable missing.jar: missing.jar is no longer in the mods folder");
    for bad in ["../x.jar", "mods/../x.jar", "mods/sub/x.jar", "config/x.jar", "mods/x.txt", "mods/a.jar!/inner.jar", "mods/CON.jar"] {
        let r = h.plan(vec![disable(bad)]);
        assert!(matches!(r, Err(Error::Invalid(_)) | Err(Error::OutsideScope { .. })), "{bad}: {r:?}");
    }
}

#[test]
fn pack_identity_must_match_metadata_and_override() {
    let h = H::new();
    h.jar("a.jar", "a");
    let mut pack = h.pack();
    pack.loader.kind = LoaderKind::Forge;
    let e = plan_order(&h.st, None, h.id(), &pack, &[disable("mods/a.jar")]).expect_err("loader mismatch");
    assert!(msg(&e).contains("contradicts the launcher metadata"), "{e}");
    let mut pack = h.pack();
    pack.mc_version = "1.20.4".into();
    let e = plan_order(&h.st, None, h.id(), &pack, &[disable("mods/a.jar")]).expect_err("mc mismatch");
    assert!(msg(&e).contains("Minecraft version"), "{e}");

    // A stored override wins over metadata: the pack must then match the override.
    let ov = PackOverride { mc_version: Some("1.20.4".into()), loader: None, side: None };
    h.st.settings.update(|s| Ok(s.overrides.insert(h.id().to_string(), ov))).expect("override");
    let e = plan_order(&h.st, None, h.id(), &h.pack(), &[disable("mods/a.jar")]).expect_err("override mismatch");
    assert!(msg(&e).contains("stored override"), "{e}");
    let mut pack = h.pack();
    pack.mc_version = "1.20.4".into();
    plan_order(&h.st, None, h.id(), &pack, &[disable("mods/a.jar")]).expect("matches the override");
}

#[test]
fn unknown_instance_and_empty_orders_are_refused() {
    let h = H::new();
    let e = plan_order(&h.st, None, "ffffffffffffffff", &h.pack(), &[disable("mods/a.jar")]).expect_err("unknown");
    assert!(matches!(e, Error::NotFound { .. }), "{e:?}");
    let e = plan_order(&h.st, None, "not-an-id", &h.pack(), &[disable("mods/a.jar")]).expect_err("malformed");
    assert!(matches!(e, Error::Invalid(_)), "{e:?}");
    let e = h.plan(vec![]).expect_err("empty");
    assert!(matches!(e, Error::Invalid(_)), "{e:?}");
}

#[test]
fn remove_duplicate_rules() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("a-copy.jar", "a");
    invalid_containing(h.plan(vec![remove_dup("mods/a.jar", "mods/a.jar")]), "the same");
    invalid_containing(h.plan(vec![remove_dup("mods/gone.jar", "mods/a-copy.jar")]), "the jar to keep (gone.jar) is not in the mods folder");
    let o = h.plan(vec![remove_dup("mods/a.jar", "mods/a-copy.jar")]).expect("plan");
    assert_eq!(o.ops[0].op, FileOp::MoveToBackup { path: "mods/a-copy.jar".into() });
    assert_eq!(o.title, "Remove a-copy.jar");
}

#[test]
fn two_actions_on_one_file_are_refused() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "a");
    invalid_containing(h.plan(vec![disable("mods/a.jar"), remove_dup("mods/a.jar", "mods/b.jar")]), "also changes mods/a.jar");
    invalid_containing(h.plan(vec![disable("mods/a.jar"), disable("mods/a.jar")]), "Disable a.jar");
}

#[test]
fn manual_steps_are_notes_only() {
    let h = H::new();
    let o = h
        .plan(vec![FixAction::Manual { steps: vec!["Install Java 21".into(), "  ".into()] }])
        .expect("plan");
    assert!(o.ops.is_empty());
    assert_eq!(o.notes, vec!["Manual step: Install Java 21".to_string()]);
    assert_eq!(o.title, "1 manual step");
}

#[test]
fn replace_happy_plan() {
    let h = H::new();
    let (_, new) = h.replace_world();
    let o = h.plan(vec![disable("mods/sodium-0.5.8.jar").clone()]).expect("plan disable");
    h.st.fixes.discard(&o.id);
    let o = h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]).expect("plan replace");
    match &o.ops[0].op {
        FileOp::Download { dest, replaces, sha512, size_bytes, url, version_number, .. } => {
            assert_eq!(dest, "mods/sodium-0.5.9.jar");
            assert_eq!(replaces.as_deref(), Some("mods/sodium-0.5.8.jar"));
            assert_eq!(sha512, &sha512_hex(&new));
            assert_eq!(*size_bytes, new.len() as u64);
            assert_eq!(url, &h.cdn_url("sodium-0.5.9.jar"));
            assert_eq!(version_number, "0.5.9");
        }
        other => panic!("not a download: {other:?}"),
    }
    assert!(o.title.starts_with("Replace "), "{}", o.title);
}

#[test]
fn replace_needs_modrinth() {
    let h = H::new();
    h.replace_world();
    let e = h.plan_offline(vec![replace("mods/sodium-0.5.8.jar", NEWER)]).expect_err("offline");
    assert!(matches!(e, Error::Offline), "{e:?}");
    let e = h.plan_offline(vec![install("cloth-config", DEP)]).expect_err("offline");
    assert!(matches!(e, Error::Offline), "{e:?}");
}

/// Mount NEWER with `edit` applied to the standard JSON.
fn with_newer(h: &H, edit: impl FnOnce(&mut serde_json::Value)) {
    let old = fabric_jar("sodium", "0.5.8", &[]);
    h.write("sodium-0.5.8.jar", &old);
    let current = h.version_json(CURRENT, PROJECT, "0.5.8", "2024-01-01T00:00:00Z", "sodium-0.5.8.jar", &old);
    h.mount_identify(json!({ sha1_hex(&old): current }));
    let new = fabric_jar("sodium", "0.5.9", &[]);
    let mut v = h.version_json(NEWER, PROJECT, "0.5.9", "2024-03-01T00:00:00Z", "sodium-0.5.9.jar", &new);
    edit(&mut v);
    h.mount_version(v);
}

#[test]
fn replace_refuses_a_wrong_loader() {
    let h = H::new();
    with_newer(&h, |v| v["loaders"] = json!(["forge", "neoforge"]));
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "Replace sodium-0.5.8.jar: version 0.5.9 is for forge, neoforge");
}

#[test]
fn quilt_accepts_fabric_and_neoforge_1201_accepts_forge() {
    let mut pack = PackIdentity { mc_version: "1.20.1".into(), loader: LoaderInfo { kind: LoaderKind::Quilt, version: None } };
    assert_eq!(crate::fix::plan::modrinth_loaders(&pack), vec!["quilt", "fabric"]);
    pack.loader.kind = LoaderKind::Neoforge;
    assert_eq!(crate::fix::plan::modrinth_loaders(&pack), vec!["neoforge", "forge"]);
    pack.mc_version = "1.21.1".into();
    assert_eq!(crate::fix::plan::modrinth_loaders(&pack), vec!["neoforge"]);
    pack.loader.kind = LoaderKind::Unknown;
    assert!(crate::fix::plan::modrinth_loaders(&pack).is_empty());
}

#[test]
fn replace_refuses_a_wrong_minecraft_version() {
    let h = H::new();
    with_newer(&h, |v| v["game_versions"] = json!(["1.20.4", "1.20.2"]));
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "does not list Minecraft 1.20.1");
}

#[test]
fn replace_refuses_another_project() {
    let h = H::new();
    with_newer(&h, |v| v["project_id"] = json!(OTHER_PROJECT));
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "different Modrinth project");
}

#[test]
fn replace_refuses_an_older_or_undated_version() {
    let h = H::new();
    with_newer(&h, |v| v["date_published"] = json!("2023-12-31T23:59:59Z"));
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "not published after the installed version 0.5.8");
    let h = H::new();
    with_newer(&h, |v| v["date_published"] = json!("2024-01-01T00:00:00Z"));
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "not published after");
    let h = H::new();
    with_newer(&h, |v| v["date_published"] = serde_json::Value::Null);
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "not published after");
}

#[test]
fn replace_refuses_a_jar_modrinth_does_not_know() {
    let h = H::new();
    let old = fabric_jar("sodium", "0.5.8", &[]);
    h.write("sodium-0.5.8.jar", &old);
    h.mount_identify(json!({}));
    let new = fabric_jar("sodium", "0.5.9", &[]);
    h.mount_version(h.version_json(NEWER, PROJECT, "0.5.9", "2024-03-01T00:00:00Z", "sodium-0.5.9.jar", &new));
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "does not know this jar by its hash");
}

#[test]
fn replace_refuses_without_a_usable_download_file() {
    // No primary and a dropped (off-CDN) file.
    let h = H::new();
    with_newer(&h, |v| {
        v["files"][0]["primary"] = json!(false);
        let mut off = v["files"][0].clone();
        off["url"] = json!("https://example.com/evil.jar");
        off["filename"] = json!("evil.jar");
        v["files"].as_array_mut().expect("files").push(off);
    });
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "no file of this version is marked primary");

    // The primary file itself was dropped (off-CDN): never fall back to the sole remaining file.
    let h = H::new();
    with_newer(&h, |v| {
        v["files"][0]["primary"] = json!(false);
        let mut off = v["files"][0].clone();
        off["url"] = json!("https://example.com/evil.jar");
        off["primary"] = json!(true);
        v["files"].as_array_mut().expect("files").push(off);
    });
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "primary file for this version is not");

    // Several candidates, none primary.
    let h = H::new();
    with_newer(&h, |v| {
        v["files"][0]["primary"] = json!(false);
        let mut second = v["files"][0].clone();
        second["filename"] = json!("sodium-extra.jar");
        v["files"].as_array_mut().expect("files").push(second);
    });
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "several files and none is marked primary");

    // A sources jar does not count: the remaining normal file is the sole candidate.
    let h = H::new();
    with_newer(&h, |v| {
        v["files"][0]["primary"] = json!(false);
        let mut src = v["files"][0].clone();
        src["filename"] = json!("sodium-sources.jar");
        src["file_type"] = json!("sources-jar");
        v["files"].as_array_mut().expect("files").push(src);
    });
    h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]).expect("sole non-excluded file");
}

#[test]
fn replace_refuses_unsafe_file_names() {
    for bad in ["../evil.jar", "CON.jar", "sodium.zip", "sodium.jar.", ".hidden.jar", "a..b.jar"] {
        let h = H::new();
        with_newer(&h, |v| v["files"][0]["filename"] = json!(bad));
        invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "is not a safe jar file name");
    }
}

#[test]
fn replace_refuses_an_existing_destination() {
    let h = H::new();
    h.replace_world();
    h.write("sodium-0.5.9.jar", b"user file");
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "mods/sodium-0.5.9.jar already exists");
}

#[test]
fn replace_refuses_a_disabled_or_missing_jar() {
    let h = H::new();
    h.replace_world();
    std::fs::rename(h.mods.join("sodium-0.5.8.jar"), h.mods.join("sodium-0.5.8.jar.disabled")).expect("rename");
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]), "disabled");
    invalid_containing(h.plan(vec![replace("mods/nope.jar", NEWER)]), "Replace nope.jar: nope.jar is no longer in the mods folder");
}

#[test]
fn replace_refuses_a_malformed_version_id() {
    let h = H::new();
    h.replace_world();
    invalid_containing(h.plan(vec![replace("mods/sodium-0.5.8.jar", "../../x")]), "not a Modrinth version id");
}

#[test]
fn install_plan_and_refusals() {
    let h = H::new();
    h.install_world();
    let o = h.plan(vec![install("cloth-config", DEP)]).expect("plan");
    match &o.ops[0].op {
        FileOp::Download { dest, replaces, .. } => {
            assert_eq!(dest, "mods/cloth-config-11.jar");
            assert!(replaces.is_none());
        }
        other => panic!("not a download: {other:?}"),
    }
    assert_eq!(o.title, "Install cloth-config");
    invalid_containing(h.plan(vec![install("bad id/../x", DEP)]), "not a valid mod id");
    h.write("cloth-config-11.jar", b"mine");
    invalid_containing(h.plan(vec![install("cloth-config", DEP)]), "already exists");
}

#[test]
fn symlinked_mods_folder_outside_the_roots_is_refused() {
    let outside_mods = std::sync::Mutex::new(None);
    let h = H::with(|game| {
        let target = game.parent().and_then(Path::parent).expect("base").join("outside").join("shared-mods");
        std::fs::create_dir_all(&target).expect("mkdir");
        std::fs::write(target.join("a.jar"), fabric_jar("a", "1", &[])).expect("write");
        if link_dir(&target, &game.join("mods")) {
            *outside_mods.lock().expect("lock") = Some(target);
        }
    });
    let Some(target) = outside_mods.into_inner().expect("lock") else {
        eprintln!("skipped: directory links are not available here");
        return;
    };
    // Discovery registers a linked mods/ target as a root; drop it to simulate a link that
    // resolves outside every root.
    h.st.guard.remove_root(&dunce::canonicalize(&target).expect("canon"));
    let e = h.plan(vec![disable("mods/a.jar")]).expect_err("outside scope");
    assert!(matches!(e, Error::OutsideScope { .. }), "{e:?}");
    assert!(target.join("a.jar").is_file(), "nothing was touched");
}
