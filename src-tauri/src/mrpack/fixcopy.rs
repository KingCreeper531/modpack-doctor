//! "Save fixed copy…" of an opened `.mrpack` (proposed addition to CONTRACTS.md invariant 15).
//!
//! The opened pack is never written, renamed or replaced. The UI sends [`PackEdit`] intents only;
//! [`plan`] validates them against the opened pack and Modrinth and stores the result in Rust;
//! [`save`] writes a NEW `.mrpack` at a path the user picked in the native save dialog.
//!
//! Planning (never writes anything):
//! - the instance must be an opened pack; at most [`MAX_EDITS`] edits; two edits may not touch
//!   the same index path, override entry or version;
//! - the pack is read through the PathGuard's read-only rule with the hardened reader
//!   (`archive::check_central_directory`, `archive::list`, capped `read_entry`); a refused pack
//!   or an unusable index refuses the plan. The pack's size, mtime and sha1 are recorded;
//! - `removeDeclared` needs a `files[]` entry with exactly that path (all entries with it go);
//!   `removeOverride` needs a jar directly in an override `mods/` folder that the scan reads;
//! - `replaceDeclared` / `addDependency` fetch the version fresh from api.modrinth.com (the shared
//!   client, its User-Agent), pick the file with the invariant-8 rule (`download_file`), require
//!   a `https://cdn.modrinth.com/` URL, a safe jar file name, sha1 + sha512 and a size, and a
//!   version listing the pack's loader (`modrinth_loaders`: Quilt also `fabric`, NeoForge 1.20.1
//!   also `forge`) and Minecraft version. `replaceDeclared` identifies the declared file by its
//!   sha1 through the API and refuses a version of another project (or the same version);
//! - a new path (`<folder of the old path>/<file>` for a replacement, `mods/<file>` for an
//!   addition) must be safe and must not collide (letter case ignored) with another index entry
//!   or an override file that would replace it on install;
//! - the index is rewritten as a `serde_json::Value`: only `files` changes, so unknown fields
//!   survive. A replacement keeps the old entry's `env`; an addition gets no `env` (installers
//!   install it on both sides). The rewritten index must parse with the scanner's own parser.
//!
//! Plans are stored by id ([`PackFixStore`]): one live plan per pack, single use, expiring
//! [`PLAN_TTL`] after planning (like work orders).
//!
//! Saving: the destination must end in `.mrpack`, must not name the opened pack (or any opened
//! pack; canonical paths compared, letter case ignored on Windows and macOS), and an existing file
//! is replaced only when the native dialog confirmed that exact path. The pack is re-read through
//! the guard and must still have the recorded size, mtime and sha1. Every entry is copied in its
//! original order with `ZipWriter::raw_copy_file` (the compressed bytes unchanged) except the
//! index (written from the plan) and the entries left out (removed override jars and entries the
//! scan skips as unsafe). The copy goes to a new temp file in the destination folder, is fsynced,
//! re-opened and checked, then moved into place with a no-replace rename (or a plain rename when
//! replacing was confirmed). The temp file is removed on any failure, and a failed save keeps the
//! plan for another try.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::archive::{self, Budget};
use super::{display_name, has_mrpack_extension, has_stream_colon, index, open_zip_file, INDEX_NAME, MAX_INDEX_BYTES, MAX_INDEX_FILES, OVERRIDE_DIRS};
use crate::error::{Error, Result};
use crate::fix::plan::{check_jar_file_name, download_file, modrinth_loaders};
use crate::fix::Remote;
use crate::model::{
    Launcher, LoaderInfo, LoaderKind, MrFile, MrVersion, PackEdit, PackFixOp, PackFixOpKind, PackFixPlan, PackIdentity, SavedPack,
};
use crate::state::AppState;

/// How long a plan may wait for `save_fixed_pack`.
pub const PLAN_TTL: Duration = Duration::from_secs(15 * 60);
/// Most edits in one plan.
pub const MAX_EDITS: usize = 200;
/// The only download origin written into a copy.
pub const CDN_PREFIX: &str = "https://cdn.modrinth.com/";
/// Longest default file name offered (characters, extension included).
const MAX_DEFAULT_NAME: usize = 120;

// ── Store ────────────────────────────────────────────────────────────────────

/// The size, mtime and sha1 of the pack file when the plan was made.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PackStamp {
    size: u64,
    mtime_ms: u64,
    sha1: String,
}

#[derive(Debug, Clone)]
struct StoredPlan {
    plan: PackFixPlan,
    /// The registered pack path (checked through the guard again when saving).
    pack: PathBuf,
    stamp: PackStamp,
    /// The rewritten `modrinth.index.json`.
    index: Vec<u8>,
    /// (entry index, name) of the index entry.
    index_entry: (usize, String),
    /// (entry index, name) of every entry left out of the copy.
    left_out: Vec<(usize, String)>,
    expires: Instant,
}

#[derive(Debug, Default)]
struct StoreInner {
    plans: HashMap<String, StoredPlan>,
    /// Tests shorten it; None = [`PLAN_TTL`].
    ttl: Option<Duration>,
}

/// Planned fixed copies, in memory only (managed by Tauri next to `AppState`). Cheap to clone.
#[derive(Debug, Clone, Default)]
pub struct PackFixStore {
    inner: Arc<Mutex<StoreInner>>,
}

fn expired_error() -> Error {
    Error::NotFound { path: "this fixed-copy plan: it expired or was already used — review the edits again".into() }
}

/// `^[0-9a-f]{32}$`.
fn is_plan_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl PackFixStore {
    fn lock(&self) -> std::sync::MutexGuard<'_, StoreInner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    #[cfg(test)]
    fn set_ttl(&self, ttl: Duration) {
        self.lock().ttl = Some(ttl);
    }

    fn ttl(&self) -> Duration {
        self.lock().ttl.unwrap_or(PLAN_TTL)
    }

    /// Store `p`, dropping expired plans and any older plan of the same pack.
    fn store(&self, p: StoredPlan) {
        let mut inner = self.lock();
        let now = Instant::now();
        inner.plans.retain(|_, o| o.expires > now && o.plan.instance_id != p.plan.instance_id);
        inner.plans.insert(p.plan.id.clone(), p);
    }

    /// The live plan with `id` (not consumed).
    pub fn peek(&self, id: &str) -> Result<PackFixPlan> {
        if !is_plan_id(id) {
            return Err(expired_error());
        }
        let mut inner = self.lock();
        match inner.plans.get(id) {
            Some(p) if p.expires > Instant::now() => Ok(p.plan.clone()),
            Some(_) => {
                inner.plans.remove(id);
                Err(expired_error())
            }
            None => Err(expired_error()),
        }
    }

    /// Remove and return a live plan (single use).
    fn take(&self, id: &str) -> Result<StoredPlan> {
        let p = self.lock().plans.remove(id).ok_or_else(expired_error)?;
        if p.expires <= Instant::now() {
            return Err(expired_error());
        }
        Ok(p)
    }

    /// Put a plan back after a failed save (unless a newer plan of the pack replaced it).
    fn put_back(&self, p: StoredPlan) {
        let mut inner = self.lock();
        if p.expires > Instant::now() && !inner.plans.values().any(|o| o.plan.instance_id == p.plan.instance_id) {
            inner.plans.insert(p.plan.id.clone(), p);
        }
    }

    #[cfg(test)]
    fn contains(&self, id: &str) -> bool {
        self.lock().plans.contains_key(id)
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn refuse(label: &str, msg: impl std::fmt::Display) -> Error {
    Error::Invalid(format!("{label}: {msg}"))
}

/// Keep network wording; everything else becomes a refusal naming the edit.
fn remote_error(label: &str, e: Error) -> Error {
    match e {
        Error::Offline | Error::RateLimited { .. } => e,
        Error::Network(m) => Error::Network(format!("{m} (while checking \"{label}\")")),
        Error::NotFound { path } => refuse(label, format!("Modrinth does not know {path}")),
        Error::Invalid(m) => refuse(label, m),
        other => other,
    }
}

/// Letter case folded (one file on Windows and macOS; the copy may be installed anywhere).
fn fold(s: &str) -> String {
    s.to_lowercase()
}

fn describe_loader(l: &LoaderInfo) -> &'static str {
    match l.kind {
        LoaderKind::Forge => "Forge",
        LoaderKind::Neoforge => "NeoForge",
        LoaderKind::Fabric => "Fabric",
        LoaderKind::Quilt => "Quilt",
        LoaderKind::Legacyforge => "legacy Forge",
        LoaderKind::Unknown => "an unknown loader",
    }
}

/// `312 KB`, `1.4 MB`.
fn format_size(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    } else {
        format!("{} KB", n.div_ceil(1024).max(1))
    }
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The folder part of an index path (`mods/x.jar` → `mods/`; `x.jar` → ``).
fn folder_of(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..=i])
}

fn entry_path(v: &Value) -> Option<&str> {
    v.as_object()?.get("path")?.as_str()
}

/// `env` in words, for the plan.
fn env_words(env: Option<&Value>) -> String {
    let side = |k: &str| env.and_then(|e| e.get(k)).and_then(Value::as_str).map(display_name);
    match (side("client"), side("server")) {
        (None, None) => "keeps having no env, so launchers install it on both client and server".into(),
        (c, s) => format!(
            "keeps the entry's env (client {}, server {})",
            c.unwrap_or_else(|| "unset".into()),
            s.unwrap_or_else(|| "unset".into())
        ),
    }
}

/// Size, mtime and sha1 of an open file, read through the same handle; rewound afterwards.
fn stamp_of(file: &mut File) -> std::io::Result<PackStamp> {
    let meta = file.metadata()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
    file.seek(SeekFrom::Start(0))?;
    let mut h = Sha1::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(PackStamp { size: meta.len(), mtime_ms, sha1: hex::encode(h.finalize()) })
}

/// The registered, opened pack: (canonical path, file name).
fn opened_pack(st: &AppState, instance_id: &str) -> Result<(PathBuf, PathBuf, String)> {
    if !crate::fix::is_instance_id(instance_id) {
        return Err(Error::Invalid(format!("\"{}\" is not an instance id", display_name(instance_id))));
    }
    let reg = st.instance(instance_id)?;
    if reg.instance.launcher != Launcher::Mrpack {
        return Err(Error::Invalid(format!(
            "\"{}\" is not an opened .mrpack file; only packs are saved as fixed copies",
            reg.instance.name
        )));
    }
    let canon = st.guard.check_existing(&reg.game_dir)?;
    let name = canon.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok((reg.game_dir.clone(), canon, name))
}

/// What the plan needs from the pack's zip.
struct Opened {
    zip: ZipArchive<std::io::BufReader<File>>,
    stamp: PackStamp,
    listing: archive::Listing,
}

/// Open `canon` once: stamp it, then the hardened reader on the same handle.
fn open_pack_file(canon: &Path) -> Result<Opened> {
    let mut file = File::open(canon).map_err(|e| Error::io(canon, e))?;
    let stamp = stamp_of(&mut file).map_err(|e| Error::io(canon, e))?;
    let mut zip = open_zip_file(file).map_err(|why| Error::Corrupt { path: canon.display().to_string(), reason: why.trim_end_matches('.').to_string() })?;
    let listing = archive::list(&mut zip);
    if listing.refused {
        let why = listing.issues.first().map_or_else(|| "it could not be read safely".to_string(), |i| i.message.trim_end_matches('.').to_string());
        return Err(Error::Invalid(format!("the pack cannot be copied: {why}")));
    }
    Ok(Opened { zip, stamp, listing })
}

// ── Planning ─────────────────────────────────────────────────────────────────

/// A validated Modrinth file to write into the index.
struct NewFile {
    version: MrVersion,
    file: MrFile,
    size: u64,
    title: String,
}

struct Planner<'a> {
    remote: Option<&'a dyn Remote>,
    pack: Option<PackIdentity>,
    /// `files[]` of the index; None = left out.
    files: Vec<Option<Value>>,
    added: Vec<Value>,
    /// Folded paths written by a replacement or an addition → the label that wrote them.
    new_paths: Vec<(String, String)>,
    /// Subject key → label of the edit that touches it.
    touched: HashMap<String, String>,
    ops: Vec<PackFixOp>,
    /// Override jars of the pack (zip entry name → entry index).
    override_jars: HashMap<String, usize>,
    left_out: Vec<(usize, String)>,
}

impl Planner<'_> {
    fn touch(&mut self, key: String, label: &str, subject: &str) -> Result<()> {
        if let Some(other) = self.touched.get(&key) {
            return Err(refuse(label, format!("\"{other}\" already changes {}; keep only one of them", display_name(subject))));
        }
        self.touched.insert(key, label.to_string());
        Ok(())
    }

    /// Indexes of live `files[]` entries with exactly `path`.
    fn entries_at(&self, path: &str) -> Vec<usize> {
        self.files.iter().enumerate().filter(|(_, f)| f.as_ref().and_then(entry_path) == Some(path)).map(|(i, _)| i).collect()
    }

    fn pack_identity(&self, label: &str) -> Result<&PackIdentity> {
        self.pack.as_ref().ok_or_else(|| {
            refuse(
                label,
                "the pack's index does not name both its Minecraft version and its mod loader, so a Modrinth version cannot be checked against it",
            )
        })
    }

    /// Fetch and validate a version and its download file.
    fn new_file(&self, label: &str, version_id: &str) -> Result<NewFile> {
        if !crate::modrinth::validate::is_base62_id(version_id) {
            return Err(refuse(label, format!("\"{}\" is not a Modrinth version id", display_name(version_id))));
        }
        let pack = self.pack_identity(label)?;
        let remote = self.remote.ok_or(Error::Offline)?;
        let v = remote.version(version_id).map_err(|e| remote_error(label, e))?;
        let wanted = modrinth_loaders(pack);
        if wanted.is_empty() {
            return Err(refuse(label, "the pack's mod loader is unknown, so a Modrinth version cannot be checked against it"));
        }
        if !v.loaders.iter().any(|l| wanted.iter().any(|w| l.eq_ignore_ascii_case(w))) {
            let listed = if v.loaders.is_empty() { "no listed loader".to_string() } else { v.loaders.join(", ") };
            return Err(refuse(
                label,
                format!("version {} is for {listed}, not for this pack's loader ({})", display_name(&v.version_number), describe_loader(&pack.loader)),
            ));
        }
        if !v.game_versions.iter().any(|g| g == &pack.mc_version) {
            return Err(refuse(
                label,
                format!("version {} does not list Minecraft {}, the pack's version", display_name(&v.version_number), pack.mc_version),
            ));
        }
        let file = download_file(&v).map_err(|m| refuse(label, m))?.clone();
        check_jar_file_name(&file.filename).map_err(|m| refuse(label, m))?;
        let url_ok = file.url.starts_with(CDN_PREFIX)
            && file.url.len() <= index::MAX_URL_BYTES
            && !file.url.chars().any(|c| c.is_whitespace() || c.is_control());
        if !url_ok {
            return Err(refuse(label, format!("the download of {} is not a https://cdn.modrinth.com/ link", display_name(&file.filename))));
        }
        if !is_hex(&file.sha1, 40) || !is_hex(&file.sha512, 128) {
            return Err(refuse(label, format!("Modrinth did not report both the sha1 and the sha512 of {}", display_name(&file.filename))));
        }
        let Some(size) = file.size else {
            return Err(refuse(label, format!("Modrinth did not report the size of {}", display_name(&file.filename))));
        };
        let title = remote.project_title(&v.project_id).map(|t| display_name(&t)).unwrap_or_else(|| display_name(&v.name));
        Ok(NewFile { version: v, file, size, title })
    }

    fn entry_for(path: &str, f: &NewFile, env: Option<Value>) -> Value {
        let mut m = Map::new();
        m.insert("path".into(), Value::String(path.to_string()));
        m.insert("hashes".into(), json!({ "sha1": f.file.sha1.to_ascii_lowercase(), "sha512": f.file.sha512.to_ascii_lowercase() }));
        if let Some(env) = env {
            m.insert("env".into(), env);
        }
        m.insert("downloads".into(), json!([f.file.url]));
        m.insert("fileSize".into(), json!(f.size));
        Value::Object(m)
    }

    fn source_words(f: &NewFile) -> String {
        format!("{} {} ({}) from cdn.modrinth.com", f.title, display_name(&f.version.version_number), format_size(f.size))
    }

    fn edit(&mut self, edit: &PackEdit) -> Result<()> {
        match edit {
            PackEdit::RemoveDeclared { path } => {
                let label = format!("Remove {}", display_name(path));
                self.touch(format!("declared:{path}"), &label, path)?;
                let at = self.entries_at(path);
                if at.is_empty() {
                    return Err(refuse(&label, "the pack's index lists no file at that path"));
                }
                for i in &at {
                    self.files[*i] = None;
                }
                let detail = if at.len() > 1 {
                    format!("All {} entries with this path are left out of the copy's index, so launchers no longer download it.", at.len())
                } else {
                    "Left out of the copy's index, so launchers no longer download it.".to_string()
                };
                self.ops.push(PackFixOp { kind: PackFixOpKind::Remove, subject: path.clone(), detail, url: None });
                Ok(())
            }
            PackEdit::RemoveOverride { entry } => {
                let label = format!("Remove {}", display_name(entry));
                self.touch(format!("override:{entry}"), &label, entry)?;
                let Some(idx) = self.override_jars.get(entry).copied() else {
                    return Err(refuse(
                        &label,
                        "that is not a jar directly in the mods folder of the pack's overrides, client-overrides or server-overrides",
                    ));
                };
                self.left_out.push((idx, entry.clone()));
                self.ops.push(PackFixOp {
                    kind: PackFixOpKind::RemoveOverride,
                    subject: entry.clone(),
                    detail: "Left out of the copy: the jar is not copied, so installing the copy does not add it.".into(),
                    url: None,
                });
                Ok(())
            }
            PackEdit::ReplaceDeclared { path, version_id } => {
                let label = format!("Replace {}", display_name(path));
                self.touch(format!("declared:{path}"), &label, path)?;
                let at = self.entries_at(path);
                let Some(&last) = at.last() else {
                    return Err(refuse(&label, "the pack's index lists no file at that path"));
                };
                let old = self.files[last].clone().unwrap_or(Value::Null);
                let sha1 = old
                    .get("hashes")
                    .and_then(|h| h.get("sha1"))
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| is_hex(s, 40))
                    .ok_or_else(|| refuse(&label, "the index entry has no valid sha1, so Modrinth cannot identify it"))?;
                let f = self.new_file(&label, version_id)?;
                let remote = self.remote.ok_or(Error::Offline)?;
                let current = remote
                    .identify(&sha1)
                    .map_err(|e| remote_error(&label, e))?
                    .ok_or_else(|| refuse(&label, "Modrinth does not know this file by its hash, so it cannot be replaced with a version of the same project"))?;
                if current.project_id != f.version.project_id {
                    return Err(refuse(
                        &label,
                        format!("version {} belongs to a different Modrinth project than the file in the pack", display_name(&f.version.version_number)),
                    ));
                }
                if current.id == f.version.id {
                    return Err(refuse(&label, format!("the pack already has version {}", display_name(&f.version.version_number))));
                }
                let new_path = format!("{}{}", folder_of(path), f.file.filename);
                if let Some(why) = archive::path_problem(&new_path) {
                    return Err(refuse(&label, format!("the new path \"{}\" is unsafe: {why}", display_name(&new_path))));
                }
                let env = old.get("env").cloned();
                let words = env_words(env.as_ref());
                let entry = Self::entry_for(&new_path, &f, env);
                for i in &at {
                    self.files[*i] = None;
                }
                self.files[last] = Some(entry);
                self.new_paths.push((fold(&new_path), label.clone()));
                self.ops.push(PackFixOp {
                    kind: PackFixOpKind::Replace,
                    subject: path.clone(),
                    detail: format!("Becomes {new_path}: {}; {words}.", Self::source_words(&f)),
                    url: Some(f.file.url.clone()),
                });
                Ok(())
            }
            PackEdit::AddDependency { version_id } => {
                let label = format!("Add version {}", display_name(version_id));
                self.touch(format!("add:{version_id}"), &label, version_id)?;
                let f = self.new_file(&label, version_id)?;
                let label = format!("Add {} {}", f.title, display_name(&f.version.version_number));
                let new_path = format!("mods/{}", f.file.filename);
                let sha1 = f.file.sha1.to_ascii_lowercase();
                let same = self.files.iter().flatten().chain(self.added.iter()).find(|e| {
                    e.get("hashes").and_then(|h| h.get("sha1")).and_then(Value::as_str).is_some_and(|s| s.trim().eq_ignore_ascii_case(&sha1))
                });
                if let Some(same) = same {
                    return Err(refuse(
                        &label,
                        format!("the pack already lists this exact file as {}", display_name(entry_path(same).unwrap_or("another entry"))),
                    ));
                }
                let entry = Self::entry_for(&new_path, &f, None);
                self.added.push(entry);
                self.new_paths.push((fold(&new_path), label.clone()));
                self.ops.push(PackFixOp {
                    kind: PackFixOpKind::Add,
                    subject: new_path,
                    detail: format!(
                        "New index entry: {}. It has no env, so launchers install it on both client and server.",
                        Self::source_words(&f)
                    ),
                    url: Some(f.file.url.clone()),
                });
                Ok(())
            }
        }
    }
}

/// Plan a fixed copy of the opened pack `instance_id` and store it. `remote` is None when
/// Modrinth is switched off (`replaceDeclared` / `addDependency` then fail with `Offline`).
/// Never writes anything.
pub fn plan(st: &AppState, store: &PackFixStore, remote: Option<&dyn Remote>, instance_id: &str, edits: &[PackEdit]) -> Result<PackFixPlan> {
    let (registered, canon, pack_file_name) = opened_pack(st, instance_id)?;
    if edits.is_empty() {
        return Err(Error::Invalid("there are no edits to apply to the copy".into()));
    }
    if edits.len() > MAX_EDITS {
        return Err(Error::Invalid(format!("at most {MAX_EDITS} edits fit in one fixed copy")));
    }
    let Opened { mut zip, stamp, listing } = open_pack_file(&canon)?;
    let Some(index_idx) = listing.index else {
        return Err(Error::Invalid(format!("the pack has no {INDEX_NAME}, so a fixed copy cannot be made")));
    };
    let bytes = archive::read_entry(&mut zip, index_idx, MAX_INDEX_BYTES, &mut Budget::new())
        .map_err(|why| Error::Invalid(format!("the pack's {INDEX_NAME} could not be read: {why}")))?;
    let mut issues = Vec::new();
    let Some(parsed) = index::parse(&bytes, &mut issues) else {
        let why = issues.first().map_or_else(|| format!("its {INDEX_NAME} is unusable"), |i| i.message.trim_end_matches('.').to_string());
        return Err(Error::Invalid(format!("the pack cannot be fixed: {why}")));
    };
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let mut root: Value = serde_json::from_slice(body).map_err(|e| Error::Invalid(format!("the pack's {INDEX_NAME} is not valid JSON ({e})")))?;
    let files: Vec<Option<Value>> = match root.get("files") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().cloned().map(Some).collect(),
        Some(_) => return Err(Error::Invalid(format!("the pack's {INDEX_NAME} has a files value that is not a list"))),
    };
    if files.len() > MAX_INDEX_FILES {
        return Err(Error::Invalid(format!("the pack's {INDEX_NAME} lists more than {MAX_INDEX_FILES} files, more than Modpack Doctor edits")));
    }
    let pack = match (parsed.mc_version.clone(), parsed.loader.clone()) {
        (Some(mc_version), Some(loader)) => Some(PackIdentity { mc_version, loader }),
        _ => None,
    };

    // Entries a scan skips as unsafe are left out of the copy too.
    let mut unsafe_entries: Vec<(usize, String, &'static str)> = Vec::new();
    let mut kept_names: HashSet<String> = HashSet::new();
    for i in 0..zip.len() {
        match archive::inspect_entry(&mut zip, i) {
            Some(e) if e.problem.is_some() => unsafe_entries.push((i, e.name, e.problem.unwrap_or_default())),
            Some(e) => {
                kept_names.insert(fold(&e.name));
            }
            None => return Err(Error::Invalid(format!("entry {i} of the pack cannot be read, so the pack cannot be copied"))),
        }
    }

    let mut p = Planner {
        remote,
        pack,
        files,
        added: Vec::new(),
        new_paths: Vec::new(),
        touched: HashMap::new(),
        ops: Vec::new(),
        override_jars: listing.jars.iter().map(|(i, n)| (n.clone(), *i)).collect(),
        left_out: Vec::new(),
    };
    for e in edits {
        p.edit(e)?;
    }

    // Collisions: a new path must be the only entry with that path, and no override file the
    // copy keeps may land on it (overrides are copied over the downloads on install).
    for (_, name) in &p.left_out {
        kept_names.remove(&fold(name));
    }
    let final_files: Vec<Value> = p.files.into_iter().flatten().chain(p.added).collect();
    for (new_path, label) in &p.new_paths {
        let n = final_files.iter().filter(|f| entry_path(f).is_some_and(|q| fold(q) == *new_path)).count();
        if n > 1 {
            return Err(refuse(label, format!("the copy would list {new_path} more than once (letter case ignored); remove the other entry first")));
        }
        if let Some(dir) = OVERRIDE_DIRS.iter().find(|d| kept_names.contains(&format!("{d}{new_path}"))) {
            return Err(refuse(
                label,
                format!("the pack's {dir} folder also has {new_path}, which would replace the downloaded file on install; remove that override jar too"),
            ));
        }
    }

    if let Some(obj) = root.as_object_mut() {
        obj.insert("files".into(), Value::Array(final_files));
    }
    let new_index = serde_json::to_vec_pretty(&root).map_err(|e| Error::Internal(format!("the new {INDEX_NAME} could not be written: {e}")))?;
    if new_index.len() as u64 > MAX_INDEX_BYTES {
        return Err(Error::Invalid(format!("the new {INDEX_NAME} would be larger than {} MiB", MAX_INDEX_BYTES / super::MIB)));
    }
    // The copy's index must read back with the scanner's own parser.
    if index::parse(&new_index, &mut Vec::new()).is_none() {
        return Err(Error::Internal(format!("the new {INDEX_NAME} did not read back")));
    }

    let mut warnings = Vec::new();
    if !unsafe_entries.is_empty() {
        let shown: Vec<String> = unsafe_entries.iter().take(5).map(|(_, n, why)| format!("{} ({why})", display_name(n))).collect();
        let more = unsafe_entries.len().saturating_sub(shown.len());
        warnings.push(format!(
            "{} unsafe {} the scan skipped {} left out of the copy: {}{}.",
            unsafe_entries.len(),
            if unsafe_entries.len() == 1 { "entry" } else { "entries" },
            if unsafe_entries.len() == 1 { "is" } else { "are" },
            shown.join(", "),
            if more > 0 { format!(", and {more} more") } else { String::new() }
        ));
    }
    let mut left_out = p.left_out;
    left_out.extend(unsafe_entries.into_iter().map(|(i, n, _)| (i, n)));
    let index_name = archive::inspect_entry(&mut zip, index_idx).map(|e| e.name).unwrap_or_else(|| INDEX_NAME.to_string());

    let plan = PackFixPlan {
        id: crate::fix::fsops::random_hex(2),
        instance_id: instance_id.to_string(),
        pack_file_name,
        ops: p.ops,
        warnings,
    };
    store.store(StoredPlan {
        plan: plan.clone(),
        pack: registered,
        stamp,
        index: new_index,
        index_entry: (index_idx, index_name),
        left_out,
        expires: Instant::now() + store.ttl(),
    });
    Ok(plan)
}

// ── Saving ───────────────────────────────────────────────────────────────────

/// The default name offered in the save dialog: `<pack file stem> (fixed).mrpack`.
pub fn default_copy_name(pack_file_name: &str) -> String {
    let stem = pack_file_name
        .get(..pack_file_name.len().saturating_sub(".mrpack".len()))
        .filter(|_| has_mrpack_extension(pack_file_name))
        .unwrap_or(pack_file_name);
    let suffix = " (fixed).mrpack";
    let cleaned: String = stem
        .chars()
        .filter(|c| !super::is_hidden_char(*c))
        .map(|c| if matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*') { '-' } else { c })
        .take(MAX_DEFAULT_NAME - suffix.chars().count())
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let stem = if cleaned.is_empty() { "modpack" } else { cleaned };
    format!("{stem}{suffix}")
}

/// `path` with the `.mrpack` extension: kept when present (any case), else appended. Invalid
/// when a name of the path contains `:` (an NTFS alternate data stream).
pub fn enforce_mrpack_extension(path: PathBuf) -> Result<PathBuf> {
    if has_stream_colon(&path) {
        return Err(Error::Invalid(
            "the chosen name contains \":\", which is not allowed in a pack file name; save again and choose another name".into(),
        ));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if has_mrpack_extension(&name) {
        return Ok(path);
    }
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".mrpack");
    Ok(path.with_file_name(name))
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// `dest` resolved: the canonical path when it exists, else its canonical folder plus its name.
fn resolved(dest: &Path) -> Result<PathBuf> {
    if let Ok(p) = dunce::canonicalize(dest) {
        return Ok(p);
    }
    let (Some(dir), Some(name)) = (dest.parent(), dest.file_name()) else {
        return Err(Error::Invalid(format!("{} is not a file path", dest.display())));
    };
    let dir = dunce::canonicalize(dir).map_err(|e| Error::io(dir, e))?;
    Ok(dir.join(name))
}

#[cfg(test)]
pub(crate) mod hook {
    //! Tests: run something right before the finished temp file is moved into place.
    use std::cell::RefCell;
    use std::path::Path;

    type Hook = Box<dyn FnMut(&Path, &Path) -> std::io::Result<()>>;

    thread_local! {
        static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    pub fn set(f: impl FnMut(&Path, &Path) -> std::io::Result<()> + 'static) {
        HOOK.with(|h| *h.borrow_mut() = Some(Box::new(f)));
    }

    pub fn clear() {
        HOOK.with(|h| *h.borrow_mut() = None);
    }

    pub(super) fn before_move(temp: &Path, dest: &Path) -> std::io::Result<()> {
        HOOK.with(|h| h.borrow_mut().as_mut().map_or(Ok(()), |f| f(temp, dest)))
    }
}

/// Save the stored plan `plan_id` as a new pack at `dest` (picked in the native save dialog).
/// An existing `dest` is replaced only when `may_replace` (the dialog confirmed that path).
/// Single use on success; a failed save keeps the plan for another try.
pub fn save(st: &AppState, store: &PackFixStore, plan_id: &str, dest: &Path, may_replace: bool) -> Result<SavedPack> {
    if !is_plan_id(plan_id) {
        return Err(expired_error());
    }
    let stored = store.take(plan_id)?;
    match write_copy(st, &stored, dest, may_replace) {
        Ok(saved) => Ok(saved),
        Err(e) => {
            store.put_back(stored);
            Err(e)
        }
    }
}

fn write_copy(st: &AppState, stored: &StoredPlan, dest: &Path, may_replace: bool) -> Result<SavedPack> {
    let shown = dest.display().to_string();
    let file_name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = match dest.parent() {
        Some(d) if !d.as_os_str().is_empty() && !file_name.is_empty() => d,
        _ => return Err(Error::Invalid(format!("{shown} is not a file path"))),
    };
    if has_stream_colon(dest) || dest.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(Error::Invalid(format!("{shown} is not a usable file name for the copy")));
    }
    if !has_mrpack_extension(&file_name) {
        return Err(Error::Invalid(format!("{shown} does not end in .mrpack")));
    }
    // Never the opened pack itself (nor any other opened pack): those files are never changed.
    let target = resolved(dest)?;
    let opened: Vec<PathBuf> = st.opened_packs().iter().map(|i| PathBuf::from(&i.root)).chain(std::iter::once(stored.pack.clone())).collect();
    if opened.iter().any(|p| same_path(p, &target) || dunce::canonicalize(p).is_ok_and(|c| same_path(&c, &target))) {
        return Err(Error::Invalid(format!(
            "{shown} is an opened pack, which Modpack Doctor never changes; save the fixed copy under another name"
        )));
    }
    match fs::symlink_metadata(dest) {
        Ok(m) if m.is_dir() => return Err(Error::Invalid(format!("{shown} is a folder; choose a file name"))),
        Ok(_) if !may_replace => return Err(exists(&shown)),
        _ => {}
    }

    // The pack must be exactly what was planned.
    let canon = st.guard.check_existing(&stored.pack)?;
    let Opened { mut zip, stamp, .. } = open_pack_file(&canon)?;
    if stamp != stored.stamp {
        return Err(Error::Conflict(
            "The pack file changed since the fixed copy was planned. Review the edits again, then save.".into(),
        ));
    }
    let left_out: HashSet<usize> = stored.left_out.iter().map(|(i, _)| *i).collect();
    for (i, name) in stored.left_out.iter().chain(std::iter::once(&stored.index_entry)) {
        if archive::inspect_entry(&mut zip, *i).map(|e| e.name).as_deref() != Some(name.as_str()) {
            return Err(Error::Conflict("The pack's contents differ from the plan. Review the edits again, then save.".into()));
        }
    }

    let (temp_path, temp) = create_temp(dir)?;
    let result = (|| -> Result<()> {
        write_entries(&mut zip, stored, &left_out, temp).map_err(|e| Error::Internal(format!("the fixed copy could not be written: {e}")))?;
        verify_copy(&temp_path, stored)?;
        hook_before_move(&temp_path, dest)?;
        move_into_place(&temp_path, dest, may_replace)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&temp_path);
        return Err(e);
    }
    Ok(SavedPack { path: dest.display().to_string(), file_name })
}

#[cfg(test)]
fn hook_before_move(temp: &Path, dest: &Path) -> Result<()> {
    hook::before_move(temp, dest).map_err(|e| Error::io(dest, e))
}

#[cfg(not(test))]
fn hook_before_move(_temp: &Path, _dest: &Path) -> Result<()> {
    Ok(())
}

fn exists(shown: &str) -> Error {
    Error::Conflict(format!("{shown} already exists. Save the fixed copy again and choose another name."))
}

/// A new, empty temp file in `dir` (`create_new`).
fn create_temp(dir: &Path) -> Result<(PathBuf, File)> {
    for _ in 0..16 {
        let candidate = dir.join(format!(".modpack-doctor-pack-{}.tmp", crate::fix::fsops::random_hex(1)));
        match OpenOptions::new().write(true).read(true).create_new(true).open(&candidate) {
            Ok(f) => return Ok((candidate, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(Error::io(dir, e)),
        }
    }
    Err(Error::Internal(format!("no free temporary file name in {}", dir.display())))
}

/// Every entry in order: raw copies, the index from the plan, the left-out ones skipped. Fsynced.
fn write_entries<R: Read + Seek>(zip: &mut ZipArchive<R>, stored: &StoredPlan, left_out: &HashSet<usize>, temp: File) -> zip::result::ZipResult<()> {
    let mut out = ZipWriter::new(BufWriter::new(temp));
    for i in 0..zip.len() {
        if i == stored.index_entry.0 {
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            out.start_file(INDEX_NAME, opts)?;
            out.write_all(&stored.index)?;
            continue;
        }
        if left_out.contains(&i) {
            continue;
        }
        out.raw_copy_file(zip.by_index_raw(i)?)?;
    }
    let writer = out.finish()?;
    let file = writer.into_inner().map_err(|e| std::io::Error::other(e.to_string()))?;
    file.sync_all()?;
    Ok(())
}

/// Re-open the written copy with the hardened reader: nothing refused, and its index is the one
/// planned.
fn verify_copy(temp: &Path, stored: &StoredPlan) -> Result<()> {
    let bad = |why: String| Error::Internal(format!("the fixed copy did not read back correctly ({why})"));
    let file = File::open(temp).map_err(|e| Error::io(temp, e))?;
    let mut zip = open_zip_file(file).map_err(bad)?;
    let listing = archive::list(&mut zip);
    if listing.refused {
        return Err(bad(listing.issues.first().map_or_else(String::new, |i| i.message.clone())));
    }
    let idx = listing.index.ok_or_else(|| bad(format!("it has no {INDEX_NAME}")))?;
    let bytes = archive::read_entry(&mut zip, idx, MAX_INDEX_BYTES, &mut Budget::new()).map_err(bad)?;
    if bytes != stored.index {
        return Err(bad(format!("its {INDEX_NAME} differs from the plan")));
    }
    Ok(())
}

/// A plain rename (replacing) only when `may_replace`, else an atomic no-replace rename.
fn move_into_place(temp: &Path, dest: &Path, may_replace: bool) -> Result<()> {
    let moved = if may_replace { fs::rename(temp, dest) } else { crate::fix::fsops::rename_noreplace(temp, dest) };
    match moved {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(exists(&dest.display().to_string())),
        Err(e) => Err(Error::io(dest, e)),
    }
}

#[cfg(test)]
mod tests;
