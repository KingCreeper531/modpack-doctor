//! M6 safety review: write-ahead records and crash recovery, all-or-nothing rollback, recovery
//! from actual file locations, no-replace moves, bound InstallDependency intents, fresh version
//! fetches and case-only Replace undo. Crashes are simulated with the `fsops::hook` test hook
//! (a panic right before or after one move, so the manifest on disk stays as last saved).

use std::fs;
use std::panic::AssertUnwindSafe;
use std::path::Path;

use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

use super::*;
use crate::error::Error;
use crate::fix::fsops::hook::{self, Act, Stage};
use crate::model::{BackupStatus, FileOp, OpState, PlannedOp, WorkOrderKind};

fn has_component(p: &Path, name: &str) -> bool {
    p.components().any(|c| c.as_os_str() == name)
}

fn named(p: &Path, name: &str) -> bool {
    p.file_name().is_some_and(|n| n == name)
}

/// Execute `order_id`, "crashing" the app at the first move for which `at` says so.
fn exec_crashing(h: &H, order_id: &str, mut at: impl FnMut(Stage, &Path, &Path) -> bool + 'static) {
    hook::set(move |s, a, b| if at(s, a, b) { Act::Crash } else { Act::Go });
    let r = std::panic::catch_unwind(AssertUnwindSafe(|| h.exec(order_id)));
    hook::clear();
    assert!(r.is_err(), "the simulated crash did not happen");
}

/// Execute with moves failing wherever `fail` says so.
fn exec_failing(h: &H, order_id: &str, mut fail: impl FnMut(&Path, &Path) -> bool + 'static) -> WorkOrderResult {
    hook::set(move |s, a, b| if s == Stage::Before && fail(a, b) { Act::Fail } else { Act::Go });
    let r = h.exec(order_id).0;
    hook::clear();
    r.expect("execute returns a result")
}

fn status_of(h: &H, backup: &str) -> BackupStatus {
    h.backups().into_iter().find(|b| b.id == backup).expect("backup listed").status
}

fn only_backup(h: &H) -> String {
    let list = h.backups();
    assert_eq!(list.len(), 1, "{list:?}");
    list[0].id.clone()
}

fn parts_in_mods(h: &H) -> Vec<String> {
    h.tree().into_keys().filter(|k| k.ends_with(".part")).collect()
}

/// Recover an incomplete backup as a whole and require the tree to equal `before`.
fn recover(h: &H, backup: &str, before: &BTreeMap<String, String>) -> WorkOrder {
    assert_eq!(status_of(h, backup), BackupStatus::Incomplete);
    let e = plan_undo(&h.st, backup, Some(vec![0])).expect_err("per-action undo of an incomplete backup");
    assert!(msg(&e).contains("recover the whole backup"), "{e}");
    let o = plan_undo(&h.st, backup, None).expect("plan recovery");
    assert_eq!(o.kind, WorkOrderKind::Undo);
    assert!(o.title.starts_with("Recover "), "{}", o.title);
    let r = h.exec(&o.id).0.expect("execute recovery");
    assert!(!r.rolled_back, "{:?}", r.statuses);
    assert!(r.statuses.iter().all(|s| s.state == OpState::Done), "{:?}", r.statuses);
    assert_eq!(&h.tree(), before, "recovery must restore the pre-order tree");
    assert_eq!(status_of(h, backup), BackupStatus::RolledBack, "a completed recovery means the files are as before");
    let e = plan_undo(&h.st, backup, None).expect_err("nothing left");
    assert!(msg(&e).contains("already undone"), "{e}");
    o
}

/// Recover a backup whose only broken part is an undo of completed fixes: the recovery reverts
/// that undo (the tree equals `after_fix`), touches only that undo's actions, and the backup is
/// `complete` again (the fixes can still be undone normally).
fn recover_undo(h: &H, backup: &str, after_fix: &BTreeMap<String, String>, undo_actions: usize) -> WorkOrder {
    assert_eq!(status_of(h, backup), BackupStatus::Incomplete);
    let o = plan_undo(&h.st, backup, None).expect("plan recovery");
    assert!(o.title.starts_with("Recover "), "{}", o.title);
    assert_eq!(o.actions.len(), undo_actions, "only the broken undo's actions: {:?}", o.actions);
    assert!(o.notes.iter().any(|n| n.contains("the other fixes are not touched")), "{:?}", o.notes);
    let r = h.exec(&o.id).0.expect("execute recovery");
    assert!(!r.rolled_back, "{:?}", r.statuses);
    assert!(r.statuses.iter().all(|s| s.state == OpState::Done), "{:?}", r.statuses);
    assert_eq!(&h.tree(), after_fix, "the interrupted undo is reverted");
    assert_eq!(status_of(h, backup), BackupStatus::Complete);
    o
}

// ── Write-ahead and crash recovery ───────────────────────────────────────────

#[test]
fn a_finished_order_is_complete_and_a_rolled_back_one_rolled_back() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let o = h.plan(vec![disable("mods/a.jar")]).expect("plan");
    let r = h.exec(&o.id).0.expect("exec");
    assert_eq!(status_of(&h, r.backup_id.as_deref().expect("id")), BackupStatus::Complete);
    let o = h.plan(vec![disable("mods/b.jar")]).expect("plan");
    fs::remove_file(h.mods.join("b.jar")).expect("rm");
    let r = h.exec(&o.id).0.expect("exec");
    assert!(r.rolled_back);
    let id = r.backup_id.expect("id");
    assert_eq!(status_of(&h, &id), BackupStatus::RolledBack);
    let e = plan_undo(&h.st, &id, Some(vec![0])).expect_err("per-action undo of a rolled-back backup");
    assert!(msg(&e).contains("rolled back"), "{e}");
}

#[test]
fn every_op_is_recorded_running_with_its_moves_before_it_mutates() {
    let h = H::new();
    let (old, _) = h.replace_world();
    let backups = h.backups.clone();
    let guard = h.st.guard.clone();
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let log = seen.clone();
    let o = h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]).expect("plan");
    hook::set(move |stage, _, _| {
        if stage == Stage::Before {
            // What a crash right now would leave on disk.
            let inst = fs::read_dir(&backups).expect("ls").flatten().next().expect("instance dir").path();
            let snap = fs::read_dir(inst).expect("ls").flatten().next().expect("snapshot").path();
            let m = manifest::load(&guard, &snap).expect("manifest");
            log.borrow_mut().push((m.records[0].state, m.records[0].part.clone(), m.records[0].files.clone()));
        }
        Act::Go
    });
    let r = h.exec(&o.id).0.expect("exec");
    hook::clear();
    assert_eq!(r.statuses[0].state, OpState::Done);
    let seen = seen.borrow();
    assert_eq!(seen.len(), 2, "two moves: the old jar into the snapshot, the download into place");
    for (state, part, files) in seen.iter() {
        assert_eq!(*state, manifest::RecState::Running);
        assert!(part.as_deref().is_some_and(manifest::is_part_rel), "{part:?}");
        let old_rec = files.iter().find(|f| f.path == "mods/sodium-0.5.8.jar").expect("old jar recorded");
        assert_eq!(old_rec.before.as_deref(), Some(sha1_hex(&old).as_str()));
        assert_eq!(old_rec.backup_path.as_deref(), Some("files/mods/sodium-0.5.8.jar"));
        // The new jar's sha1 is recorded once it is verified, before it can reach `dest`.
        assert!(files.iter().any(|f| f.path == "mods/sodium-0.5.9.jar" && f.after.is_some()), "{files:?}");
    }
}

#[test]
fn s1_crash_after_the_old_jar_moved_out_recovers_from_the_snapshot() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.replace_world();
    let before = h.tree();
    let o = h.plan(vec![disable("mods/a.jar"), replace("mods/sodium-0.5.8.jar", NEWER)]).expect("plan");
    // Crash right after the replaced jar went into the snapshot: the new jar is still a .part.
    exec_crashing(&h, &o.id, |s, src, dst| s == Stage::After && named(src, "sodium-0.5.8.jar") && has_component(dst, "files"));
    assert!(fsops::is_absent(&h.mods.join("sodium-0.5.8.jar")));
    assert_eq!(parts_in_mods(&h).len(), 1, "the interrupted download is still in mods/");
    assert!(!h.st.fixes.is_executing(h.id()), "the execution claim is released");

    // The startup / list_backups pass marks the manifest and, with the instance registered (as
    // here), moves the leftover .part into the snapshot (never deletes it).
    crate::fix::recover::recover_at_startup(&h.st);
    let backup = only_backup(&h);
    assert!(parts_in_mods(&h).is_empty(), "leftover .part moved out of mods/");
    let snap = h.snapshot(&backup);
    let m = manifest::load(&h.st.guard, &snap).expect("manifest");
    assert!(m.interrupted && !m.finished);
    let moved = m.records[1].part_backup.clone().expect("part recorded as moved");
    assert!(snap.join(&moved).is_file(), "{moved}");
    assert_eq!(m.records[0].state, manifest::RecState::Done);
    assert_eq!(m.records[1].state, manifest::RecState::Running);

    let o = recover(&h, &backup, &before);
    // Back to the pre-order state: the disable is reverted and the old jar restored.
    assert_eq!(o.ops.len(), 2, "{:?}", o.ops);
}

#[test]
fn crash_after_the_download_was_placed_recovers_without_listing_first() {
    let h = H::new();
    let (_, new) = h.replace_world();
    let before = h.tree();
    let o = h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]).expect("plan");
    exec_crashing(&h, &o.id, |s, _, dst| s == Stage::After && named(dst, "sodium-0.5.9.jar"));
    assert_eq!(fs::read(h.mods.join("sodium-0.5.9.jar")).expect("placed"), new);
    let backup = format!("{}/{}", h.id(), o.backup_dir.rsplit(['/', '\\']).next().expect("ms"));
    // plan_undo directly (no list_backups in between).
    let p = plan_undo(&h.st, &backup, None).expect("plan recovery");
    assert!(matches!(&p.ops[0].op, FileOp::RemoveCreated { path, .. } if path == "mods/sodium-0.5.9.jar"), "{:?}", p.ops);
    assert!(matches!(&p.ops[1].op, FileOp::Restore { to, .. } if to == "mods/sodium-0.5.8.jar"), "{:?}", p.ops);
    h.st.fixes.discard(&p.id);
    recover(&h, &backup, &before);
    assert_eq!(fs::read(h.snapshot(&backup).join("created/mods/sodium-0.5.9.jar")).expect("kept"), new);
}

#[test]
fn crash_after_a_rename_recovers_the_renamed_jar() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let before = h.tree();
    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/b.jar")]).expect("plan");
    exec_crashing(&h, &o.id, |s, _, dst| s == Stage::After && named(dst, "a.jar.disabled"));
    let backup = only_backup(&h);
    let p = plan_undo(&h.st, &backup, None).expect("plan");
    assert_eq!(p.ops.len(), 1, "b.jar never moved: {:?}", p.ops);
    assert_eq!(p.ops[0].op, FileOp::Rename { from: "mods/a.jar.disabled".into(), to: "mods/a.jar".into() });
    h.st.fixes.discard(&p.id);
    recover(&h, &backup, &before);
}

#[test]
fn crash_before_any_move_leaves_nothing_to_recover() {
    let h = H::new();
    h.jar("a.jar", "a");
    let before = h.tree();
    let o = h.plan(vec![disable("mods/a.jar")]).expect("plan");
    exec_crashing(&h, &o.id, |s, _, _| s == Stage::Before);
    assert_eq!(h.tree(), before);
    let backup = only_backup(&h);
    // Recorded as running, so still incomplete; the recovery finds every file at home.
    let p = plan_undo(&h.st, &backup, None).expect("plan");
    assert!(p.ops.is_empty(), "{:?}", p.ops);
    assert!(p.notes.iter().any(|n| n.contains("already where it was")), "{:?}", p.notes);
    h.st.fixes.discard(&p.id);
    recover(&h, &backup, &before);
}

#[test]
fn recovery_refuses_when_a_file_changed_or_its_place_is_taken() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/b.jar")]).expect("plan");
    exec_crashing(&h, &o.id, |s, _, dst| s == Stage::After && named(dst, "b.jar.disabled"));
    let backup = only_backup(&h);
    // The user re-created a.jar by hand: never overwritten.
    h.write("a.jar", b"user's own a.jar");
    let e = plan_undo(&h.st, &backup, None).expect_err("place taken");
    assert!(msg(&e).contains("mods/a.jar exists and is never overwritten"), "{e}");
    fs::remove_file(h.mods.join("a.jar")).expect("rm");
    // The user edited b.jar.disabled: its original content is nowhere.
    h.write("b.jar.disabled", b"edited");
    let e = plan_undo(&h.st, &backup, None).expect_err("changed");
    assert!(msg(&e).contains("mods/b.jar is neither at its place nor in the backup"), "{e}");
    assert_eq!(status_of(&h, &backup), BackupStatus::Incomplete);
}

// ── All-or-nothing rollback ──────────────────────────────────────────────────

/// Replace sodium, then an install whose CDN file is missing, so the order rolls back.
fn replace_then_failing_install(h: &H) -> WorkOrder {
    h.replace_world();
    h.dep_world();
    let dep = fabric_jar("cloth-config", "11.0.0", &[]);
    h.mount_version(h.version_json(DEP, DEP_PROJECT, "11.0.0", "2024-02-01T00:00:00Z", "cloth-config-11.jar", &dep));
    h.mount(Mock::given(method("GET")).and(path(format!("/data/{PROJECT}/versions/x/cloth-config-11.jar"))).respond_with(ResponseTemplate::new(404)));
    h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER), install("cloth-config", DEP)]).expect("plan")
}

#[test]
fn s2_a_download_whose_old_jar_cannot_be_moved_back_stays_applied() {
    let h = H::new();
    let before = h.tree();
    let o = replace_then_failing_install(&h);
    let before_with_world = h.tree();
    assert_ne!(before, before_with_world);
    // Moving the old jar back out of the snapshot fails during the rollback.
    let r = exec_failing(&h, &o.id, |src, _| named(src, "sodium-0.5.8.jar") && has_component(src, "files"));
    assert!(r.rolled_back);
    assert_eq!(r.statuses[0].state, OpState::Failed);
    let m0 = r.statuses[0].message.as_deref().unwrap_or("");
    assert!(m0.contains("automatic rollback failed"), "{m0}");
    // Consistently applied: the new jar is in place, the old one in the snapshot.
    assert!(h.mods.join("sodium-0.5.9.jar").is_file());
    assert!(fsops::is_absent(&h.mods.join("sodium-0.5.8.jar")));
    let backup = r.backup_id.expect("id");
    let m = manifest::load(&h.st.guard, &h.snapshot(&backup)).expect("manifest");
    assert_eq!(m.records[0].state, manifest::RecState::RollbackFailed);
    assert!(parts_in_mods(&h).is_empty());
    recover(&h, &backup, &before_with_world);
}

#[test]
fn a_rollback_that_breaks_halfway_is_partial_and_recoverable() {
    let h = H::new();
    let o = replace_then_failing_install(&h);
    let before = h.tree();
    // Both the old jar's way back and the new jar's way back into place fail.
    let r = exec_failing(&h, &o.id, |src, _| {
        (named(src, "sodium-0.5.8.jar") && has_component(src, "files")) || (named(src, "sodium-0.5.9.jar") && has_component(src, "created"))
    });
    assert!(r.rolled_back);
    let m0 = r.statuses[0].message.as_deref().unwrap_or("");
    assert!(m0.contains("failed halfway"), "{m0}");
    let backup = r.backup_id.expect("id");
    let m = manifest::load(&h.st.guard, &h.snapshot(&backup)).expect("manifest");
    assert_eq!(m.records[0].state, manifest::RecState::Partial);
    assert!(fsops::is_absent(&h.mods.join("sodium-0.5.8.jar")) && fsops::is_absent(&h.mods.join("sodium-0.5.9.jar")));
    let o = recover(&h, &backup, &before);
    assert_eq!(o.ops.len(), 1, "only the old jar comes back: {:?}", o.ops);
}

#[test]
fn a_failed_placement_whose_revert_fails_is_partial_and_recoverable() {
    let h = H::new();
    h.replace_world();
    let before = h.tree();
    let o = h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]).expect("plan");
    // The download cannot be put into place, and the old jar cannot go back.
    let r = exec_failing(&h, &o.id, |src, dst| {
        named(dst, "sodium-0.5.9.jar") || (named(src, "sodium-0.5.8.jar") && has_component(src, "files"))
    });
    assert_eq!(r.statuses[0].state, OpState::Failed);
    assert!(parts_in_mods(&h).is_empty(), "our own .part is removed");
    let backup = r.backup_id.expect("id");
    let m = manifest::load(&h.st.guard, &h.snapshot(&backup)).expect("manifest");
    assert_eq!(m.records[0].state, manifest::RecState::Partial);
    recover(&h, &backup, &before);
}

#[test]
fn s5_an_undo_whose_rollback_fails_leaves_a_consistent_recoverable_manifest() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let before = h.tree();
    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/b.jar")]).expect("plan");
    let backup = h.exec(&o.id).0.expect("exec").backup_id.expect("id");
    let after_fix = h.tree();
    let u = plan_undo(&h.st, &backup, None).expect("plan undo");
    // Undo: b back first (ok), then a fails; rolling b forward again fails too.
    let r = exec_failing(&h, &u.id, |src, dst| named(src, "a.jar.disabled") || (named(src, "b.jar") && named(dst, "b.jar.disabled")));
    assert!(r.rolled_back);
    assert!(h.mods.join("b.jar").is_file() && h.mods.join("a.jar.disabled").is_file());
    let m = manifest::load(&h.st.guard, &h.snapshot(&backup)).expect("manifest");
    // The original order's records are untouched; the session says what broke.
    assert!(m.records.iter().all(|r| r.state == manifest::RecState::Done));
    let s = m.undo_log.last().expect("session");
    assert!(s.finished && s.rolled_back);
    assert_eq!(s.records[0].state, manifest::RecState::RollbackFailed);
    assert!(m.entry.undone_actions.is_empty());
    // The recovery reverts that undo (b goes back to disabled; only b's undo broke), and then
    // the fixes can be undone.
    recover_undo(&h, &backup, &after_fix, 1);
    let u = plan_undo(&h.st, &backup, None).expect("undo again");
    assert!(!h.exec(&u.id).0.expect("undo").rolled_back);
    assert_eq!(h.tree(), before);
}

#[test]
fn an_interrupted_undo_is_recovered() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let before = h.tree();
    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/b.jar")]).expect("plan");
    let backup = h.exec(&o.id).0.expect("exec").backup_id.expect("id");
    let after_fix = h.tree();
    let u = plan_undo(&h.st, &backup, None).expect("plan undo");
    exec_crashing(&h, &u.id, |s, _, dst| s == Stage::After && named(dst, "b.jar"));
    assert_eq!(status_of(&h, &backup), BackupStatus::Incomplete);
    crate::fix::recover::recover_one(&h.st, h.id());
    let m = manifest::load(&h.st.guard, &h.snapshot(&backup)).expect("manifest");
    assert!(m.undo_log.last().is_some_and(|s| s.interrupted && !s.finished));
    let o = recover_undo(&h, &backup, &after_fix, 2);
    assert_eq!(o.ops.len(), 1, "only b moved before the crash: {:?}", o.ops);
    let u = plan_undo(&h.st, &backup, None).expect("undo again");
    assert!(!h.exec(&u.id).0.expect("undo").rolled_back);
    assert_eq!(h.tree(), before);
}

#[test]
fn r4_recovering_an_interrupted_single_action_undo_never_touches_other_actions() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/b.jar")]).expect("plan");
    let backup = h.exec(&o.id).0.expect("exec").backup_id.expect("id");
    let after_fix = h.tree();
    let u = plan_undo(&h.st, &backup, Some(vec![0])).expect("plan undo of action 0");
    exec_crashing(&h, &u.id, |s, _, dst| s == Stage::After && named(dst, "a.jar"));
    assert!(h.mods.join("a.jar").is_file() && h.mods.join("b.jar.disabled").is_file());
    let m = manifest::load(&h.st.guard, &h.snapshot(&backup)).expect("manifest");
    assert_eq!(m.fix_needs_recovery(), Vec::<u32>::new(), "the order itself is fine");
    assert_eq!(m.undo_needs_recovery(), vec![0]);
    let o = recover_undo(&h, &backup, &after_fix, 1);
    assert_eq!(o.ops, vec![PlannedOp { action_index: 0, op: FileOp::Rename { from: "mods/a.jar".into(), to: "mods/a.jar.disabled".into() } }]);
    // Both actions can still be undone one by one.
    let u = plan_undo(&h.st, &backup, Some(vec![1])).expect("undo action 1");
    assert!(!h.exec(&u.id).0.expect("undo").rolled_back);
    assert!(h.mods.join("b.jar").is_file() && h.mods.join("a.jar.disabled").is_file());
    let u = plan_undo(&h.st, &backup, Some(vec![0])).expect("undo action 0");
    assert!(!h.exec(&u.id).0.expect("undo").rolled_back);
    assert!(h.mods.join("a.jar").is_file());
}

#[test]
fn r4_an_undo_of_a_replace_interrupted_halfway_is_reverted() {
    let h = H::new();
    h.jar("a.jar", "a");
    let (old, new) = h.replace_world();
    let o = h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER), disable("mods/a.jar")]).expect("plan");
    let backup = h.exec(&o.id).0.expect("exec").backup_id.expect("id");
    let after_fix = h.tree();
    let u = plan_undo(&h.st, &backup, Some(vec![0])).expect("plan undo of the replace");
    // Crash after the new jar went into created/, before the old jar came back.
    exec_crashing(&h, &u.id, |s, _, dst| s == Stage::After && has_component(dst, "created"));
    assert!(fsops::is_absent(&h.mods.join("sodium-0.5.9.jar")) && fsops::is_absent(&h.mods.join("sodium-0.5.8.jar")));
    let o = recover_undo(&h, &backup, &after_fix, 1);
    assert!(
        matches!(&o.ops[..], [PlannedOp { op: FileOp::Restore { to, .. }, .. }] if to == "mods/sodium-0.5.9.jar"),
        "{:?}",
        o.ops
    );
    assert_eq!(fs::read(h.mods.join("sodium-0.5.9.jar")).expect("new back"), new);
    assert_eq!(fs::read(h.snapshot(&backup).join("files/mods/sodium-0.5.8.jar")).expect("old in the backup"), old);
    // The replace can be undone normally afterwards.
    let u = plan_undo(&h.st, &backup, Some(vec![0])).expect("undo again");
    assert!(!h.exec(&u.id).0.expect("undo").rolled_back);
    assert_eq!(fs::read(h.mods.join("sodium-0.5.8.jar")).expect("old back"), old);
    assert!(h.mods.join("a.jar.disabled").is_file(), "the other action is untouched");
}

#[test]
fn an_interrupted_undo_that_cannot_be_reverted_is_finished() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/b.jar")]).expect("plan");
    let backup = h.exec(&o.id).0.expect("exec").backup_id.expect("id");
    let u = plan_undo(&h.st, &backup, Some(vec![0])).expect("plan undo of action 0");
    exec_crashing(&h, &u.id, |s, _, dst| s == Stage::After && named(dst, "a.jar"));
    // The user put something at the disabled name: reverting the undo would overwrite it.
    h.write("a.jar.disabled", b"theirs");
    let o = plan_undo(&h.st, &backup, None).expect("plan recovery");
    assert_eq!(o.actions.len(), 1);
    assert!(o.ops.is_empty(), "a.jar is already back: {:?}", o.ops);
    assert!(o.notes.iter().any(|n| n.contains("cannot be reverted") && n.contains("finishes that undo")), "{:?}", o.notes);
    let r = h.exec(&o.id).0.expect("execute recovery");
    assert!(!r.rolled_back);
    assert_eq!(status_of(&h, &backup), BackupStatus::Complete);
    let m = manifest::load(&h.st.guard, &h.snapshot(&backup)).expect("manifest");
    assert_eq!(m.entry.undone_actions, vec![0], "the undo of action 0 is finished");
    assert_eq!(fs::read(h.mods.join("a.jar.disabled")).expect("theirs"), b"theirs");
    assert!(h.mods.join("b.jar.disabled").is_file(), "action 1 untouched");
}

#[test]
fn r5_a_created_jar_edited_after_the_crash_is_left_in_place_and_the_backup_stays_incomplete() {
    let h = H::new();
    let (old, _) = h.replace_world();
    let o = h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]).expect("plan");
    exec_crashing(&h, &o.id, |s, _, dst| s == Stage::After && named(dst, "sodium-0.5.9.jar"));
    let backup = only_backup(&h);
    h.write("sodium-0.5.9.jar", b"edited by the user");
    let p = plan_undo(&h.st, &backup, None).expect("plan recovery");
    assert!(
        p.notes.iter().any(|n| n == "mods/sodium-0.5.9.jar was changed since the crash and was left in place; it may duplicate mods/sodium-0.5.8.jar."),
        "{:?}",
        p.notes
    );
    assert!(matches!(&p.ops[..], [PlannedOp { op: FileOp::Restore { to, .. }, .. }] if to == "mods/sodium-0.5.8.jar"), "{:?}", p.ops);
    let r = h.exec(&p.id).0.expect("execute recovery");
    assert!(r.statuses.iter().all(|s| s.state == OpState::Done), "{:?}", r.statuses);
    assert_eq!(fs::read(h.mods.join("sodium-0.5.8.jar")).expect("restored"), old);
    assert_eq!(fs::read(h.mods.join("sodium-0.5.9.jar")).expect("left"), b"edited by the user");
    // Never "rolledBack" (that would claim the files are as before the fixes).
    assert_eq!(status_of(&h, &backup), BackupStatus::Incomplete);
    let m = manifest::load(&h.st.guard, &h.snapshot(&backup)).expect("manifest");
    assert_eq!(m.undo_log.last().expect("session").left_in_place, vec!["mods/sodium-0.5.9.jar".to_string()]);
    let e = plan_undo(&h.st, &backup, None).expect_err("nothing left to recover");
    assert!(msg(&e).contains("mods/sodium-0.5.9.jar changed since the crash and was left in place"), "{e}");
}

// ── Recovery vs execution ────────────────────────────────────────────────────

#[test]
fn a_recovery_pass_during_an_execution_leaves_its_manifest_alone() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let st = h.st.clone();
    let id = h.id().to_string();
    let backups = h.backups.clone();
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let log = seen.clone();
    // At every move: a list_backups-style pass, then a look at the manifests on disk.
    let probe = move |st: &crate::state::AppState| {
        let st = st.clone();
        let id = id.clone();
        let backups = backups.clone();
        let log = log.clone();
        move |stage: Stage, _: &Path, _: &Path| {
            if stage == Stage::Before {
                crate::fix::recover::recover_one(&st, &id);
                let list = list_backups(&st.guard, &backups, &id).expect("list");
                for b in list {
                    let m = manifest::load(&st.guard, &backups.join(&b.id)).expect("manifest");
                    log.borrow_mut().push((m.interrupted, m.undo_log.iter().any(|s| s.interrupted)));
                }
            }
            Act::Go
        }
    };
    let o = h.plan(vec![disable("mods/a.jar"), disable("mods/b.jar")]).expect("plan");
    hook::set(probe(&st));
    let r = h.exec(&o.id).0.expect("exec");
    hook::clear();
    assert!(r.statuses.iter().all(|s| s.state == OpState::Done), "{:?}", r.statuses);
    let backup = r.backup_id.expect("id");
    assert_eq!(status_of(&h, &backup), BackupStatus::Complete);
    // The same during an undo of it (its session is appended to that manifest).
    let u = plan_undo(&h.st, &backup, None).expect("plan undo");
    hook::set(probe(&st));
    let r = h.exec(&u.id).0.expect("undo");
    hook::clear();
    assert!(!r.rolled_back, "{:?}", r.statuses);
    let seen = seen.borrow();
    assert_eq!(seen.len(), 4, "two moves each");
    assert!(seen.iter().all(|(order, undo)| !order && !undo), "{seen:?}");
    let m = manifest::load(&h.st.guard, &h.snapshot(&backup)).expect("manifest");
    assert!(!m.interrupted && m.undo_log.iter().all(|s| !s.interrupted && s.finished));
}

#[test]
fn a_recovery_pass_never_makes_an_execution_conflict() {
    let h = H::new();
    h.jar("a.jar", "a");
    let o = h.plan(vec![disable("mods/a.jar")]).expect("plan");
    let st = h.st.clone();
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let pass = std::thread::spawn(move || {
        // A slow recovery pass.
        let _recovery = st.fixes.recovery_lock();
        assert!(st.fixes.any_executing(), "the window may not close during a recovery pass");
        held_tx.send(()).expect("send");
        std::thread::sleep(std::time::Duration::from_millis(300));
    });
    held_rx.recv().expect("recv");
    assert!(!h.st.fixes.is_executing(h.id()), "a recovery pass holds no execution claim");
    let r = h.exec(&o.id).0.expect("the execution waits for the pass instead of failing");
    assert_eq!(r.statuses[0].state, OpState::Done);
    pass.join().expect("pass");
    assert!(!h.st.fixes.any_executing());
    // A real conflict names the instance, never its hex id.
    let o = h.plan(vec![enable("mods/a.jar.disabled")]).expect("plan");
    let claim = h.st.fixes.claim(h.id(), "Test Pack").expect("claim");
    let e = h.exec(&o.id).0.expect_err("conflict");
    drop(claim);
    assert!(matches!(e, Error::Conflict(_)), "{e:?}");
    assert!(msg(&e).contains("\"Test Pack\"") && !msg(&e).contains(h.id()), "{e}");
}

// ── Cross-volume copies ──────────────────────────────────────────────────────

#[test]
fn a_crash_mid_copy_across_volumes_leaves_a_recorded_temp_that_recovery_moves_away() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("a-copy.jar", "a");
    let o = h.plan(vec![remove_dup("mods/a.jar", "mods/a-copy.jar")]).expect("plan");
    let backup = h.exec(&o.id).0.expect("exec").backup_id.expect("id");
    let after_fix = h.tree();
    let u = plan_undo(&h.st, &backup, None).expect("plan undo");
    // The restore out of the snapshot copies across volumes, and the app dies with the copy
    // written next to its destination.
    hook::set(|s, src, _| match s {
        Stage::Before if has_component(src, "files") => Act::CrossDevice,
        Stage::Copied => Act::Crash,
        _ => Act::Go,
    });
    let r = std::panic::catch_unwind(AssertUnwindSafe(|| h.exec(&u.id)));
    hook::clear();
    assert!(r.is_err(), "the simulated crash did not happen");
    let temps = parts_in_mods(&h);
    assert_eq!(temps.len(), 1, "{temps:?}");
    assert!(temps[0].starts_with(".a-copy.jar.") && fsops::is_absent(&h.mods.join("a-copy.jar")), "{temps:?}");
    // The temp was named in the write-ahead record before it was created.
    let m = manifest::load(&h.st.guard, &h.snapshot(&backup)).expect("manifest");
    let rec = &m.undo_log.last().expect("session").records[0];
    assert_eq!(rec.state, manifest::RecState::Running);
    assert_eq!(rec.temps.iter().map(|t| t.path.clone()).collect::<Vec<_>>(), vec![format!("mods/{}", temps[0])]);

    crate::fix::recover::recover_one(&h.st, h.id());
    assert!(parts_in_mods(&h).is_empty(), "the leftover copy is moved out of mods/");
    let m = manifest::load(&h.st.guard, &h.snapshot(&backup)).expect("manifest");
    let moved = m.undo_log.last().expect("session").records[0].temps[0].backup.clone().expect("recorded as moved");
    assert!(moved.starts_with("created/mods/.a-copy.jar.") && h.snapshot(&backup).join(&moved).is_file(), "{moved}");
    // The source never left the snapshot, so reverting the undo has nothing to move.
    let o = recover_undo(&h, &backup, &after_fix, 1);
    assert!(o.ops.is_empty(), "{:?}", o.ops);
}

// ── No replacing moves ───────────────────────────────────────────────────────

#[test]
fn a_destination_created_right_before_the_move_is_never_replaced() {
    let h = H::new();
    h.jar("a.jar", "a");
    let o = h.plan(vec![disable("mods/a.jar")]).expect("plan");
    let target = h.mods.join("a.jar.disabled");
    // Another program creates the destination after the op's precondition check passed.
    hook::set(move |s, _, dst| {
        if s == Stage::Before && dst == target.as_path() {
            fs::write(dst, b"theirs").expect("race");
        }
        Act::Go
    });
    let r = h.exec(&o.id).0.expect("exec");
    hook::clear();
    assert_eq!(r.statuses[0].state, OpState::Failed);
    assert!(r.statuses[0].message.as_deref().unwrap_or("").contains("already exists"), "{:?}", r.statuses[0]);
    assert_eq!(fs::read(h.mods.join("a.jar.disabled")).expect("theirs"), b"theirs");
    assert!(h.mods.join("a.jar").is_file(), "the source stays");
    assert_eq!(status_of(&h, &r.backup_id.expect("id")), BackupStatus::RolledBack);
}

// ── Case-only Replace undo ───────────────────────────────────────────────────

#[test]
fn a_case_only_replace_is_undone() {
    if !crate::jar_id::CASE_INSENSITIVE_FS {
        eprintln!("skipped: case-sensitive filesystem");
        return;
    }
    let h = H::new();
    let old = fabric_jar("sodium", "0.5.8", &[]);
    let new = fabric_jar("sodium", "0.5.9", &[]);
    h.write("SODIUM.jar", &old);
    let current = h.version_json(CURRENT, PROJECT, "0.5.8", "2024-01-01T00:00:00Z", "SODIUM.jar", &old);
    h.mount_identify(json!({ sha1_hex(&old): current }));
    h.mount_version(h.version_json(NEWER, PROJECT, "0.5.9", "2024-03-01T00:00:00Z", "sodium.jar", &new));
    h.mount_cdn("sodium.jar", new.clone());
    let before = h.tree();
    let o = h.plan(vec![replace("mods/SODIUM.jar", NEWER)]).expect("plan");
    let r = h.exec(&o.id).0.expect("exec");
    assert_eq!(r.statuses[0].state, OpState::Done, "{:?}", r.statuses);
    let backup = r.backup_id.expect("id");
    let u = plan_undo(&h.st, &backup, None).expect("plan undo of a case-only replace");
    assert!(matches!(&u.ops[1].op, FileOp::Restore { to, .. } if to == "mods/SODIUM.jar"), "{:?}", u.ops);
    let r = h.exec(&u.id).0.expect("undo");
    assert!(!r.rolled_back, "{:?}", r.statuses);
    assert_eq!(h.tree(), before);
}

// ── Bound InstallDependency intents ──────────────────────────────────────────

#[test]
fn the_post_download_mod_id_check_ignores_case_like_planning() {
    let h = H::new();
    let dep = h.install_world();
    // Planned for `Cloth-Config` (matched case-insensitively against `cloth-config`); the jar
    // declares `cloth-config`.
    let o = h.plan(vec![install("Cloth-Config", DEP)]).expect("plan");
    let r = h.exec(&o.id).0.expect("exec");
    assert_eq!(r.statuses[0].state, OpState::Done, "{:?}", r.statuses);
    assert_eq!(fs::read(h.mods.join("cloth-config-11.jar")).expect("installed"), dep);
}

fn refused(r: Result<WorkOrder>, needle: &str) -> String {
    match r {
        Err(e @ Error::Invalid(_)) => {
            let m = msg(&e);
            assert!(m.contains(needle), "expected \"{needle}\" in: {m}");
            m
        }
        other => panic!("expected a refusal containing \"{needle}\", got {other:?}"),
    }
}

#[test]
fn install_needs_an_enabled_jar_that_requires_the_mod_id() {
    let h = H::new();
    h.install_world();
    refused(
        h.plan(vec![install("sodium", DEP)]),
        "Install Cloth Config 11.0.0: no enabled mod in this instance requires \"sodium\", so it is not installed. Rescan the instance and review the fixes again.",
    );
    // Only a disabled jar requires it.
    fs::rename(h.mods.join("needs-deps.jar"), h.mods.join("needs-deps.jar.disabled")).expect("disable");
    refused(h.plan(vec![install("cloth-config", DEP)]), "no enabled mod in this instance requires \"cloth-config\"");
    // Destination first: an existing file is refused before the dependency checks.
    h.write("cloth-config-11.jar", b"mine");
    refused(h.plan(vec![install("sodium", DEP)]), "already exists");
}

#[test]
fn install_of_something_already_provided_is_refused() {
    let h = H::new();
    h.install_world();
    // By a top-level jar's `provides`.
    h.write("cloth.jar", &fabric_jar("cloth-config-fork", "1.0", &["cloth_config"]));
    refused(h.plan(vec![install("cloth_config", DEP)]), "\"cloth_config\" is already provided by cloth.jar");
    fs::remove_file(h.mods.join("cloth.jar")).expect("rm");
    // By a nested jar of an enabled jar.
    let json = json!({"schemaVersion": 1, "id": "bundle", "version": "1.0", "jars": [{"file": "META-INF/jars/cc.jar"}]});
    let inner = crate::test_support::JarBuilder::new().fabric_mod_json(&json!({"schemaVersion": 1, "id": "cloth-config", "version": "11"}).to_string());
    let bundle = crate::test_support::JarBuilder::new().fabric_mod_json(&json.to_string()).nested("META-INF/jars/cc.jar", inner).build();
    h.write("bundle.jar", &bundle);
    refused(h.plan(vec![install("cloth-config", DEP)]), "already provided by cc.jar (bundled in bundle.jar)");
    // Nested in a disabled jar does not count.
    fs::rename(h.mods.join("bundle.jar"), h.mods.join("bundle.jar.disabled")).expect("disable");
    h.plan(vec![install("cloth-config", DEP)]).expect("needed again");
}

#[test]
fn built_in_ids_are_never_installed() {
    let h = H::new();
    h.install_world();
    for id in ["minecraft", "fabricloader", "Java", "mixinextras"] {
        refused(h.plan(vec![install(id, DEP)]), "part of the game or the mod loader itself");
    }
    let old_fabric = LoaderInfo { kind: LoaderKind::Fabric, version: Some("0.14.21".into()) };
    assert!(!crate::fix::plan::is_builtin_dependency("mixinextras", &old_fabric));
    let forge = LoaderInfo { kind: LoaderKind::Forge, version: None };
    assert!(!crate::fix::plan::is_builtin_dependency("mixinextras", &forge));
    assert!(crate::fix::plan::is_builtin_dependency("FML", &forge));
    assert!(!crate::fix::plan::is_builtin_dependency("fabric", &old_fabric), "fabric is Fabric API, not built in");
}

#[test]
fn install_of_a_lookalike_project_is_refused() {
    let h = H::new();
    // `modmenu` resolves to the real Mod Menu project; DEP is a lookalike project's version
    // (its jar even declares `modmenu`).
    h.write("needs-deps.jar", &fabric_jar_requiring("needs-deps", &["modmenu"]));
    let lookalike = fabric_jar("modmenu", "9.9.9", &[]);
    h.mount_version(h.version_json(DEP, DEP_PROJECT, "9.9.9", "2024-02-01T00:00:00Z", "modmenu-9.9.9.jar", &lookalike));
    h.mount_cdn("modmenu-9.9.9.jar", lookalike);
    let projects = json!([project_json(OTHER_PROJECT, "modmenu", "Mod Menu"), project_json(DEP_PROJECT, "mod-menu-plus", "Mod Menu+")]);
    h.mount(Mock::given(method("GET")).and(path("/v2/projects")).respond_with(ResponseTemplate::new(200).set_body_json(projects)));
    refused(
        h.plan(vec![install("modmenu", DEP)]),
        "Install Mod Menu+ 9.9.9: version 9.9.9 belongs to a different Modrinth project than the one Modpack Doctor finds for the mod id \"modmenu\"",
    );
}

#[test]
fn install_of_a_mod_id_not_on_modrinth_is_refused() {
    let h = H::new();
    h.install_world();
    h.write("needs-other.jar", &fabric_jar_requiring("needs-other", &["someprivatelib"]));
    h.mount(Mock::given(method("GET")).and(path("/v2/search")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"hits": []}))));
    refused(h.plan(vec![install("someprivatelib", DEP)]), "(it is not on Modrinth)");
}

// ── Fresh version fetch ──────────────────────────────────────────────────────

#[test]
fn the_planner_never_uses_a_cached_version() {
    let h = H::new();
    h.replace_world();
    let o = h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]).expect("first plan");
    h.st.fixes.discard(&o.id);
    // Modrinth now fails: no cached or stale copy may stand in.
    h.rt.block_on(h.server.reset());
    h.mount(Mock::given(method("GET")).and(path(format!("/v2/version/{NEWER}"))).respond_with(ResponseTemplate::new(503)));
    let e = h.plan(vec![replace("mods/sodium-0.5.8.jar", NEWER)]).expect_err("network failure fails the plan");
    assert!(matches!(e, Error::Network(_)), "{e:?}");
    assert!(msg(&e).contains("while checking \"Replace sodium-0.5.8.jar\""), "{e}");
}

#[test]
fn any_executing_tracks_claims() {
    let h = H::new();
    assert!(!h.st.fixes.any_executing());
    let t = h.st.fixes.claim(h.id(), "Test Pack").expect("claim");
    assert!(h.st.fixes.any_executing());
    drop(t);
    assert!(!h.st.fixes.any_executing());
}
