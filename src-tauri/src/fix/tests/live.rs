//! Live smoke of the fix engine on a COPY of a real instance (dev only, `#[ignore]`).
//!
//!   MODPACK_LIVE_SRC=<real game dir> MODPACK_LIVE_MC=1.20.1 MODPACK_LIVE_LOADER=forge \
//!     cargo test --release live_copy -- --ignored --nocapture
//!
//! Only `<src>/mods` is read, and only to copy it into a temp dir; everything else happens in the
//! copy. Real Modrinth API and CDN. Disables one jar, replaces one jar with a newer compatible
//! Modrinth version (real download, SHA-512, mod id check), checks the result, undoes both, and
//! requires the copy to be byte-identical to the start.

use std::fs;

use super::*;
use crate::model::BackupEntry;

fn loader_kind(s: &str) -> LoaderKind {
    match s {
        "forge" => LoaderKind::Forge,
        "neoforge" => LoaderKind::Neoforge,
        "fabric" => LoaderKind::Fabric,
        "quilt" => LoaderKind::Quilt,
        other => panic!("unknown loader {other}"),
    }
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("mkdir");
    for e in fs::read_dir(from).expect("read src mods").flatten() {
        let p = e.path();
        if p.is_dir() {
            copy_dir(&p, &to.join(e.file_name()));
        } else if p.is_file() {
            fs::copy(&p, to.join(e.file_name())).expect("copy");
        }
    }
}

#[test]
#[ignore = "live: real Modrinth + a copy of a real instance; set MODPACK_LIVE_SRC"]
fn live_copy() {
    let (Ok(src), Ok(mc), Ok(loader)) =
        (std::env::var("MODPACK_LIVE_SRC"), std::env::var("MODPACK_LIVE_MC"), std::env::var("MODPACK_LIVE_LOADER"))
    else {
        panic!("set MODPACK_LIVE_SRC, MODPACK_LIVE_MC, MODPACK_LIVE_LOADER");
    };
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime");
    let tmp = TempDir::new().expect("tmp");
    let base = dunce::canonicalize(tmp.path()).expect("canon");
    let game = base.join("Copy of instance");
    copy_dir(&Path::new(&src).join("mods"), &game.join("mods"));
    let mods = game.join("mods");
    let appdata = base.join("appdata");
    fs::create_dir_all(&appdata).expect("mkdir");

    let svc = ModrinthService::new(appdata.join("cache").join("modrinth"), appdata.join("cache").join("icons")).expect("svc");
    let st = AppState { modrinth: Some(svc.clone()), ..AppState::default() };
    st.pin_root(&appdata).expect("pin");
    st.fixes.set_backups_root(appdata.join("backups"));
    let kind = loader_kind(&loader);
    let mut inst = instance(&game, Launcher::Manual);
    inst.mc_version = Some(mc.clone());
    inst.loader = Some(LoaderInfo { kind, version: None });
    let roots = discovery::guard_roots(&game, &game);
    st.apply_discovery(Discovered { report: DiscoveryReport { instances: vec![inst.clone()], probes: Vec::new() }, roots })
        .expect("discovery");
    let remote = ClientRemote::new(svc.client(true).clone(), rt.handle().clone());
    let pack = PackIdentity { mc_version: mc.clone(), loader: LoaderInfo { kind, version: None } };
    let before = tree_of(&mods);
    println!("copied {} files", before.len());

    // Candidates: identified jars with a newer compatible release (same filter as the app).
    let scan = crate::scan::scan_mods_dir(&game, &inst.id, &st.guard, |_| {}, |_| {}).expect("scan");
    let top: Vec<_> = scan.jars.iter().filter(|j| j.depth == 0 && !j.disabled).collect();
    let sha1s: Vec<String> = top.iter().map(|j| j.sha1.clone()).collect();
    let mut loaders = vec![loader.clone()];
    if loader == "neoforge" && mc == "1.20.1" {
        loaders.push("forge".into());
    }
    if loader == "quilt" {
        loaders.push("fabric".into());
    }
    let client = svc.client(true).clone();
    let ident = rt.block_on(client.identify(&sha1s, false)).expect("identify");
    let ups = rt.block_on(client.find_updates(&sha1s, &loaders, std::slice::from_ref(&mc), &["release".into()], false)).expect("updates");

    // Replace: the first jar whose planned replace succeeds.
    let mut replaced = None;
    for j in &top {
        let (Some(cur), Some(up)) = (ident.found.get(&j.sha1), ups.found.get(&j.sha1)) else { continue };
        if up.id == cur.id {
            continue;
        }
        let action = FixAction::Replace { jar_id: j.id.clone(), version_id: up.id.clone() };
        match plan_order(&st, Some(&remote), &inst.id, &pack, std::slice::from_ref(&action)) {
            Ok(order) => {
                println!("replace {} {} -> {} {}", j.file_name, cur.version_number, up.version_number, order.title);
                replaced = Some((j.id.clone(), j.file_name.clone(), action, order));
                break;
            }
            Err(e) => println!("  skip {}: {e}", j.file_name),
        }
    }
    let (_, old_name, replace_action, _) = replaced.expect("no jar in this pack has a plannable Modrinth update");
    // Disable: another jar.
    let other = top.iter().find(|j| j.file_name != old_name).expect("a second jar");
    let disable = FixAction::Disable { jar_id: other.id.clone() };

    let order = plan_order(&st, Some(&remote), &inst.id, &pack, &[disable, replace_action]).expect("plan both");
    for op in &order.ops {
        println!("  op {:?}", op.op);
    }
    let events = Mutex::new(Vec::new());
    let emit = |s: OpStatus| events.lock().expect("events").push(s);
    let not_running = |_: &str| -> Result<GameStatus> { Ok(GameStatus { running: false, pids: Vec::new(), reason: None }) };
    let env = ExecEnv { remote: Some(&remote), game_status: &not_running, emit: &emit };
    let res = execute_order(&st, &order.id, &env).expect("execute");
    for s in &res.statuses {
        println!("  {:?} {:?}", s.state, s.message);
    }
    assert!(!res.rolled_back, "rolled back: {:?}", res.statuses);
    let after = tree_of(&mods);
    assert!(!after.contains_key(&old_name), "old jar still in mods/");
    assert!(after.contains_key(&format!("{}.disabled", other.file_name)), "disabled jar missing");
    let rescan = crate::scan::scan_mods_dir(&game, &inst.id, &st.guard, |_| {}, |_| {}).expect("rescan");
    println!("rescan: {} jars, {} errors", rescan.jars.iter().filter(|j| j.depth == 0).count(), rescan.issues.len());

    // Undo everything, then the copy must be byte-identical to the start.
    let root = st.fixes.backups_root().expect("root");
    let backups: Vec<BackupEntry> = list_backups(&st.guard, &root, &inst.id).expect("list");
    assert_eq!(backups.len(), 1);
    let undo = plan_undo(&st, &backups[0].id, None).expect("plan undo");
    let undo_res = execute_order(&st, &undo.id, &env).expect("execute undo");
    assert!(!undo_res.rolled_back, "undo rolled back: {:?}", undo_res.statuses);
    assert_eq!(tree_of(&mods), before, "copy differs from the start after undo");
    println!("undo restored the copy byte-identically ({} files)", before.len());
}
