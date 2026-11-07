//! Execution: happy paths, precondition changes, verification failures, the game guard,
//! locked files, rollback to a byte-identical tree, order lifetime and concurrency.

use std::fs;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

use super::*;
use crate::error::Error;
use crate::model::OpState;

fn states(r: &WorkOrderResult) -> Vec<OpState> {
    r.statuses.iter().map(|s| s.state).collect()
}

fn no_part_files(h: &H) {
    let leftovers: Vec<String> = h.tree().into_keys().filter(|k| k.ends_with(".part") || k.contains(".tmp")).collect();
    assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
}

#[test]
fn disable_happy_path_writes_a_backup_and_emits_statuses() {
    let h = H::new();
    let a = h.jar("a.jar", "a");
    let o = h.plan(vec![disable("mods/a.jar")]).expect("plan");
    let (r, events) = h.exec(&o.id);
    let r = r.expect("execute");
    assert!(!r.rolled_back);
    assert_eq!(states(&r), vec![OpState::Done]);
    assert_eq!(events.iter().map(|e| e.state).collect::<Vec<_>>(), vec![OpState::Running, OpState::Done]);
    assert!(events.iter().all(|e| e.order_id == o.id && e.index == 0));
    assert!(fsops::is_absent(&h.mods.join("a.jar")));
    assert_eq!(fs::read(h.mods.join("a.jar.disabled")).expect("read"), a);

    let backup_id = r.backup_id.expect("backup id");
    assert!(backup_id.starts_with(&format!("{}/", h.id())));
    let snap = h.snapshot(&backup_id);
    assert_eq!(snap, PathBuf::from(&o.backup_dir));
    assert!(snap.join("manifest.json").is_file());
    let list = h.backups();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, backup_id);
    assert_eq!(list[0].title, o.title);
    assert_eq!(list[0].actions, o.actions);
    assert!(list[0].undone_actions.is_empty());
    let m = manifest::load(&h.st.guard, &snap).expect("manifest");
    assert_eq!(m.records[0].state, manifest::RecState::Done);
    assert_eq!(m.records[0].files[1].after.as_deref(), Some(sha1_hex(&a).as_str()));
}

#[test]
fn remove_duplicate_moves_into_the_snapshot() {
    let h = H::new();
    h.jar("a.jar", "a");
    let copy = h.jar("a-copy.jar", "a");
    let o = h.plan(vec![remove_dup("mods/a.jar", "mods/a-copy.jar")]).expect("plan");
    let r = h.exec(&o.id).0.expect("execute");
    assert_eq!(states(&r), vec![OpState::Done]);
    assert!(fsops::is_absent(&h.mods.join("a-copy.jar")));
    assert!(h.mods.join("a.jar").is_file());
    let snap = h.snapshot(&r.backup_id.expect("id"));
    assert_eq!(fs::read(snap.join("files/mods/a-copy.jar")).expect("backup copy"), copy);
}

#[test]
fn replace_downloads_verifies_and_backs_up() {
    let h = H::new();
    let (old, new) = h.replace_world();
    let o = h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]).expect("plan");
    let r = h.exec(&o.id).0.expect("execute");
    assert_eq!(states(&r), vec![OpState::Done], "{:?}", r.statuses);
    assert_eq!(fs::read(h.mods.join("sodium-0.5.9.jar")).expect("new"), new);
    assert!(fsops::is_absent(&h.mods.join("sodium-0.5.8.jar")));
    let snap = h.snapshot(&r.backup_id.expect("id"));
    assert_eq!(fs::read(snap.join("files/mods/sodium-0.5.8.jar")).expect("old in backup"), old);
    no_part_files(&h);
}

#[test]
fn install_accepts_a_provided_mod_id() {
    let h = H::new();
    let dep = h.install_world();
    // `cloth_config` is only in `provides`.
    let o = h.plan(vec![install("cloth_config", DEP)]).expect("plan");
    let r = h.exec(&o.id).0.expect("execute");
    assert_eq!(states(&r), vec![OpState::Done], "{:?}", r.statuses);
    assert_eq!(fs::read(h.mods.join("cloth-config-11.jar")).expect("installed"), dep);
    no_part_files(&h);
}

#[test]
fn a_file_edited_after_planning_fails_and_rolls_back() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/b.jar")]).expect("plan");
    // The user edits b.jar (same size is not enough: content and time change).
    std::thread::sleep(Duration::from_millis(20));
    h.write("b.jar", &fabric_jar("b", "2.0.0", &[]));
    let before = h.tree();
    let (r, events) = h.exec(&o.id);
    let r = r.expect("execute returns a result");
    assert!(r.rolled_back);
    assert_eq!(states(&r), vec![OpState::Skipped, OpState::Failed]);
    let failed = r.statuses[1].message.as_deref().unwrap_or("");
    assert!(failed.contains("mods/b.jar changed since the fixes were reviewed"), "{failed}");
    assert!(r.statuses[0].message.as_deref().unwrap_or("").contains("Rolled back"), "{:?}", r.statuses[0]);
    assert_eq!(h.tree(), before, "rollback must restore the tree exactly");
    // Events: running/done for op 0, running/failed for op 1, then the rollback of op 0.
    let seq: Vec<(u32, OpState)> = events.iter().map(|e| (e.index, e.state)).collect();
    assert_eq!(
        seq,
        vec![(0, OpState::Running), (0, OpState::Done), (1, OpState::Running), (1, OpState::Failed), (0, OpState::Skipped)]
    );
    // The rolled-back order is recorded, and nothing in it is left to undo.
    let list = h.backups();
    assert_eq!(list[0].undone_actions, vec![0, 1]);
}

#[test]
fn a_removed_source_or_created_destination_fails_and_rolls_back() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    h.jar("c.jar", "c");
    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/b.jar"), disable("mods/c.jar")]).expect("plan");
    fs::remove_file(h.mods.join("b.jar")).expect("user removes b");
    let before = h.tree();
    let r = h.exec(&o.id).0.expect("execute");
    assert_eq!(states(&r), vec![OpState::Skipped, OpState::Failed, OpState::Skipped]);
    assert!(r.statuses[1].message.as_deref().unwrap_or("").contains("is gone"), "{:?}", r.statuses[1]);
    assert_eq!(h.tree(), before);

    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/c.jar")]).expect("plan");
    h.write("c.jar.disabled", b"made by the user");
    let before = h.tree();
    let r = h.exec(&o.id).0.expect("execute");
    assert!(r.rolled_back);
    assert_eq!(states(&r), vec![OpState::Skipped, OpState::Failed]);
    assert!(r.statuses[1].message.as_deref().unwrap_or("").contains("appeared"), "{:?}", r.statuses[1]);
    assert_eq!(h.tree(), before);
    assert_eq!(fs::read(h.mods.join("c.jar.disabled")).expect("kept"), b"made by the user");
}

#[test]
fn sha512_mismatch_rolls_back_and_removes_the_part_file() {
    let h = H::new();
    h.jar("a.jar", "a");
    let old = fabric_jar("sodium", "0.5.8", &[]);
    h.write("sodium-0.5.8.jar", &old);
    let current = h.version_json(CURRENT, PROJECT, "0.5.8", "2024-01-01T00:00:00Z", "sodium-0.5.8.jar", &old);
    h.mount_identify(json!({ sha1_hex(&old): current }));
    let new = fabric_jar("sodium", "0.5.9", &[]);
    h.mount_version(h.version_json(NEWER, PROJECT, "0.5.9", "2024-03-01T00:00:00Z", "sodium-0.5.9.jar", &new));
    // The CDN serves different bytes of the same length.
    let mut evil = new.clone();
    let last = evil.len() - 1;
    evil[last] ^= 0xFF;
    h.mount_cdn("sodium-0.5.9.jar", evil);
    let before = h.tree();
    let o = h.plan(vec![disable("mods/a.jar"), replace("mods/sodium-0.5.8.jar", NEWER)]).expect("plan");
    let r = h.exec(&o.id).0.expect("execute");
    assert!(r.rolled_back);
    assert_eq!(states(&r), vec![OpState::Skipped, OpState::Failed]);
    assert!(r.statuses[1].message.as_deref().unwrap_or("").contains("SHA-512"), "{:?}", r.statuses[1]);
    assert_eq!(h.tree(), before);
    no_part_files(&h);
}

#[test]
fn a_download_declaring_the_wrong_mod_id_rolls_back() {
    let h = H::new();
    h.jar("a.jar", "a");
    let old = fabric_jar("sodium", "0.5.8", &[]);
    h.write("sodium-0.5.8.jar", &old);
    let current = h.version_json(CURRENT, PROJECT, "0.5.8", "2024-01-01T00:00:00Z", "sodium-0.5.8.jar", &old);
    h.mount_identify(json!({ sha1_hex(&old): current }));
    let wrong = fabric_jar("not-sodium", "0.5.9", &[]);
    h.mount_version(h.version_json(NEWER, PROJECT, "0.5.9", "2024-03-01T00:00:00Z", "sodium-0.5.9.jar", &wrong));
    h.mount_cdn("sodium-0.5.9.jar", wrong);
    let before = h.tree();
    let o = h.plan(vec![disable("mods/a.jar"), replace("mods/sodium-0.5.8.jar", NEWER)]).expect("plan");
    let r = h.exec(&o.id).0.expect("execute");
    assert!(r.rolled_back);
    let m = r.statuses[1].message.as_deref().unwrap_or("");
    assert!(m.contains("does not declare the expected mod id sodium") && m.contains("not-sodium"), "{m}");
    assert_eq!(h.tree(), before);
    no_part_files(&h);

    // Install: the dependency must declare the requested id (here a lookalike project that
    // Modrinth resolves `modmenu` to passes planning; the downloaded jar is still checked).
    let h = H::new();
    h.install_world_with(true);
    let o = h.plan(vec![install("modmenu", DEP)]).expect("plan");
    let r = h.exec(&o.id).0.expect("execute");
    assert_eq!(states(&r), vec![OpState::Failed]);
    assert!(fsops::is_absent(&h.mods.join("cloth-config-11.jar")));
    no_part_files(&h);
}

#[test]
fn game_running_touches_nothing() {
    let h = H::new();
    h.jar("a.jar", "a");
    let before = h.tree();
    let o = h.plan(vec![disable("mods/a.jar")]).expect("plan");
    let running = |_: &str| Ok(GameStatus { running: true, pids: vec![4242], reason: Some("javaw.exe pid 4242 with --gameDir".into()) });
    let (r, events) = h.exec_with(&o.id, running);
    let e = r.expect_err("game running");
    assert!(matches!(e, Error::GameRunning(_)), "{e:?}");
    assert!(events.is_empty());
    assert_eq!(h.tree(), before);
    assert!(fsops::is_absent(&h.backups.join(h.id())), "no snapshot while the game runs");
    // The order was not consumed: it runs once the game is closed.
    let r = h.exec(&o.id).0.expect("execute after closing the game");
    assert_eq!(states(&r), vec![OpState::Done]);
}

#[cfg(windows)]
#[test]
fn a_locked_file_fails_the_op_and_rolls_back() {
    use std::os::windows::fs::OpenOptionsExt;
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/b.jar")]).expect("plan");
    let before = h.tree();
    // Another program holds b.jar without any sharing.
    let lock = fs::OpenOptions::new().read(true).share_mode(0).open(h.mods.join("b.jar")).expect("lock");
    let r = h.exec(&o.id).0.expect("execute");
    drop(lock);
    assert!(r.rolled_back);
    assert_eq!(states(&r), vec![OpState::Skipped, OpState::Failed], "{:?}", r.statuses);
    assert_eq!(h.tree(), before);
}

#[cfg(windows)]
#[test]
fn a_rename_blocked_by_a_lock_fails_the_op_and_rolls_back() {
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_SHARE_READ only: the precondition hash can read it, but the rename (DELETE) fails.
    const FILE_SHARE_READ: u32 = 1;
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/b.jar")]).expect("plan");
    let before = h.tree();
    let lock = fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(h.mods.join("b.jar")).expect("lock");
    let r = h.exec(&o.id).0.expect("execute");
    drop(lock);
    assert!(r.rolled_back);
    assert_eq!(states(&r), vec![OpState::Skipped, OpState::Failed], "{:?}", r.statuses);
    assert_eq!(h.tree(), before);
}

#[test]
fn a_mid_order_failure_restores_a_byte_identical_tree() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("dup.jar", "d");
    h.jar("dup-copy.jar", "d");
    h.jar("off.jar.disabled", "off");
    h.replace_world();
    h.dep_world();
    // The dependency's download is missing on the CDN (404) — the last op fails.
    let dep = fabric_jar("cloth-config", "11.0.0", &[]);
    h.mount_version(h.version_json(DEP, DEP_PROJECT, "11.0.0", "2024-02-01T00:00:00Z", "cloth-config-11.jar", &dep));
    h.mount(Mock::given(method("GET")).and(path(format!("/data/{PROJECT}/versions/x/cloth-config-11.jar"))).respond_with(ResponseTemplate::new(404)));
    fs::create_dir_all(h.mods.join("sub")).expect("mkdir");
    fs::write(h.mods.join("sub/config.txt"), b"keep me").expect("write");
    let before = h.tree();
    let o = h
        .plan(vec![
            disable("mods/a.jar"),
            enable("mods/off.jar"),
            remove_dup("mods/dup.jar", "mods/dup-copy.jar"),
            replace("mods/sodium-0.5.8.jar", NEWER),
            install("cloth-config", DEP),
        ])
        .expect("plan");
    let r = h.exec(&o.id).0.expect("execute");
    assert!(r.rolled_back);
    assert_eq!(
        states(&r),
        vec![OpState::Skipped, OpState::Skipped, OpState::Skipped, OpState::Skipped, OpState::Failed],
        "{:?}",
        r.statuses
    );
    assert_eq!(h.tree(), before, "the mods folder must be byte-identical after rollback");
    // The downloaded replacement went into the snapshot's created/, never deleted.
    let snap = h.snapshot(&r.backup_id.expect("id"));
    assert!(snap.join("created/mods/sodium-0.5.9.jar").is_file());
    no_part_files(&h);
}

#[test]
fn expired_reused_and_discarded_orders_are_refused() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");

    let o = h.plan(vec![disable("mods/a.jar")]).expect("plan");
    h.exec(&o.id).0.expect("first run");
    let e = h.exec(&o.id).0.expect_err("reused");
    assert!(matches!(e, Error::NotFound { .. }) && msg(&e).contains("expired"), "{e:?}");

    let o = h.plan(vec![disable("mods/b.jar")]).expect("plan");
    h.st.fixes.discard(&o.id);
    let e = h.exec(&o.id).0.expect_err("discarded");
    assert!(matches!(e, Error::NotFound { .. }), "{e:?}");
    assert!(h.mods.join("b.jar").is_file());

    h.st.fixes.set_ttl(Duration::ZERO);
    let o = h.plan(vec![disable("mods/b.jar")]).expect("plan");
    let e = h.exec(&o.id).0.expect_err("expired");
    assert!(matches!(e, Error::NotFound { .. }) && msg(&e).contains("review the fixes again"), "{e:?}");
    assert!(h.mods.join("b.jar").is_file());

    let e = h.exec("not an id").0.expect_err("malformed");
    assert!(matches!(e, Error::NotFound { .. }), "{e:?}");
}

#[test]
fn two_orders_for_one_instance_never_execute_concurrently() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let first = h.plan(vec![disable("mods/a.jar")]).expect("plan 1");
    let second = h.plan(vec![disable("mods/b.jar")]).expect("plan 2");
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = Mutex::new(release_rx);
    std::thread::scope(|s| {
        let runner = s.spawn(|| {
            // The first order parks inside its game check while the second one tries to run.
            h.exec_with(&first.id, |_| {
                entered_tx.send(()).expect("signal");
                release_rx.lock().expect("lock").recv_timeout(Duration::from_secs(30)).expect("release");
                Ok(GameStatus { running: false, pids: Vec::new(), reason: None })
            })
        });
        entered_rx.recv_timeout(Duration::from_secs(30)).expect("first order started");
        let e = h.exec(&second.id).0.expect_err("conflict");
        assert!(matches!(e, Error::Conflict(_)), "{e:?}");
        assert!(msg(&e).contains("already being applied"), "{e}");
        release_tx.send(()).expect("release");
        let r = runner.join().expect("join").0.expect("first order");
        assert_eq!(states(&r), vec![OpState::Done]);
    });
    // The conflicting order was not consumed.
    let r = h.exec(&second.id).0.expect("second order afterwards");
    assert_eq!(states(&r), vec![OpState::Done]);
}

#[test]
fn an_order_never_runs_during_a_scan() {
    let h = H::new();
    h.jar("a.jar", "a");
    let o = h.plan(vec![disable("mods/a.jar")]).expect("plan");
    let ticket = h.st.scans.begin(h.id(), "Test Pack").expect("scan ticket");
    let e = h.exec(&o.id).0.expect_err("conflict");
    assert!(matches!(e, Error::Conflict(_)) && msg(&e).contains("being scanned"), "{e:?}");
    assert!(h.mods.join("a.jar").is_file());
    drop(ticket);
    h.exec(&o.id).0.expect("after the scan");
    // While an order executes, scans are refused (the ticket is held), and released after.
    assert!(!h.st.scans.is_running(h.id()));
    assert!(!h.st.fixes.is_executing(h.id()));
}

#[test]
fn corrupt_manifests_are_skipped_by_list_backups() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let o1 = h.plan(vec![disable("mods/a.jar")]).expect("plan");
    let r1 = h.exec(&o1.id).0.expect("exec 1");
    let o2 = h.plan(vec![disable("mods/b.jar")]).expect("plan");
    let r2 = h.exec(&o2.id).0.expect("exec 2");
    let inst_dir = h.backups.join(h.id());
    for (name, body) in [("1", "not json"), ("2", "{\"format\":1}"), ("3", "")] {
        fs::create_dir_all(inst_dir.join(name)).expect("mkdir");
        fs::write(inst_dir.join(name).join("manifest.json"), body).expect("write");
    }
    fs::create_dir_all(inst_dir.join("4")).expect("no manifest at all");
    fs::create_dir_all(inst_dir.join("junk-name")).expect("not a timestamp");
    // A valid manifest copied into the wrong folder is refused too.
    let good = fs::read(h.snapshot(r1.backup_id.as_deref().expect("id")).join("manifest.json")).expect("read");
    fs::create_dir_all(inst_dir.join("5")).expect("mkdir");
    fs::write(inst_dir.join("5").join("manifest.json"), good).expect("write");
    let list = h.backups();
    let ids: Vec<String> = list.iter().map(|b| b.id.clone()).collect();
    assert_eq!(ids, vec![r2.backup_id.expect("2"), r1.backup_id.expect("1")], "newest first, corrupt ones skipped");
    // Other instances' and malformed ids.
    assert!(list_backups(&h.st.guard, &h.backups, "ffffffffffffffff").expect("empty").is_empty());
    assert!(list_backups(&h.st.guard, &h.backups, "../x").is_err());
}
