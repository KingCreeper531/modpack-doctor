//! Scan orchestration behind `scan_instance`: in-flight tracking, the cached scanner, and
//! `ScanStarted` / `ScanProgress` emission through a [`ScanSink`] (Tauri events in the app,
//! a recorder in tests).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Runtime};
use tauri_specta::Event;

use crate::error::Result;
use crate::guard::PathGuard;
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

/// Scan a registered instance's `mods/` folder. Blocking: run it on a blocking thread.
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
    scan::scan_mods_dir_cached(
        &inst.game_dir,
        id,
        guard,
        Some(cache),
        |stubs| sink.started(ScanStarted { instance_id: id.to_string(), jars: stubs.to_vec() }),
        |p| sink.progress(p),
    )
}
