//! The fix commands' helpers end to end through `AppState`: the real running-game guard over an
//! injected process list, the Modrinth setting, backups listing and discarding. Temp dirs only.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::*;
use crate::discovery::{self, Discovered, Os};
use crate::error::Error;
use crate::model::{DiscoveryReport, Instance, Launcher, LoaderInfo, LoaderKind, MetadataSource, OpState, Side};
use crate::process::{FakeProcesses, ProcInfo, Processes};
use crate::test_support::JarBuilder;

struct Fx {
    _t: tempfile::TempDir,
    rt: tokio::runtime::Runtime,
    st: AppState,
    fake: Arc<FakeProcesses>,
    inst: Instance,
    game: PathBuf,
}

fn fixture() -> Fx {
    let t = tempfile::tempdir().expect("tmp");
    let base = dunce::canonicalize(t.path()).expect("canon");
    let game = base.join("Pack");
    fs::create_dir_all(game.join("mods")).expect("mkdir");
    JarBuilder::new().fabric_mod_json(r#"{"schemaVersion":1,"id":"a","version":"1"}"#).write_to(&game.join("mods"), "a.jar");
    let appdata = base.join("appdata");
    fs::create_dir_all(&appdata).expect("mkdir");
    let fake = Arc::new(FakeProcesses::default());
    let st = AppState { processes: Processes(fake.clone()), ..AppState::default() };
    st.pin_root(&appdata).expect("pin");
    st.fixes.set_backups_root(appdata.join("backups"));
    let inst = Instance {
        id: discovery::instance_id(&game, Os::current()),
        name: "Pack".into(),
        launcher: Launcher::Manual,
        root: game.display().to_string(),
        game_dir: game.display().to_string(),
        mc_version: Some("1.20.1".into()),
        loader: Some(LoaderInfo { kind: LoaderKind::Fabric, version: None }),
        side: Side::Client,
        metadata_source: MetadataSource::Launcher,
        mod_count: 1,
    };
    let roots = discovery::guard_roots(&game, &game);
    st.apply_discovery(Discovered { report: DiscoveryReport { instances: vec![inst.clone()], probes: Vec::new() }, roots })
        .expect("apply");
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().expect("rt");
    Fx { _t: t, rt, st, fake, inst, game }
}

fn pack() -> PackIdentity {
    PackIdentity { mc_version: "1.20.1".into(), loader: LoaderInfo { kind: LoaderKind::Fabric, version: None } }
}

fn disable_a() -> Vec<FixAction> {
    vec![FixAction::Disable { jar_id: "mods/a.jar".into() }]
}

#[test]
fn the_real_game_guard_blocks_execution() {
    let fx = fixture();
    let order = plan_with(&fx.st, fx.rt.handle(), &fx.inst.id, &pack(), &disable_a()).expect("plan");
    fx.fake.set(vec![ProcInfo {
        pid: 777,
        name: "javaw.exe".into(),
        cmd: vec!["javaw.exe".into(), "--gameDir".into(), fx.game.display().to_string()],
        cwd: None,
    }]);
    let events = Mutex::new(Vec::new());
    let emit = |s: OpStatus| events.lock().expect("events").push(s);
    let e = execute_with(&fx.st, fx.rt.handle(), &order.id, &emit).expect_err("running");
    assert!(matches!(e, Error::GameRunning(_)), "{e:?}");
    assert!(fx.game.join("mods/a.jar").is_file(), "nothing touched");
    assert!(events.lock().expect("events").is_empty());
    assert!(list_backups_with(&fx.st, &fx.inst.id).expect("list").is_empty());

    fx.fake.set(Vec::new());
    let r = execute_with(&fx.st, fx.rt.handle(), &order.id, &emit).expect("execute");
    assert_eq!(r.statuses[0].state, OpState::Done);
    assert!(fx.game.join("mods/a.jar.disabled").is_file());
    assert_eq!(list_backups_with(&fx.st, &fx.inst.id).expect("list").len(), 1);
    let states: Vec<OpState> = events.lock().expect("events").iter().map(|e| e.state).collect();
    assert_eq!(states, vec![OpState::Running, OpState::Done]);
}

#[test]
fn modrinth_off_makes_downloads_offline_but_local_fixes_work() {
    let fx = fixture();
    fx.st
        .settings
        .update(|s| {
            s.modrinth_enabled = false;
            Ok(())
        })
        .expect("settings");
    let replace = vec![FixAction::Replace { jar_id: "mods/a.jar".into(), version_id: "AAAAAAAA".into() }];
    let e = plan_with(&fx.st, fx.rt.handle(), &fx.inst.id, &pack(), &replace).expect_err("offline");
    assert!(matches!(e, Error::Offline), "{e:?}");
    let install = vec![FixAction::InstallDependency { mod_id: "x".into(), version_id: "AAAAAAAA".into() }];
    let e = plan_with(&fx.st, fx.rt.handle(), &fx.inst.id, &pack(), &install).expect_err("offline");
    assert!(matches!(e, Error::Offline), "{e:?}");
    plan_with(&fx.st, fx.rt.handle(), &fx.inst.id, &pack(), &disable_a()).expect("local fixes need no network");
}

#[test]
fn discard_drops_the_order() {
    let fx = fixture();
    let order = plan_with(&fx.st, fx.rt.handle(), &fx.inst.id, &pack(), &disable_a()).expect("plan");
    fx.st.fixes.discard(&order.id);
    fx.st.fixes.discard(&order.id); // idempotent
    let e = execute_with(&fx.st, fx.rt.handle(), &order.id, &|_| {}).expect_err("discarded");
    assert!(matches!(e, Error::NotFound { .. }), "{e:?}");
    assert!(fx.game.join("mods/a.jar").is_file());
}

#[test]
fn backups_listing_without_a_root_or_folder() {
    let fx = fixture();
    assert!(list_backups_with(&fx.st, &fx.inst.id).expect("no folder yet").is_empty());
    let bare = AppState::default();
    let e = list_backups_with(&bare, &fx.inst.id).expect_err("no root");
    assert!(matches!(e, Error::Internal(_)), "{e:?}");
}

#[test]
fn mrpack_instances_are_never_changed() {
    let fx = fixture();
    let mut mrpack = fx.inst.clone();
    mrpack.launcher = Launcher::Mrpack;
    mrpack.metadata_source = MetadataSource::Mrpack;
    let roots = discovery::guard_roots(&fx.game, &fx.game);
    fx.st
        .apply_discovery(Discovered { report: DiscoveryReport { instances: vec![mrpack.clone()], probes: Vec::new() }, roots })
        .expect("apply");
    let e = plan_with(&fx.st, fx.rt.handle(), &mrpack.id, &pack(), &disable_a()).expect_err("mrpack");
    assert!(matches!(e, Error::Invalid(_)) && e.to_string().contains(".mrpack"), "{e:?}");
}
