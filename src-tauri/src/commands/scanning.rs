//! Scan orchestration behind `scan_instance`: in-flight tracking, the cached scanner, and
//! `ScanStarted` / `ScanProgress` emission through a [`ScanSink`] (Tauri events in the app,
//! a recorder in tests).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Runtime};
use tauri_specta::Event;

use crate::error::Result;
use crate::guard::PathGuard;
use crate::instance_config;
use crate::model::{ScanProgress, ScanResult, ScanStarted};
use crate::scan::{self, ScanCache};
use crate::state::{InFlight, RegisteredInstance};

/// Receives scan events. `progress` is called from rayon worker threads, concurrently.
pub trait ScanSink: Sync {
    fn started(&self, event: ScanStarted);
    fn progress(&self, event: ScanProgress);
}

/// Emits the typed tauri-specta events to every webview. Emission errors are logged once per
/// scan and otherwise ignored, so they never slow or fail the scan.
pub struct EventSink<R: Runtime> {
    app: AppHandle<R>,
    logged: AtomicBool,
}

impl<R: Runtime> EventSink<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app, logged: AtomicBool::new(false) }
    }

    fn log(&self, what: &str, e: tauri::Error) {
        if !self.logged.swap(true, Ordering::Relaxed) {
            eprintln!("scan: could not emit {what}: {e}");
        }
    }
}

impl<R: Runtime> ScanSink for EventSink<R> {
    fn started(&self, event: ScanStarted) {
        if let Err(e) = event.emit(&self.app) {
            self.log("ScanStarted", e);
        }
    }

    fn progress(&self, event: ScanProgress) {
        if let Err(e) = event.emit(&self.app) {
            self.log("ScanProgress", e);
        }
    }
}

/// Scan a registered instance's `mods/` folder, then read the config files that change what the
/// loader enforces (`config/fml.toml`, `config/connector.json`; see `instance_config`) into
/// `ScanResult.loader_config`. Blocking: run it on a blocking thread.
///
/// Rejects a second concurrent scan of the same instance with a Conflict error. Emits
/// `ScanStarted` exactly once (before any progress), then one `ScanProgress` per top-level jar.
pub fn scan_registered(
    guard: &PathGuard,
    cache: &ScanCache,
    scans: &InFlight,
    inst: &RegisteredInstance,
    sink: &dyn ScanSink,
) -> Result<ScanResult> {
    let _ticket = scans.begin(&inst.instance.id, &inst.instance.name)?;
    let id = inst.instance.id.as_str();
    let mut res = scan::scan_mods_dir_cached(
        &inst.game_dir,
        id,
        guard,
        Some(cache),
        |stubs| sink.started(ScanStarted { instance_id: id.to_string(), jars: stubs.to_vec() }),
        |p| sink.progress(p),
    )?;
    instance_config::attach(&mut res, &inst.game_dir, guard);
    Ok(res)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::discovery::{self, Discovered, Os};
    use crate::model::{DiscoveryReport, Instance, Launcher, MetadataSource, Side};
    use crate::state::AppState;

    struct Quiet;
    impl ScanSink for Quiet {
        fn started(&self, _: ScanStarted) {}
        fn progress(&self, _: ScanProgress) {}
    }

    #[test]
    fn scan_attaches_instance_loader_config() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let game = dunce::canonicalize(tmp.path()).expect("canon");
        fs::create_dir_all(game.join("mods")).expect("mods");
        fs::create_dir_all(game.join("config")).expect("config");
        fs::write(game.join("config/fml.toml"), "dependencyOverrides.create = [\"-flywheel\"]\n").expect("write");
        fs::write(game.join("config/connector.json"), "not json").expect("write");
        let inst = Instance {
            id: discovery::instance_id(&game, Os::current()),
            name: "Pack".into(),
            launcher: Launcher::Manual,
            root: game.display().to_string(),
            game_dir: game.display().to_string(),
            mc_version: None,
            loader: None,
            side: Side::Client,
            metadata_source: MetadataSource::Inferred,
            mod_count: 0,
        };
        let roots = discovery::guard_roots(&game, &game);
        let st = AppState::default();
        st.apply_discovery(Discovered { report: DiscoveryReport { instances: vec![inst.clone()], probes: Vec::new() }, roots })
            .expect("apply");
        let reg = st.instance(&inst.id).expect("registered");
        let res = scan_registered(&st.guard, &st.scan_cache, &st.scans, &reg, &Quiet).expect("scan");
        let cfg = res.loader_config.expect("loader config");
        assert_eq!(cfg.source_files, vec!["config/fml.toml", "config/connector.json"]);
        assert_eq!(cfg.fml_dependency_overrides.len(), 1);
        assert_eq!(cfg.fml_dependency_overrides[0].entries, vec!["-flywheel"]);
        assert_eq!(cfg.connector, None);
        assert!(res.issues.iter().any(|i| i.subject == "config/connector.json"), "{:?}", res.issues);
    }
}
