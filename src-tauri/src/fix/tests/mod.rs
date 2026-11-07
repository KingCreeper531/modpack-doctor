//! Fix engine tests. Temp dirs only (never a real instance) and no real network: Modrinth and
//! the CDN are wiremock servers driven through the real `ModrinthClient`.

mod exec;
mod live;
mod plan;
mod undo;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;
use crate::discovery::{self, Discovered, Os};
use crate::model::{
    DiscoveryReport, FixAction, GameStatus, Instance, Launcher, LoaderInfo, LoaderKind, MetadataSource, OpStatus,
    PackIdentity, Side, WorkOrderResult,
};
use crate::modrinth::ModrinthService;
use crate::state::AppState;
use crate::test_support::JarBuilder;

pub(super) const PROJECT: &str = "PRoj0001";
pub(super) const OTHER_PROJECT: &str = "OTHer001";
pub(super) const CURRENT: &str = "CURver01";
pub(super) const NEWER: &str = "NEWver01";
pub(super) const DEP: &str = "DEPver01";
pub(super) const DEP_PROJECT: &str = "DEPprj01";

pub(super) fn sha512_hex(b: &[u8]) -> String {
    hex::encode(Sha512::digest(b))
}

pub(super) fn sha1_hex(b: &[u8]) -> String {
    fsops::sha1_bytes(b)
}

/// A Fabric jar declaring `mod_id` (and `provides`).
pub(super) fn fabric_jar(mod_id: &str, version: &str, provides: &[&str]) -> Vec<u8> {
    let json = json!({"schemaVersion": 1, "id": mod_id, "version": version, "provides": provides});
    JarBuilder::new().fabric_mod_json(&json.to_string()).build()
}

pub(super) struct H {
    pub rt: tokio::runtime::Runtime,
    pub server: MockServer,
    _tmp: TempDir,
    pub st: AppState,
    pub inst: Instance,
    pub mods: PathBuf,
    pub backups: PathBuf,
    pub remote: ClientRemote,
}

pub(super) fn instance(dir: &Path, launcher: Launcher) -> Instance {
    Instance {
        id: discovery::instance_id(dir, Os::current()),
        name: "Test Pack".into(),
        launcher,
        root: dir.display().to_string(),
        game_dir: dir.display().to_string(),
        mc_version: Some("1.20.1".into()),
        loader: Some(LoaderInfo { kind: LoaderKind::Fabric, version: Some("0.15.11".into()) }),
        side: Side::Client,
        metadata_source: MetadataSource::Launcher,
        mod_count: 0,
    }
}

impl H {
    pub fn new() -> H {
        Self::with(|_| {})
    }

    /// `prepare(game_dir)` runs before discovery registers the instance (e.g. link `mods/`).
    pub fn with(prepare: impl FnOnce(&Path)) -> H {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime");
        let server = rt.block_on(MockServer::start());
        let tmp = TempDir::new().expect("tmp");
        let base = dunce::canonicalize(tmp.path()).expect("canon");
        let game = base.join("instances").join("Test Pack");
        fs::create_dir_all(&game).expect("mkdir");
        fs::create_dir_all(base.join("outside")).expect("mkdir");
        prepare(&game);
        let mods = game.join("mods");
        fs::create_dir_all(&mods).expect("mkdir mods");
        let appdata = base.join("appdata");
        fs::create_dir_all(&appdata).expect("mkdir");

        let svc = ModrinthService::for_tests(
            server.uri(),
            server.address().to_string(),
            appdata.join("cache").join("modrinth"),
            appdata.join("cache").join("icons"),
        );
        let st = AppState { modrinth: Some(svc.clone()), ..AppState::default() };
        st.pin_root(&appdata).expect("pin");
        let backups = appdata.join("backups");
        st.fixes.set_backups_root(backups.clone());
        let inst = instance(&game, Launcher::Prism);
        let roots = discovery::guard_roots(&game, &game);
        st.apply_discovery(Discovered { report: DiscoveryReport { instances: vec![inst.clone()], probes: Vec::new() }, roots })
            .expect("apply discovery");
        let remote = ClientRemote::new(svc.client(true).clone(), rt.handle().clone());
        H { rt, server, _tmp: tmp, st, inst, mods, backups, remote }
    }

    pub fn id(&self) -> &str {
        &self.inst.id
    }

    pub fn pack(&self) -> PackIdentity {
        PackIdentity {
            mc_version: "1.20.1".into(),
            loader: LoaderInfo { kind: LoaderKind::Fabric, version: Some("0.15.11".into()) },
        }
    }

    pub fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let p = self.mods.join(name);
        fs::write(&p, bytes).expect("write");
        p
    }

    pub fn jar(&self, name: &str, mod_id: &str) -> Vec<u8> {
        let b = fabric_jar(mod_id, "1.0.0", &[]);
        self.write(name, &b);
        b
    }

    pub fn plan(&self, actions: Vec<FixAction>) -> Result<WorkOrder> {
        plan_order(&self.st, Some(&self.remote), self.id(), &self.pack(), &actions)
    }

    pub fn plan_offline(&self, actions: Vec<FixAction>) -> Result<WorkOrder> {
        plan_order(&self.st, None, self.id(), &self.pack(), &actions)
    }

    /// Execute with the game reported as not running; returns the result and every event.
    pub fn exec(&self, order_id: &str) -> (Result<WorkOrderResult>, Vec<OpStatus>) {
        self.exec_with(order_id, |_| Ok(GameStatus { running: false, pids: Vec::new(), reason: None }))
    }

    pub fn exec_with(&self, order_id: &str, game: impl Fn(&str) -> Result<GameStatus>) -> (Result<WorkOrderResult>, Vec<OpStatus>) {
        let events = Mutex::new(Vec::new());
        let emit = |s: OpStatus| events.lock().expect("events").push(s);
        let env = ExecEnv { remote: Some(&self.remote), game_status: &game, emit: &emit };
        let r = execute_order(&self.st, order_id, &env);
        (r, events.into_inner().expect("events"))
    }

    /// Every file under `mods/` (recursively, hidden files included): relative path → sha1.
    pub fn tree(&self) -> BTreeMap<String, String> {
        tree_of(&self.mods)
    }

    pub fn backups(&self) -> Vec<crate::model::BackupEntry> {
        list_backups(&self.st.guard, &self.backups, self.id()).expect("list backups")
    }

    pub fn snapshot(&self, backup_id: &str) -> PathBuf {
        let (inst, ms) = backup_id.split_once('/').expect("backup id");
        self.backups.join(inst).join(ms)
    }

    // ── Modrinth mocks ──────────────────────────────────────────────────────

    pub fn cdn_url(&self, file: &str) -> String {
        format!("{}/data/{PROJECT}/versions/x/{file}", self.server.uri())
    }

    pub fn mount(&self, m: Mock) {
        self.rt.block_on(m.mount(&self.server));
    }

    pub fn mount_version(&self, v: Value) {
        let id = v["id"].as_str().expect("id").to_string();
        self.mount(Mock::given(method("GET")).and(path(format!("/v2/version/{id}"))).respond_with(ResponseTemplate::new(200).set_body_json(v)));
    }

    /// `POST /v2/version_files` answers `answer` (sha1 → version JSON).
    pub fn mount_identify(&self, answer: Value) {
        self.mount(Mock::given(method("POST")).and(path("/v2/version_files")).respond_with(ResponseTemplate::new(200).set_body_json(answer)));
    }

    pub fn mount_cdn(&self, file: &str, bytes: Vec<u8>) {
        self.mount(
            Mock::given(method("GET"))
                .and(path(format!("/data/{PROJECT}/versions/x/{file}")))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes)),
        );
    }

    /// API version JSON with one primary file served from the mock CDN.
    pub fn version_json(&self, id: &str, project: &str, number: &str, date: &str, file: &str, bytes: &[u8]) -> Value {
        json!({
            "id": id,
            "project_id": project,
            "version_number": number,
            "name": number,
            "game_versions": ["1.20.1"],
            "loaders": ["fabric"],
            "version_type": "release",
            "date_published": date,
            "files": [{
                "url": self.cdn_url(file),
                "filename": file,
                "primary": true,
                "size": bytes.len(),
                "hashes": {"sha1": sha1_hex(bytes), "sha512": sha512_hex(bytes)},
                "file_type": null
            }],
            "dependencies": []
        })
    }

    /// The standard replace world: `mods/sodium-0.5.8.jar` (mod id `sodium`) is version CURRENT
    /// of PROJECT; NEWER (published later) ships `sodium-0.5.9.jar`. Returns (old, new) bytes.
    pub fn replace_world(&self) -> (Vec<u8>, Vec<u8>) {
        let old = fabric_jar("sodium", "0.5.8", &[]);
        let new = fabric_jar("sodium", "0.5.9", &[]);
        self.write("sodium-0.5.8.jar", &old);
        let current = self.version_json(CURRENT, PROJECT, "0.5.8", "2024-01-01T00:00:00Z", "sodium-0.5.8.jar", &old);
        self.mount_identify(json!({ sha1_hex(&old): current }));
        self.mount_version(self.version_json(NEWER, PROJECT, "0.5.9", "2024-03-01T00:00:00.5Z", "sodium-0.5.9.jar", &new));
        self.mount_cdn("sodium-0.5.9.jar", new.clone());
        (old, new)
    }

    /// The standard install world: DEP ships `cloth-config-11.jar` declaring `cloth-config`
    /// and providing `cloth_config`. Returns its bytes.
    pub fn install_world(&self) -> Vec<u8> {
        let dep = fabric_jar("cloth-config", "11.0.0", &["cloth_config"]);
        self.mount_version(self.version_json(DEP, DEP_PROJECT, "11.0.0", "2024-02-01T00:00:00Z", "cloth-config-11.jar", &dep));
        self.mount_cdn("cloth-config-11.jar", dep.clone());
        dep
    }
}

pub(super) fn tree_of(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(base).expect("prefix").to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                walk(base, &p, out);
                out.insert(format!("{rel}/"), String::new());
            } else {
                out.insert(rel, fsops::sha1_file(&p).expect("hash"));
            }
        }
    }
    walk(dir, dir, &mut out);
    out
}

pub(super) fn disable(id: &str) -> FixAction {
    FixAction::Disable { jar_id: id.into() }
}

pub(super) fn enable(id: &str) -> FixAction {
    FixAction::Enable { jar_id: id.into() }
}

pub(super) fn replace(id: &str, version: &str) -> FixAction {
    FixAction::Replace { jar_id: id.into(), version_id: version.into() }
}

pub(super) fn install(mod_id: &str, version: &str) -> FixAction {
    FixAction::InstallDependency { mod_id: mod_id.into(), version_id: version.into() }
}

pub(super) fn remove_dup(keep: &str, remove: &str) -> FixAction {
    FixAction::RemoveDuplicate { keep: keep.into(), remove: remove.into() }
}

/// The error's user-facing message.
pub(super) fn msg(e: &crate::error::Error) -> String {
    e.to_string()
}

/// Directory link that needs no privilege: junction on Windows, symlink elsewhere. False when
/// the platform refuses (the test is then skipped).
pub(super) fn link_dir(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}
