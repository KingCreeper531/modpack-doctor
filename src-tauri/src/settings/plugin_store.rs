//! [`SettingsStore`] backed by tauri-plugin-store (`<app data dir>/settings.json`).
//!
//! The plugin silently replaces an unparseable file with an empty store, which would lose the
//! user's file on the next save. So the file is checked here before the store is opened, and a
//! corrupt file is reported as [`RawDoc::Corrupt`] (the service then writes a `.bak` first).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{Map, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::{Store, StoreExt};

use super::{backup_file, parse_bytes, RawDoc, SettingsStore, SETTINGS_FILE};
use crate::error::{Error, Result};

pub struct PluginStore<R: Runtime> {
    store: Arc<Store<R>>,
    path: PathBuf,
    /// Set when the file on disk was not a JSON object at open time (until the next write).
    corrupt: AtomicBool,
    corrupt_reason: String,
}

impl<R: Runtime> PluginStore<R> {
    /// Open (or create) the settings store. Blocking (reads the file once).
    pub fn open(app: &AppHandle<R>) -> Result<Self> {
        let path = tauri_plugin_store::resolve_store_path(app, SETTINGS_FILE)
            .map_err(|e| Error::Internal(format!("could not resolve the settings file location: {e}")))?;
        let (corrupt, corrupt_reason) = match std::fs::read(&path) {
            Ok(bytes) => match parse_bytes(&bytes) {
                RawDoc::Corrupt(reason) => (true, reason),
                _ => (false, String::new()),
            },
            Err(_) => (false, String::new()),
        };
        let store = app
            .store_builder(SETTINGS_FILE)
            .disable_auto_save()
            .build()
            .map_err(|e| Error::Internal(format!("could not open the settings store: {e}")))?;
        Ok(Self { store, path, corrupt: AtomicBool::new(corrupt), corrupt_reason })
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl<R: Runtime> SettingsStore for PluginStore<R> {
    fn read(&self) -> Result<RawDoc> {
        if self.corrupt.load(Ordering::SeqCst) {
            return Ok(RawDoc::Corrupt(self.corrupt_reason.clone()));
        }
        if self.store.is_empty() && !self.path.exists() {
            return Ok(RawDoc::Missing);
        }
        Ok(RawDoc::Doc(self.store.entries().into_iter().collect()))
    }

    fn write(&self, doc: &Map<String, Value>) -> Result<()> {
        for key in self.store.keys() {
            if !doc.contains_key(&key) {
                self.store.delete(&key);
            }
        }
        for (k, v) in doc {
            self.store.set(k.clone(), v.clone());
        }
        self.store.save().map_err(|e| match e {
            tauri_plugin_store::Error::Io(io) => Error::io(&self.path, io),
            other => Error::Internal(format!("could not save the settings: {other}")),
        })?;
        self.corrupt.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn backup(&self) -> Result<()> {
        backup_file(&self.path)
    }
}
