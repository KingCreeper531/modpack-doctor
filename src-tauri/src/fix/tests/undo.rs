//! Undo: every action kind, per-action selection, refusals after manual changes.

use std::fs;

use super::*;
use crate::error::Error;
use crate::model::{FileOp, OpState, WorkOrderKind};

fn run(h: &H, actions: Vec<FixAction>) -> String {
    let o = h.plan(actions).expect("plan");
    let r = h.exec(&o.id).0.expect("execute");
    assert!(r.statuses.iter().all(|s| s.state == OpState::Done), "{:?}", r.statuses);
    r.backup_id.expect("backup id")
}

fn undo_all(h: &H, backup: &str) -> WorkOrderResult {
    let o = plan_undo(&h.st, backup, None).expect("plan undo");
    assert_eq!(o.kind, WorkOrderKind::Undo);
    let r = h.exec(&o.id).0.expect("execute undo");
    assert!(r.statuses.iter().all(|s| s.state == OpState::Done), "{:?}", r.statuses);
    assert_eq!(r.backup_id.as_deref(), Some(backup));
    r
}

#[test]
fn undo_disable_and_enable() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar.disabled", "b");
    let before = h.tree();
    let backup = run(&h, vec![disable("mods/a.jar"), enable("mods/b.jar")]);
    let o = plan_undo(&h.st, &backup, None).expect("plan undo");
    // Reverse order: enable is undone first.
    assert_eq!(o.ops[0].op, FileOp::Rename { from: "mods/b.jar".into(), to: "mods/b.jar.disabled".into() });
    assert_eq!(o.ops[1].op, FileOp::Rename { from: "mods/a.jar.disabled".into(), to: "mods/a.jar".into() });
    assert_eq!(o.title, "Undo disable a.jar, enable b.jar");
    assert_eq!(o.backup_dir, h.snapshot(&backup).display().to_string());
    h.st.fixes.discard(&o.id);
    undo_all(&h, &backup);
    assert_eq!(h.tree(), before);
    assert_eq!(h.backups()[0].undone_actions, vec![0, 1]);
    let e = plan_undo(&h.st, &backup, None).expect_err("nothing left");
    assert!(msg(&e).contains("already undone"), "{e}");
    let e = plan_undo(&h.st, &backup, Some(vec![0])).expect_err("already undone");
    assert!(msg(&e).contains("Undo disable a.jar: it was already undone"), "{e}");
}

#[test]
fn undo_a_single_action() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let backup = run(&h, vec![disable("mods/a.jar"), disable("mods/b.jar")]);
    let o = plan_undo(&h.st, &backup, Some(vec![1])).expect("plan undo");
    assert_eq!(o.actions, vec![disable("mods/b.jar")]);
    assert_eq!(o.ops.len(), 1);
    assert_eq!(o.ops[0].action_index, 0);
    h.exec(&o.id).0.expect("undo");
    assert!(h.mods.join("b.jar").is_file());
    assert!(h.mods.join("a.jar.disabled").is_file());
    assert_eq!(h.backups()[0].undone_actions, vec![1]);
    // The rest can still be undone.
    undo_all(&h, &backup);
    assert!(h.mods.join("a.jar").is_file());
    assert_eq!(h.backups()[0].undone_actions, vec![0, 1]);
}

#[test]
fn undo_remove_duplicate_restores_from_the_snapshot() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("a-copy.jar", "a");
    let before = h.tree();
    let backup = run(&h, vec![remove_dup("mods/a.jar", "mods/a-copy.jar")]);
    let o = plan_undo(&h.st, &backup, None).expect("plan");
    assert_eq!(
        o.ops[0].op,
        FileOp::Restore { backup_path: "files/mods/a-copy.jar".into(), to: "mods/a-copy.jar".into(), expect_absent_or_sha1: None }
    );
    h.st.fixes.discard(&o.id);
    undo_all(&h, &backup);
    assert_eq!(h.tree(), before);
}

#[test]
fn undo_replace_puts_the_old_jar_back_and_keeps_the_new_one_in_the_snapshot() {
    let h = H::new();
    let (_, new) = h.replace_world();
    let before = h.tree();
    let backup = run(&h, vec![replace("mods/sodium-0.5.8.jar", NEWER)]);
    let o = plan_undo(&h.st, &backup, None).expect("plan");
    assert!(matches!(&o.ops[0].op, FileOp::RemoveCreated { path, .. } if path == "mods/sodium-0.5.9.jar"), "{:?}", o.ops);
    assert!(matches!(&o.ops[1].op, FileOp::Restore { to, .. } if to == "mods/sodium-0.5.8.jar"), "{:?}", o.ops);
    h.st.fixes.discard(&o.id);
    undo_all(&h, &backup);
    assert_eq!(h.tree(), before);
    let snap = h.snapshot(&backup);
    assert_eq!(fs::read(snap.join("created/mods/sodium-0.5.9.jar")).expect("kept"), new);
}

#[test]
fn undo_install_moves_the_dependency_into_the_snapshot() {
    let h = H::new();
    h.install_world();
    let before = h.tree();
    let backup = run(&h, vec![install("cloth-config", DEP)]);
    assert!(h.mods.join("cloth-config-11.jar").is_file());
    undo_all(&h, &backup);
    assert_eq!(h.tree(), before);
    assert!(h.snapshot(&backup).join("created/mods/cloth-config-11.jar").is_file());
}

#[test]
fn undo_is_refused_after_a_manual_change() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    h.jar("c.jar", "c");
    h.jar("c-copy.jar", "c");
    let backup = run(&h, vec![disable("mods/a.jar"), disable("mods/b.jar"), remove_dup("mods/c.jar", "mods/c-copy.jar")]);

    // The user replaced the disabled jar's content.
    h.write("a.jar.disabled", b"edited by the user");
    let e = plan_undo(&h.st, &backup, Some(vec![0])).expect_err("changed");
    assert!(matches!(e, Error::Invalid(_)), "{e:?}");
    assert!(msg(&e).contains("Undo disable a.jar: mods/a.jar.disabled was changed since the fix"), "{e}");
    // The whole-backup undo is refused as well (never a partial silent overwrite).
    assert!(plan_undo(&h.st, &backup, None).is_err());

    // The user re-created the original name.
    h.write("b.jar", b"new b");
    let e = plan_undo(&h.st, &backup, Some(vec![1])).expect_err("exists");
    assert!(msg(&e).contains("mods/b.jar exists again"), "{e}");

    // The removed copy came back by hand.
    h.write("c-copy.jar", b"restored by hand");
    let e = plan_undo(&h.st, &backup, Some(vec![2])).expect_err("exists");
    assert!(msg(&e).contains("mods/c-copy.jar exists again"), "{e}");
    fs::remove_file(h.mods.join("c-copy.jar")).expect("rm");
    // The snapshot copy was tampered with.
    fs::write(h.snapshot(&backup).join("files/mods/c-copy.jar"), b"tampered").expect("write");
    let e = plan_undo(&h.st, &backup, Some(vec![2])).expect_err("tampered");
    assert!(msg(&e).contains("the backup copy files/mods/c-copy.jar was changed"), "{e}");
}

#[test]
fn undo_rechecks_at_execution() {
    let h = H::new();
    h.jar("a.jar", "a");
    h.jar("b.jar", "b");
    let backup = run(&h, vec![disable("mods/a.jar"), disable("mods/b.jar")]);
    let o = plan_undo(&h.st, &backup, None).expect("plan");
    // Between planning and executing the undo the user edits a.jar.disabled.
    std::thread::sleep(std::time::Duration::from_millis(20));
    h.write("a.jar.disabled", b"edited");
    let before = h.tree();
    let r = h.exec(&o.id).0.expect("execute");
    assert!(r.rolled_back);
    assert_eq!(h.tree(), before);
    assert!(h.backups()[0].undone_actions.is_empty(), "a rolled-back undo records nothing");
    assert_eq!(fs::read(h.mods.join("a.jar.disabled")).expect("kept"), b"edited");
}

#[test]
fn backup_ids_are_validated() {
    let h = H::new();
    for bad in ["", "x", "../../etc/1", "0123456789ABCDEF/1", "0123456789abcdef/1/2"] {
        let e = plan_undo(&h.st, bad, None).expect_err("invalid");
        assert!(matches!(e, Error::Invalid(_)), "{bad}: {e:?}");
    }
    let e = plan_undo(&h.st, &format!("{}/123", h.id()), None).expect_err("missing");
    assert!(matches!(e, Error::NotFound { .. }), "{e:?}");
    h.jar("a.jar", "a");
    let backup = run(&h, vec![disable("mods/a.jar")]);
    let e = plan_undo(&h.st, &backup, Some(vec![5])).expect_err("no such action");
    assert!(msg(&e).contains("no action 6"), "{e}");
}

#[test]
fn manual_actions_have_nothing_to_undo() {
    let h = H::new();
    h.jar("a.jar", "a");
    let backup = run(&h, vec![FixAction::Manual { steps: vec!["Install Java 21".into()] }, disable("mods/a.jar")]);
    let e = plan_undo(&h.st, &backup, Some(vec![0])).expect_err("manual");
    assert!(msg(&e).contains("manual steps changed no files"), "{e}");
    let o = plan_undo(&h.st, &backup, None).expect("plan");
    assert_eq!(o.actions, vec![disable("mods/a.jar")]);
}
