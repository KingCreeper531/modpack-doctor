//! Settings persistence (tauri-plugin-store, Rust-side only). Owner: M3 agent J.
//!
//! The file is `<app data dir>/settings.json` (`%APPDATA%\io.github.kingcreeper531.modpackdoctor`
//! on Windows): one JSON object whose keys are the camelCase `Settings` fields. Decoding is
//! forward-compatible and per field:
//! - a missing field takes its default;
//! - an unknown key is ignored, but kept and written back (a newer build's settings survive a
//!   downgrade);
//! - an invalid field (or invalid list/map entry) falls back to its default / is dropped;
//! - a file that is not a JSON object at all yields defaults.
//!
//! Whenever decoding lost information (corrupt file or an invalid value), the original file is
//! copied to `settings.json.bak` before the normalised settings are written back.
//!
//! The pure logic (`decode`, `encode`, [`apply_patch`], [`SettingsService`]) works against the
//! [`SettingsStore`] trait, so it is testable without a Tauri runtime: [`FileStore`] and
//! [`MemoryStore`] implement it for tests, [`plugin_store::PluginStore`] for the app.

pub mod plugin_store;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::model::{Launcher, LauncherRoot, PackOverride, Settings, SettingsPatch};

/// File name of the settings store, relative to the app data dir.
pub const SETTINGS_FILE: &str = "settings.json";
/// Inspector width bounds (px). Patches and decoded values are clamped into this range.
pub const INSPECTOR_WIDTH_MIN: u32 = 280;
pub const INSPECTOR_WIDTH_MAX: u32 = 640;
/// Longest accepted override version string.
const MAX_VERSION_LEN: usize = 64;

// ── Store abstraction ────────────────────────────────────────────────────────

/// What a store currently holds.
#[derive(Debug, Clone, PartialEq)]
pub enum RawDoc {
    /// Nothing stored yet (first run).
    Missing,
    /// The stored file is not a JSON object; the reason is for the log.
    Corrupt(String),
    Doc(Map<String, Value>),
}

/// Where settings live. Implementations do plain I/O only; all validation is in this module.
pub trait SettingsStore: Send + Sync {
    fn read(&self) -> Result<RawDoc>;
    /// Replace the stored document.
    fn write(&self, doc: &Map<String, Value>) -> Result<()>;
    /// Keep a copy of the current stored file (`settings.json.bak`). No-op when there is none.
    fn backup(&self) -> Result<()>;
}

/// Settings file on disk (tests, and any non-Tauri caller). Writes are atomic
/// (temp file in the same folder, then rename).
#[derive(Debug, Clone)]
pub struct FileStore {
    path: PathBuf,
}

impl FileStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Parse stored bytes the way every store does.
pub fn parse_bytes(bytes: &[u8]) -> RawDoc {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(map)) => RawDoc::Doc(map),
        Ok(other) => RawDoc::Corrupt(format!("expected a JSON object, found {}", json_kind(&other))),
        Err(e) => RawDoc::Corrupt(e.to_string()),
    }
}

/// `<file>.bak` next to `path`.
pub fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".bak");
    path.with_file_name(name)
}

/// Copy `path` to its `.bak` sibling if it exists.
pub fn backup_file(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let bak = backup_path(path);
    fs::copy(path, &bak).map(|_| ()).map_err(|e| Error::io(&bak, e))
}

impl SettingsStore for FileStore {
    fn read(&self) -> Result<RawDoc> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(parse_bytes(&bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RawDoc::Missing),
            Err(e) => Err(Error::io(&self.path, e)),
        }
    }

    fn write(&self, doc: &Map<String, Value>) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(doc)
            .map_err(|e| Error::Internal(format!("could not serialise the settings: {e}")))?;
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| Error::io(dir, e))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, bytes).map_err(|e| Error::io(&tmp, e))?;
        fs::rename(&tmp, &self.path).map_err(|e| Error::io(&self.path, e))
    }

    fn backup(&self) -> Result<()> {
        backup_file(&self.path)
    }
}

/// In-memory store (tests and `AppState::default()`).
#[derive(Debug, Default)]
pub struct MemoryStore {
    pub doc: Mutex<Option<Map<String, Value>>>,
    pub backups: Mutex<Vec<Option<Map<String, Value>>>>,
}

impl SettingsStore for MemoryStore {
    fn read(&self) -> Result<RawDoc> {
        let doc = self.doc.lock().map_err(|_| poisoned())?;
        Ok(doc.clone().map_or(RawDoc::Missing, RawDoc::Doc))
    }

    fn write(&self, doc: &Map<String, Value>) -> Result<()> {
        *self.doc.lock().map_err(|_| poisoned())? = Some(doc.clone());
        Ok(())
    }

    fn backup(&self) -> Result<()> {
        let doc = self.doc.lock().map_err(|_| poisoned())?.clone();
        self.backups.lock().map_err(|_| poisoned())?.push(doc);
        Ok(())
    }
}

fn poisoned() -> Error {
    Error::Internal("the settings lock was poisoned".into())
}

fn json_kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

// ── Decode / encode ──────────────────────────────────────────────────────────

/// Keys of `Settings` as stored (camelCase).
const KNOWN_KEYS: &[&str] = &[
    "theme",
    "manualFolders",
    "launcherRoots",
    "watched",
    "overrides",
    "modrinthEnabled",
    "includeBeta",
    "gridSort",
    "inspectorWidth",
];

/// Result of decoding a stored document.
#[derive(Debug, Clone, PartialEq)]
pub struct Decoded {
    pub settings: Settings,
    /// Unknown keys, written back unchanged.
    pub extra: Map<String, Value>,
    /// What was dropped or reset (for the log). Non-empty = the stored file lost information.
    pub problems: Vec<String>,
}

impl Decoded {
    pub fn lossy(&self) -> bool {
        !self.problems.is_empty()
    }
}

/// True for an instance id (16 lowercase hex chars, CONTRACTS invariant 5).
pub fn is_instance_id(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Case-folding key for comparing stored folder paths (case-insensitive on Windows/macOS).
pub fn path_key(p: &str) -> String {
    if crate::discovery::Os::current().case_insensitive() {
        p.to_lowercase()
    } else {
        p.to_string()
    }
}

fn is_absolute_path(s: &str) -> bool {
    !s.is_empty() && Path::new(s).is_absolute()
}

/// Decode a stored document field by field (see the module docs).
pub fn decode(doc: &Map<String, Value>) -> Decoded {
    let mut problems = Vec::new();
    let mut s = Settings::default();

    fn field<T: DeserializeOwned>(doc: &Map<String, Value>, key: &str, problems: &mut Vec<String>) -> Option<T> {
        let v = doc.get(key)?;
        match serde_json::from_value(v.clone()) {
            Ok(t) => Some(t),
            Err(e) => {
                problems.push(format!("{key}: {e}; reset to the default"));
                None
            }
        }
    }

    /// An array field whose entries are validated one by one; bad entries are dropped.
    fn list<T: DeserializeOwned>(
        doc: &Map<String, Value>,
        key: &str,
        problems: &mut Vec<String>,
        keep: impl Fn(&T) -> bool,
    ) -> Vec<T> {
        let Some(v) = doc.get(key) else { return Vec::new() };
        let Value::Array(items) = v else {
            problems.push(format!("{key}: expected an array, found {}; reset to the default", json_kind(v)));
            return Vec::new();
        };
        let mut out = Vec::new();
        for item in items {
            match serde_json::from_value::<T>(item.clone()) {
                Ok(t) if keep(&t) => out.push(t),
                Ok(_) => problems.push(format!("{key}: dropped invalid entry {item}")),
                Err(e) => problems.push(format!("{key}: dropped entry {item}: {e}")),
            }
        }
        out
    }

    if let Some(t) = field(doc, "theme", &mut problems) {
        s.theme = t;
    }

    let folders: Vec<String> = list(doc, "manualFolders", &mut problems, |p: &String| is_absolute_path(p));
    let mut seen = HashSet::new();
    s.manual_folders = folders.into_iter().filter(|p| seen.insert(path_key(p))).collect();

    let roots: Vec<LauncherRoot> = list(doc, "launcherRoots", &mut problems, |r: &LauncherRoot| {
        is_launcher_root_kind(r.launcher) && is_absolute_path(&r.path)
    });
    let mut seen = HashSet::new();
    s.launcher_roots = roots.into_iter().filter(|r| seen.insert((r.launcher, path_key(&r.path)))).collect();

    let watched: Vec<String> = list(doc, "watched", &mut problems, |id: &String| is_instance_id(id));
    let mut seen = HashSet::new();
    s.watched = watched.into_iter().filter(|id| seen.insert(id.clone())).collect();

    match doc.get("overrides") {
        None => {}
        Some(Value::Object(map)) => {
            for (id, v) in map {
                if !is_instance_id(id) {
                    problems.push(format!("overrides: dropped entry for invalid instance id {id:?}"));
                    continue;
                }
                match serde_json::from_value::<PackOverride>(v.clone()).map_err(|e| e.to_string()).and_then(normalise_override) {
                    Ok(o) => {
                        s.overrides.insert(id.clone(), o);
                    }
                    Err(e) => problems.push(format!("overrides: dropped entry {id}: {e}")),
                }
            }
        }
        Some(other) => problems.push(format!("overrides: expected an object, found {}; reset to the default", json_kind(other))),
    }

    if let Some(b) = field(doc, "modrinthEnabled", &mut problems) {
        s.modrinth_enabled = b;
    }
    if let Some(b) = field(doc, "includeBeta", &mut problems) {
        s.include_beta = b;
    }
    if let Some(g) = field(doc, "gridSort", &mut problems) {
        s.grid_sort = g;
    }
    if let Some(w) = field::<u32>(doc, "inspectorWidth", &mut problems) {
        s.inspector_width = clamp_width(w);
    }

    let extra = doc.iter().filter(|(k, _)| !KNOWN_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    Decoded { settings: s, extra, problems }
}

/// The stored document for `settings` (plus unknown keys to preserve).
pub fn encode(settings: &Settings, extra: &Map<String, Value>) -> Result<Map<String, Value>> {
    let mut out = extra.clone();
    match serde_json::to_value(settings) {
        Ok(Value::Object(map)) => out.extend(map),
        Ok(_) => return Err(Error::Internal("settings did not serialise to an object".into())),
        Err(e) => return Err(Error::Internal(format!("could not serialise the settings: {e}"))),
    }
    Ok(out)
}

/// Launchers that can have an extra data root.
pub fn is_launcher_root_kind(l: Launcher) -> bool {
    matches!(l, Launcher::Modrinth | Launcher::Prism | Launcher::Multimc | Launcher::Curseforge | Launcher::Vanilla)
}

fn clamp_width(w: u32) -> u32 {
    w.clamp(INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX)
}

/// Trim version strings (blank → None) and bound their length.
fn normalise_override(mut o: PackOverride) -> std::result::Result<PackOverride, String> {
    fn version(v: Option<String>, what: &str) -> std::result::Result<Option<String>, String> {
        let Some(v) = v else { return Ok(None) };
        let t = v.trim();
        if t.is_empty() {
            return Ok(None);
        }
        if t.len() > MAX_VERSION_LEN || t.chars().any(char::is_control) {
            return Err(format!("the {what} \"{}\" is not a valid version", t.chars().take(MAX_VERSION_LEN).collect::<String>()));
        }
        Ok(Some(t.to_string()))
    }
    o.mc_version = version(o.mc_version, "Minecraft version")?;
    if let Some(l) = o.loader.as_mut() {
        l.version = version(l.version.take(), "loader version")?;
    }
    Ok(o)
}

// ── Patch ────────────────────────────────────────────────────────────────────

/// Apply a `SettingsPatch`. Validates everything first, so on error `settings` is unchanged.
///
/// - `inspector_width` is clamped to 280..=640.
/// - `overrides`: `{id: override}` sets/replaces and is accepted only for an instance id in
///   `known_instance_ids` (the last discovery) that is not in `session_only_ids` (opened
///   `.mrpack`s: they live for the session only, so an override saved for one would outlive it;
///   refused with a readable `Invalid`); `{id: null}` removes (any id).
pub fn apply_patch(
    settings: &mut Settings,
    patch: SettingsPatch,
    known_instance_ids: &HashSet<String>,
    session_only_ids: &HashSet<String>,
) -> Result<()> {
    let mut overrides: BTreeMap<String, Option<PackOverride>> = BTreeMap::new();
    for (id, o) in patch.overrides.unwrap_or_default() {
        let o = match o {
            None => None,
            Some(o) => {
                if session_only_ids.contains(&id) {
                    return Err(Error::Invalid(
                        "Pack identity overrides for an opened .mrpack are not saved; the pack is only open for this session. Its Minecraft version and loader come from its modrinth.index.json".into(),
                    ));
                }
                if !known_instance_ids.contains(&id) {
                    return Err(Error::Invalid(format!(
                        "there is no instance with id \"{id}\"; refresh the instance list and try again"
                    )));
                }
                Some(normalise_override(o).map_err(Error::Invalid)?)
            }
        };
        overrides.insert(id, o);
    }

    if let Some(t) = patch.theme {
        settings.theme = t;
    }
    for (id, o) in overrides {
        match o {
            Some(o) => {
                settings.overrides.insert(id, o);
            }
            None => {
                settings.overrides.remove(&id);
            }
        }
    }
    if let Some(b) = patch.modrinth_enabled {
        settings.modrinth_enabled = b;
    }
    if let Some(b) = patch.include_beta {
        settings.include_beta = b;
    }
    if let Some(g) = patch.grid_sort {
        settings.grid_sort = g;
    }
    if let Some(w) = patch.inspector_width {
        settings.inspector_width = clamp_width(w);
    }
    Ok(())
}

// ── Service ──────────────────────────────────────────────────────────────────

struct Current {
    settings: Settings,
    extra: Map<String, Value>,
}

/// The live settings plus their store. Every change is persisted before it becomes visible;
/// if persisting fails the change is discarded and the error returned.
pub struct SettingsService {
    current: Mutex<Current>,
    store: Box<dyn SettingsStore>,
}

impl std::fmt::Debug for SettingsService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsService").field("settings", &self.get()).finish_non_exhaustive()
    }
}

impl Default for SettingsService {
    fn default() -> Self {
        Self { current: Mutex::new(Current { settings: Settings::default(), extra: Map::new() }), store: Box::new(MemoryStore::default()) }
    }
}

impl SettingsService {
    /// Load from `store`. Never fails: problems fall back to defaults and are returned as log
    /// lines. A lossy decode backs the old file up and writes the normalised settings back.
    pub fn load(store: Box<dyn SettingsStore>) -> (Self, Vec<String>) {
        let mut log = Vec::new();
        let (decoded, rewrite) = match store.read() {
            Ok(RawDoc::Missing) => (decode(&Map::new()), false),
            Ok(RawDoc::Doc(doc)) => {
                let d = decode(&doc);
                let lossy = d.lossy();
                (d, lossy)
            }
            Ok(RawDoc::Corrupt(reason)) => {
                log.push(format!("settings file is not valid JSON ({reason}); using defaults"));
                (decode(&Map::new()), true)
            }
            Err(e) => {
                // Unreadable (permissions…): use defaults but don't overwrite what is there.
                log.push(format!("could not read the settings ({e}); using defaults"));
                (decode(&Map::new()), false)
            }
        };
        log.extend(decoded.problems.iter().map(|p| format!("settings: {p}")));
        if rewrite {
            match store.backup() {
                Ok(()) => match encode(&decoded.settings, &decoded.extra).and_then(|doc| store.write(&doc)) {
                    Ok(()) => log.push("settings: kept the previous file as settings.json.bak".into()),
                    Err(e) => log.push(format!("could not rewrite the settings: {e}")),
                },
                Err(e) => log.push(format!("could not back up the settings, leaving the file untouched: {e}")),
            }
        }
        let current = Current { settings: decoded.settings, extra: decoded.extra };
        (Self { current: Mutex::new(current), store }, log)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Current> {
        // Updates are applied to a clone and committed in one assignment, so a poisoned lock
        // still holds consistent settings.
        self.current.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn get(&self) -> Settings {
        self.lock().settings.clone()
    }

    /// Apply `f` to a copy, persist it, then commit. Returns the new settings and `f`'s value.
    /// Holds the lock across the write, so updates are serialised. Blocking (file I/O).
    pub fn update<T>(&self, f: impl FnOnce(&mut Settings) -> Result<T>) -> Result<(Settings, T)> {
        let mut cur = self.lock();
        let mut next = cur.settings.clone();
        let out = f(&mut next)?;
        if next != cur.settings {
            let doc = encode(&next, &cur.extra)?;
            self.store.write(&doc)?;
            cur.settings = next.clone();
        }
        Ok((next, out))
    }
}
