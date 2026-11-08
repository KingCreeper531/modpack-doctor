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
//! - `files[]` entries the scanner's index parser skips (not an object, no path, an unsafe or
//!   folder path, no valid sha1 / sha512) or that a later entry with the same path shadows are
//!   left out of the copy, with a plan warning naming them;
//! - with Modrinth on, every remaining declared file is identified by sha1 in one batched lookup
//!   (fresh, `version_files`); files that are not on Modrinth (or could not be looked up) are
//!   copied unchanged with a warning. Kept entries whose download links are outside Modrinth's
//!   allowlist (`cdn.modrinth.com`, `github.com`, `raw.githubusercontent.com`, `gitlab.com`) are
//!   copied unchanged with a warning; so are paths that differ only in letter case;
//! - `removeDeclared` needs a `files[]` entry with exactly that path; `removeOverride` needs a jar
//!   directly in an override `mods/` folder that the scan reads;
//! - `replaceDeclared` / `addDependency` fetch the version fresh from api.modrinth.com (the shared
//!   client, its User-Agent), pick the file with the invariant-8 rule (`download_file`), require
//!   a `https://cdn.modrinth.com/` URL, a safe jar file name, sha1 + sha512 and a size, and a
//!   version listing the pack's loader (`modrinth_loaders`: Quilt also `fabric`, NeoForge 1.20.1
//!   also `forge`) and Minecraft version. `replaceDeclared` needs the declared file identified on
//!   Modrinth and refuses a version of another project, the same version, or one not published
//!   after it (no downgrades);
//! - `addDependency` (bound intent, like invariant 14's `InstallDependency`) is checked after the
//!   other edits: the project must be required by a file the copy keeps — a `required` Modrinth
//!   dependency of an identified declared file (or of a replacement), or a required mod id of a
//!   kept override jar that equals the project's slug (`-` ≡ `_`) or that `resolve_mod_id`
//!   resolves to it — and must not be in the copy already: an identified declared file of that
//!   project, another addition of it, or a kept override jar whose mod id (or `provides`) is the
//!   project's slug or resolves to it. Files that could not be identified or resolved make a
//!   warning (the copy may then have the mod twice), never a silent pass. The new entry's `env`
//!   comes from the project's `client_side` / `server_side` (required / optional / unsupported);
//!   when Modrinth does not know them, from the file that requires it (an override jar in
//!   `client-overrides/` → client only, `server-overrides/` → server only), else no `env`;
//! - a new path (`<folder of the old path>/<file>` for a replacement, `mods/<file>` for an
//!   addition) must be safe and must not collide (letter case ignored) with another index entry
//!   or an override file that would replace it on install; the copy's index may list at most
//!   [`MAX_INDEX_FILES`] files;
//! - the index is rewritten as a `serde_json::Value`: only `files` changes, so unknown fields
//!   survive (object keys come out sorted: serde_json's `preserve_order` is off crate-wide). A
//!   replacement keeps the old entry's `env`. The rewritten index must parse with the scanner's
//!   own parser.
//!
//! Plans are stored by id ([`PackFixStore`]): one live plan per pack, single use, expiring
//! [`PLAN_TTL`] after planning (like work orders).
//!
//! Saving: the destination must end in `.mrpack` and must not be the opened pack (or any opened
//! pack): canonical paths are compared (letter case ignored on Windows and macOS) and, when the
//! destination exists, file identity too (volume serial + file index on Windows, device + inode
//! elsewhere), so a hard link, a junction or symlinked folder, or a network-share alias of a pack
//! is refused. An existing file is replaced only when the native dialog confirmed that exact path,
//! and the identity check is repeated right before that replacing rename. Leftover
//! `.modpack-doctor-pack-<16 hex>.tmp` files older than an hour in the destination folder are
//! removed first (only names of exactly that form). The pack is re-read through the guard and
//! must still have the recorded size, mtime and sha1. Every entry is copied in its original order
//! with `ZipWriter::raw_copy_file` (the compressed bytes unchanged) except the index (written
//! from the plan) and the entries left out (removed override jars and entries the scan skips as
//! unsafe). The copy goes to a new temp file in the destination folder and is fsynced; the pack
//! is stamped again (it must not have changed while it was copied); the copy is re-opened and
//! checked, then moved into place with a no-replace rename (or a plain rename when replacing was
//! confirmed), and on Unix the folder is fsynced. The temp file is removed on any failure. A
//! failed save keeps the plan for another try, except when the pack changed since planning (the
//! plan is dropped: it describes a file that no longer exists).

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use super::archive::{self, Budget};
use super::{
    display_name, has_mrpack_extension, has_stream_colon, index, open_zip_file, INDEX_NAME, MAX_INDEX_BYTES, MAX_INDEX_FILES,
    MAX_OVERRIDE_JAR_BYTES, OVERRIDE_DIRS,
};
use crate::error::{Error, Result};
use crate::fix::plan::{check_jar_file_name, download_file, is_builtin_dependency, is_newer, modrinth_loaders};
use crate::fix::Remote;
use crate::model::{
    DependencyKind, JarRecord, Launcher, LoaderInfo, LoaderKind, MrFile, MrProject, MrVersion, PackEdit, PackFixOp, PackFixOpKind,
    PackFixPlan, PackIdentity, SavedPack, SideSupport,
};
use crate::state::AppState;

/// How long a plan may wait for `save_fixed_pack`.
pub const PLAN_TTL: Duration = Duration::from_secs(15 * 60);
/// Most edits in one plan.
pub const MAX_EDITS: usize = 200;
/// The only download origin written into a copy.
pub const CDN_PREFIX: &str = "https://cdn.modrinth.com/";
/// Modrinth's download host allowlist for `.mrpack` files (the same list as `src/core`'s
/// `MRPACK_DOWNLOAD_HOSTS`).
pub const DOWNLOAD_HOSTS: [&str; 4] = ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"];
/// Longest default file name offered (characters, extension included).
const MAX_DEFAULT_NAME: usize = 120;
/// Names listed in one plan warning; the rest are counted.
const MAX_LISTED: usize = 5;
/// Most mod ids resolved through Modrinth for one plan's additions (the rest count as unsure).
const MAX_RESOLVES: usize = 64;
/// Most dependency versions fetched to learn their project (dependencies that name only a version).
const MAX_DEPENDENCY_VERSIONS: usize = 16;
/// Temp files of an earlier, interrupted save older than this are removed before writing.
const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);
const TEMP_PREFIX: &str = ".modpack-doctor-pack-";
const TEMP_SUFFIX: &str = ".tmp";

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

/// A fresh copy of a stored lookup failure (errors are not `Clone`).
fn again(e: &Error) -> Error {
    match e {
        Error::Offline => Error::Offline,
        Error::RateLimited { retry_after_s } => Error::RateLimited { retry_after_s: *retry_after_s },
        Error::Network(m) => Error::Network(m.clone()),
        other => Error::Network(format!("the lookup of the pack's declared files failed ({other})")),
    }
}

/// Letter case folded (one file on Windows and macOS; the copy may be installed anywhere).
fn fold(s: &str) -> String {
    s.to_lowercase()
}

/// Mod ids and slugs compared like `src/core` does (`normalizeId`): `-` ≡ `_`, letter case ignored.
fn same_id(a: &str, b: &str) -> bool {
    let n = |s: &str| s.trim().to_ascii_lowercase().replace('-', "_");
    !a.trim().is_empty() && n(a) == n(b)
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

/// The lower-case sha1 of an index entry (already validated by the scanner's rules).
fn entry_sha1(v: &Value) -> Option<String> {
    v.get("hashes")?.get("sha1")?.as_str().map(|s| s.trim().to_ascii_lowercase()).filter(|s| is_hex(s, 40))
}

/// "a, b, c, and 4 more" for at most [`MAX_LISTED`] names.
fn listed(names: &[String]) -> String {
    let shown: Vec<&str> = names.iter().take(MAX_LISTED).map(String::as_str).collect();
    let more = names.len().saturating_sub(shown.len());
    if more > 0 {
        format!("{}, and {more} more", shown.join(", "))
    } else {
        shown.join(", ")
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
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

/// The mrpack `env` for a project's legacy sides, or None when Modrinth does not say (or says
/// neither side runs it).
fn env_from_project(p: &MrProject) -> Option<Value> {
    let side = |s: SideSupport| match s {
        SideSupport::Required => Some("required"),
        SideSupport::Optional => Some("optional"),
        SideSupport::Unsupported => Some("unsupported"),
        SideSupport::Unknown => None,
    };
    let (c, s) = (side(p.client_side)?, side(p.server_side)?);
    (c != "unsupported" || s != "unsupported").then(|| json!({ "client": c, "server": s }))
}

/// The `env` an override jar's folder implies (the installer copies `client-overrides/` only on
/// clients and `server-overrides/` only on servers).
fn env_of_override(entry: &str) -> Option<Value> {
    if entry.starts_with("client-overrides/") {
        Some(json!({ "client": "required", "server": "unsupported" }))
    } else if entry.starts_with("server-overrides/") {
        Some(json!({ "client": "unsupported", "server": "required" }))
    } else {
        None
    }
}

/// Whether a download link is inside Modrinth's allowlist: the same rule as `src/core`'s
/// `classifyDownloadUrl` (https, no user info, port 443 or none, an allowlisted lower-case ASCII
/// host, no whitespace, control characters or backslashes). Anything else is outside.
pub fn download_allowed(url: &str) -> bool {
    if url.is_empty() || url.len() > index::MAX_URL_BYTES {
        return false;
    }
    if url.chars().any(|c| c <= ' ' || ('\u{7f}'..='\u{9f}').contains(&c) || c == '\\') {
        return false;
    }
    let Some((scheme, rest)) = url.split_once("://") else { return false };
    let scheme_ok = scheme.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
        && scheme.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'));
    if !scheme_ok || !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') || authority.starts_with('[') {
        return false;
    }
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if port.is_some_and(|p| p.contains(':') || (!p.is_empty() && p != "443")) {
        return false;
    }
    let host = host.to_ascii_lowercase();
    host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'))
        && DOWNLOAD_HOSTS.contains(&host.as_str())
}

/// The first download link of an index entry outside the allowlist, shown (its host when it has
/// one), or None when every link is inside it (or there are none).
fn outside_download(entry: &Value) -> Option<String> {
    let bad = |u: &str| {
        let host = u.split_once("://").map(|(_, r)| r.split(['/', '?', '#']).next().unwrap_or("")).filter(|h| !h.is_empty());
        display_name(host.unwrap_or(u)).chars().take(80).collect::<String>()
    };
    match entry.get("downloads") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => a.iter().find_map(|u| match u.as_str() {
            Some(s) if download_allowed(s) => None,
            Some(s) => Some(bad(s)),
            None => Some("a link that is not text".to_string()),
        }),
        Some(_) => Some("links that are not a list".to_string()),
    }
}

/// A scanner sentence ("The pack has …, so it was not scanned (…).") as the reason part of a
/// copy refusal: the scan-specific consequence and the final stop removed, the first letter
/// lowered ("the pack has …").
fn as_reason(sentence: &str) -> String {
    let mut s = sentence.trim().trim_end_matches('.').to_string();
    for tail in [
        ", so it was not scanned",
        "; so it was not scanned",
        ", so its files could not be listed",
        ", so its files were not checked (only their download links)",
    ] {
        s = s.replace(tail, "");
    }
    let mut chars = s.chars();
    match (chars.next(), chars.next()) {
        (Some(first), Some(second)) if first.is_uppercase() && second.is_lowercase() => {
            first.to_lowercase().chain(s.chars().skip(1)).collect()
        }
        _ => s,
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

/// The registered, opened pack: (registered path, canonical path, file name).
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
    zip: ZipArchive<BufReader<File>>,
    stamp: PackStamp,
    listing: archive::Listing,
}

/// Open `canon` once: stamp it, then the hardened reader on the same handle.
fn open_pack_file(canon: &Path) -> Result<Opened> {
    let mut file = File::open(canon).map_err(|e| Error::io(canon, e))?;
    let stamp = stamp_of(&mut file).map_err(|e| Error::io(canon, e))?;
    let mut zip = open_zip_file(file).map_err(|why| Error::Corrupt { path: canon.display().to_string(), reason: as_reason(&why) })?;
    let listing = archive::list(&mut zip);
    if listing.refused {
        let why = listing.issues.first().map_or_else(|| "it could not be read safely".to_string(), |i| as_reason(&i.message));
        return Err(Error::Invalid(format!("the pack cannot be copied safely because {why}")));
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

/// What Modrinth said about the declared files.
enum Lookup {
    /// sha1 → version, and the hashes whose lookup failed.
    Done { found: HashMap<String, MrVersion>, failed: HashSet<String> },
    /// Looking up mods online is switched off.
    Off,
    /// Modrinth could not be reached or answered with an error.
    Failed(Error),
}

/// An override jar the copy keeps, as the scanner reads it.
struct OverrideJar {
    entry: String,
    /// The jar itself (`parent_id` None) and the jars nested in it.
    records: Vec<JarRecord>,
}

/// The file that requires an added project.
struct Requirer {
    what: String,
    env: Option<Value>,
}

struct Planner<'a> {
    remote: Option<&'a dyn Remote>,
    zip: &'a mut ZipArchive<BufReader<File>>,
    pack: Option<PackIdentity>,
    /// `files[]` of the index; None = left out.
    files: Vec<Option<Value>>,
    /// The Modrinth version of each live `files[]` entry, when known (replacements included).
    versions: Vec<Option<MrVersion>>,
    lookup: Lookup,
    added: Vec<Value>,
    /// (project id, title) of every addition.
    added_projects: Vec<(String, String)>,
    /// Folded paths written by a replacement or an addition → the label that wrote them.
    new_paths: Vec<(String, String)>,
    /// Subject key → label of the edit that touches it.
    touched: HashMap<String, String>,
    /// Ops by edit index (additions are planned after the other edits).
    ops: Vec<Option<PackFixOp>>,
    warnings: Vec<String>,
    /// Override jars of the pack (zip entry name → entry index).
    override_jars: HashMap<String, usize>,
    left_out: Vec<(usize, String)>,
    /// The kept override jars, read on first need (additions only).
    overrides: Option<Vec<OverrideJar>>,
    /// Override jars that could not be read.
    unreadable_overrides: Vec<String>,
    /// Lower-case mod id → resolved project id (`Some(None)` = not on Modrinth, None = unknown).
    resolved: HashMap<String, Option<Option<String>>>,
}

impl Planner<'_> {
    fn touch(&mut self, key: String, label: &str, subject: &str) -> Result<()> {
        if let Some(other) = self.touched.get(&key) {
            return Err(refuse(label, format!("\"{other}\" already changes {}; keep only one of them", display_name(subject))));
        }
        self.touched.insert(key, label.to_string());
        Ok(())
    }

    /// The live `files[]` entry with exactly `path` (shadowed entries are already left out).
    fn entry_at(&self, path: &str) -> Option<usize> {
        self.files.iter().position(|f| f.as_ref().and_then(entry_path) == Some(path))
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

    /// The identified version of the declared file with `sha1` (refusals name `label`).
    fn identified(&self, label: &str, sha1: &str) -> Result<MrVersion> {
        let found = match &self.lookup {
            Lookup::Done { found, failed } => {
                if failed.contains(sha1) {
                    return Err(Error::Network(format!("Modrinth did not answer the lookup of the declared file (while checking \"{label}\")")));
                }
                found.get(sha1).cloned()
            }
            Lookup::Off => return Err(Error::Offline),
            Lookup::Failed(e) => return Err(remote_error(label, again(e))),
        };
        found.ok_or_else(|| refuse(label, "Modrinth does not know this file by its hash, so it cannot be replaced with a version of the same project"))
    }

    fn edit(&mut self, i: usize, edit: &PackEdit) -> Result<()> {
        match edit {
            PackEdit::RemoveDeclared { path } => {
                let label = format!("Remove {}", display_name(path));
                self.touch(format!("declared:{path}"), &label, path)?;
                let Some(at) = self.entry_at(path) else {
                    return Err(refuse(&label, "the pack's index lists no file at that path"));
                };
                self.files[at] = None;
                self.versions[at] = None;
                self.ops[i] = Some(PackFixOp {
                    kind: PackFixOpKind::Remove,
                    subject: path.clone(),
                    detail: "Left out of the copy's index, so launchers no longer download it.".into(),
                    url: None,
                });
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
                self.ops[i] = Some(PackFixOp {
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
                let Some(at) = self.entry_at(path) else {
                    return Err(refuse(&label, "the pack's index lists no file at that path"));
                };
                let old = self.files[at].clone().unwrap_or(Value::Null);
                let sha1 = entry_sha1(&old).ok_or_else(|| refuse(&label, "the index entry has no valid sha1, so Modrinth cannot identify it"))?;
                let f = self.new_file(&label, version_id)?;
                let current = self.identified(&label, &sha1)?;
                if current.project_id != f.version.project_id {
                    return Err(refuse(
                        &label,
                        format!("version {} belongs to a different Modrinth project than the file in the pack", display_name(&f.version.version_number)),
                    ));
                }
                if current.id == f.version.id {
                    return Err(refuse(&label, format!("the pack already has version {}", display_name(&f.version.version_number))));
                }
                if !is_newer(&f.version, &current) {
                    return Err(refuse(
                        &label,
                        format!(
                            "version {} was not published after the pack's version {}, so it would not be an update",
                            display_name(&f.version.version_number),
                            display_name(&current.version_number)
                        ),
                    ));
                }
                let new_path = format!("{}{}", folder_of(path), f.file.filename);
                if let Some(why) = archive::path_problem(&new_path) {
                    return Err(refuse(&label, format!("the new path \"{}\" is unsafe: {why}", display_name(&new_path))));
                }
                let env = old.get("env").cloned();
                let words = env_words(env.as_ref());
                self.files[at] = Some(Self::entry_for(&new_path, &f, env));
                self.new_paths.push((fold(&new_path), label.clone()));
                self.ops[i] = Some(PackFixOp {
                    kind: PackFixOpKind::Replace,
                    subject: path.clone(),
                    detail: format!("Becomes {new_path}: {}; {words}.", Self::source_words(&f)),
                    url: Some(f.file.url.clone()),
                });
                self.versions[at] = Some(f.version);
                Ok(())
            }
            PackEdit::AddDependency { version_id } => self.add(i, version_id),
        }
    }

    /// `addDependency` (after every other edit, so removals and replacements count).
    fn add(&mut self, i: usize, version_id: &str) -> Result<()> {
        let label = format!("Add version {}", display_name(version_id));
        self.touch(format!("add:{version_id}"), &label, version_id)?;
        let f = self.new_file(&label, version_id)?;
        let remote = self.remote.ok_or(Error::Offline)?;
        let project = remote.project(&f.version.project_id);
        let title = project.as_ref().map(|p| display_name(&p.title)).filter(|t| !t.trim().is_empty()).unwrap_or_else(|| f.title.clone());
        let label = format!("Add {title} {}", display_name(&f.version.version_number));
        let new_path = format!("mods/{}", f.file.filename);
        let sha1 = f.file.sha1.to_ascii_lowercase();
        let same = self.files.iter().flatten().chain(self.added.iter()).find(|e| entry_sha1(e).as_deref() == Some(sha1.as_str()));
        if let Some(same) = same {
            return Err(refuse(
                &label,
                format!("the pack already lists this exact file as {}", display_name(entry_path(same).unwrap_or("another entry"))),
            ));
        }
        if let Lookup::Failed(e) = &self.lookup {
            return Err(remote_error(&label, again(e)));
        }
        let slug = project.as_ref().map(|p| p.slug.clone()).unwrap_or_default();
        self.refuse_present(&label, &f.version.project_id, &slug, &title)?;
        let requirer = self.required_by(&label, &f.version, &slug, &title)?;
        let (env, env_words) = match project.as_ref().and_then(env_from_project) {
            Some(env) => {
                let words = format!("its env follows Modrinth's sides for {title} ({})", sides_words(&env));
                (Some(env), words)
            }
            None => match requirer.env.clone() {
                Some(env) => {
                    let words = format!("Modrinth does not say which sides {title} runs on, so it gets the env of {} ({})", requirer.what, sides_words(&env));
                    (Some(env), words)
                }
                None => (None, "it has no env, so launchers install it on both client and server".to_string()),
            },
        };
        self.added.push(Self::entry_for(&new_path, &f, env));
        self.added_projects.push((f.version.project_id.clone(), title.clone()));
        self.new_paths.push((fold(&new_path), label.clone()));
        self.ops[i] = Some(PackFixOp {
            kind: PackFixOpKind::Add,
            subject: new_path,
            detail: format!("New index entry: {}, required by {}; {env_words}.", Self::source_words(&f), requirer.what),
            url: Some(f.file.url.clone()),
        });
        Ok(())
    }

    /// Refuse adding project `project_id` when the copy already has it; warn when that cannot be
    /// ruled out.
    fn refuse_present(&mut self, label: &str, project_id: &str, slug: &str, title: &str) -> Result<()> {
        for (f, v) in self.files.iter().zip(&self.versions) {
            if let (Some(f), Some(v)) = (f, v) {
                if v.project_id == project_id {
                    let path = display_name(entry_path(f).unwrap_or("another entry"));
                    return Err(refuse(label, format!("the pack already has {title} as {path}, so it is not added again")));
                }
            }
        }
        if self.added_projects.iter().any(|(p, _)| p == project_id) {
            return Err(refuse(label, format!("another edit already adds {title}")));
        }
        // Override jars: their mod ids (and `provides`), nested jars included for the slug.
        let mut tops: Vec<(String, String)> = Vec::new();
        for jar in self.override_jars_read() {
            for r in &jar.records {
                for m in &r.mods {
                    for id in std::iter::once(&m.mod_id).chain(m.provides.iter()) {
                        if same_id(id, slug) {
                            return Err(refuse(
                                label,
                                format!("the pack's override jar {} already provides {title} (mod id {})", display_name(&jar.entry), display_name(id)),
                            ));
                        }
                        if r.parent_id.is_none() {
                            tops.push((jar.entry.clone(), id.clone()));
                        }
                    }
                }
            }
        }
        let mut unsure: Vec<String> = Vec::new();
        for (entry, id) in tops {
            match self.resolve(&id) {
                Some(Some(p)) if p == project_id => {
                    return Err(refuse(
                        label,
                        format!("the pack's override jar {} already provides {title} (mod id {})", display_name(&entry), display_name(&id)),
                    ));
                }
                Some(_) => {}
                None => {
                    if !unsure.contains(&entry) {
                        unsure.push(entry);
                    }
                }
            }
        }
        unsure.extend(self.unreadable_overrides.iter().cloned());
        let mut unknown: Vec<String> = Vec::new();
        if let Lookup::Done { .. } = self.lookup {
            for (f, v) in self.files.iter().zip(&self.versions) {
                if let (Some(f), None) = (f, v) {
                    let path = entry_path(f).unwrap_or_default();
                    if path.to_ascii_lowercase().ends_with(".jar") {
                        unknown.push(display_name(path));
                    }
                }
            }
        }
        if !unknown.is_empty() || !unsure.is_empty() {
            let mut parts = Vec::new();
            if !unknown.is_empty() {
                parts.push(format!("{} that Modrinth does not identify ({})", plural(unknown.len(), "declared jar", "declared jars"), listed(&unknown)));
            }
            if !unsure.is_empty() {
                let shown: Vec<String> = unsure.iter().map(|e| display_name(e)).collect();
                parts.push(format!("{} that could not be matched to a Modrinth project ({})", plural(unsure.len(), "override jar", "override jars"), listed(&shown)));
            }
            self.warnings.push(format!(
                "{label}: the pack has {}, so Modpack Doctor cannot rule out that it already has {title}; check that the copy does not end up with it twice.",
                parts.join(" and ")
            ));
        }
        Ok(())
    }

    /// The kept file that requires project `project_id` (a required Modrinth dependency of a
    /// declared file, or a required mod id of an override jar), or a refusal.
    fn required_by(&mut self, label: &str, v: &MrVersion, slug: &str, title: &str) -> Result<Requirer> {
        let mut by_version: Vec<(String, usize)> = Vec::new();
        for (n, (f, fv)) in self.files.iter().zip(&self.versions).enumerate() {
            let (Some(f), Some(fv)) = (f, fv) else { continue };
            if fv.project_id == v.project_id {
                continue;
            }
            for d in fv.dependencies.iter().filter(|d| d.dependency_type == "required") {
                let hit = d.project_id.as_deref() == Some(v.project_id.as_str()) || d.version_id.as_deref() == Some(v.id.as_str());
                if hit {
                    return Ok(Requirer { what: display_name(entry_path(f).unwrap_or("a declared file")), env: f.get("env").cloned() });
                }
                if d.project_id.is_none() {
                    if let Some(vid) = d.version_id.as_deref().filter(|id| crate::modrinth::validate::is_base62_id(id)) {
                        by_version.push((vid.to_string(), n));
                    }
                }
            }
        }
        // Dependencies that name only a version: fetch a few to learn their project.
        if let Some(remote) = self.remote {
            for (vid, n) in by_version.into_iter().take(MAX_DEPENDENCY_VERSIONS) {
                if remote.version(&vid).is_ok_and(|d| d.project_id == v.project_id) {
                    let f = self.files[n].as_ref();
                    let what = display_name(f.and_then(entry_path).unwrap_or("a declared file"));
                    return Ok(Requirer { what, env: f.and_then(|f| f.get("env")).cloned() });
                }
            }
        }
        // Override jars: a required mod id that is the project's slug or resolves to it.
        let loader = self.pack.as_ref().map(|p| p.loader.clone());
        let mut wanted: Vec<(String, String)> = Vec::new();
        for jar in self.override_jars_read() {
            for r in jar.records.iter().filter(|r| r.parent_id.is_none()) {
                for m in &r.mods {
                    for d in m.deps.iter().filter(|d| d.kind == DependencyKind::Required) {
                        if same_id(&d.mod_id, &m.mod_id) || loader.as_ref().is_some_and(|l| is_builtin_dependency(&d.mod_id, l)) {
                            continue;
                        }
                        if same_id(&d.mod_id, slug) {
                            return Ok(Requirer { what: display_name(&jar.entry), env: env_of_override(&jar.entry) });
                        }
                        wanted.push((jar.entry.clone(), d.mod_id.clone()));
                    }
                }
            }
        }
        for (entry, id) in wanted {
            if let Some(Some(p)) = self.resolve(&id) {
                if p == v.project_id {
                    return Ok(Requirer { what: display_name(&entry), env: env_of_override(&entry) });
                }
            }
        }
        Err(refuse(
            label,
            format!(
                "no file the copy keeps requires {title}: no declared file lists it as a required dependency on Modrinth, and no override jar requires a mod id that is {title}, so it is not added"
            ),
        ))
    }

    /// The kept override jars, read and scanned in memory once (additions only).
    fn override_jars_read(&mut self) -> &[OverrideJar] {
        if self.overrides.is_none() {
            let gone: HashSet<usize> = self.left_out.iter().map(|(i, _)| *i).collect();
            let mut entries: Vec<(String, usize)> =
                self.override_jars.iter().filter(|(_, i)| !gone.contains(i)).map(|(n, i)| (n.clone(), *i)).collect();
            entries.sort();
            let mut budget = Budget::new();
            let mut out = Vec::new();
            for (entry, idx) in entries {
                match archive::read_entry(self.zip, idx, MAX_OVERRIDE_JAR_BYTES, &mut budget) {
                    Ok(bytes) => {
                        let file_name = entry.rsplit('/').next().unwrap_or(&entry).to_string();
                        let (records, _) = crate::scan::scan_top_level_bytes(&entry, &entry, &file_name, &bytes);
                        out.push(OverrideJar { entry, records });
                    }
                    Err(_) => self.unreadable_overrides.push(entry),
                }
            }
            self.overrides = Some(out);
        }
        self.overrides.as_deref().unwrap_or_default()
    }

    /// The Modrinth project of a loader mod id (`resolve_mod_id` for the pack's loaders and
    /// Minecraft version): `Some(None)` = not on Modrinth; None = unknown (lookup failed or the
    /// per-plan cap was reached).
    fn resolve(&mut self, mod_id: &str) -> Option<Option<String>> {
        let key = mod_id.trim().to_ascii_lowercase();
        if let Some(r) = self.resolved.get(&key) {
            return r.clone();
        }
        let r = match (self.remote, self.pack.as_ref()) {
            (Some(remote), Some(pack)) if self.resolved.len() < MAX_RESOLVES => {
                let loaders: Vec<String> = modrinth_loaders(pack).into_iter().map(str::to_string).collect();
                match remote.resolve_mod_id(&key, &loaders, std::slice::from_ref(&pack.mc_version)) {
                    Ok(p) => Some(p),
                    // Not a possible Modrinth slug or id: not on Modrinth.
                    Err(Error::Invalid(_)) => Some(None),
                    Err(_) => None,
                }
            }
            _ => None,
        };
        self.resolved.insert(key, r.clone());
        r
    }
}

/// "client required, server unsupported".
fn sides_words(env: &Value) -> String {
    let side = |k: &str| env.get(k).and_then(Value::as_str).map_or_else(|| "unset".to_string(), display_name);
    format!("client {}, server {}", side("client"), side("server"))
}

/// Plan a fixed copy of the opened pack `instance_id` and store it. `remote` is None when
/// Modrinth is switched off (`replaceDeclared` / `addDependency` then fail with `Offline`, and
/// the declared files are not identified). Never writes anything.
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
        let why = issues.first().map_or_else(|| format!("its {INDEX_NAME} is unusable"), |i| as_reason(&i.message));
        return Err(Error::Invalid(format!("the pack cannot be copied because {why}")));
    };
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let mut root: Value = serde_json::from_slice(body).map_err(|e| Error::Invalid(format!("the pack's {INDEX_NAME} is not valid JSON ({e})")))?;
    let mut files: Vec<Option<Value>> = match root.get("files") {
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
    let mut warnings = Vec::new();

    // Index entries the scanner's parser skips, or that a later entry with the same path
    // shadows (installers keep the last), are left out of the copy.
    let mut rejected: Vec<(usize, String)> = Vec::new();
    let mut last_at: HashMap<String, usize> = HashMap::new();
    for (i, f) in files.iter().enumerate() {
        match f.as_ref().map(index::declared_file) {
            Some(Ok((d, _))) => {
                last_at.insert(d.path, i);
            }
            Some(Err(why)) => rejected.push((i, why)),
            None => {}
        }
    }
    let invalid: HashSet<usize> = rejected.iter().map(|(i, _)| *i).collect();
    for (i, f) in files.iter().enumerate() {
        let Some(path) = f.as_ref().and_then(entry_path) else { continue };
        if let Some(&later) = last_at.get(path) {
            if later != i && !invalid.contains(&i) {
                rejected.push((i, format!("\"{}\" is listed again as files[{later}], which installers keep instead", display_name(path))));
            }
        }
    }
    rejected.sort_by_key(|(i, _)| *i);
    for (i, _) in &rejected {
        files[*i] = None;
    }
    if !rejected.is_empty() {
        let names: Vec<String> = rejected.iter().map(|(i, why)| format!("files[{i}] ({why})")).collect();
        warnings.push(format!(
            "{} of the pack's {INDEX_NAME} that Modpack Doctor's scan skips {} left out of the copy: {}.",
            plural(rejected.len(), "entry", "entries"),
            if rejected.len() == 1 { "is" } else { "are" },
            listed(&names)
        ));
    }

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

    // One batched lookup of every declared file (fresh), when Modrinth is on.
    let lookup = match remote {
        None => Lookup::Off,
        Some(r) => {
            let mut sha1s: Vec<String> = files.iter().flatten().filter_map(entry_sha1).collect();
            sha1s.sort();
            sha1s.dedup();
            match r.identify_many(&sha1s) {
                Ok((found, failed)) => Lookup::Done { found, failed },
                Err(e) => Lookup::Failed(e),
            }
        }
    };
    let versions: Vec<Option<MrVersion>> = files
        .iter()
        .map(|f| match (&lookup, f.as_ref().and_then(entry_sha1)) {
            (Lookup::Done { found, .. }, Some(sha1)) => found.get(&sha1).cloned(),
            _ => None,
        })
        .collect();
    let original_sha1s: Vec<Option<String>> = files.iter().map(|f| f.as_ref().and_then(entry_sha1)).collect();

    let index_name = archive::inspect_entry(&mut zip, index_idx).map(|e| e.name).unwrap_or_else(|| INDEX_NAME.to_string());
    let mut p = Planner {
        remote,
        zip: &mut zip,
        pack,
        files,
        versions,
        lookup,
        added: Vec::new(),
        added_projects: Vec::new(),
        new_paths: Vec::new(),
        touched: HashMap::new(),
        ops: vec![None; edits.len()],
        warnings: Vec::new(),
        override_jars: listing.jars.iter().map(|(i, n)| (n.clone(), *i)).collect(),
        left_out: Vec::new(),
        overrides: None,
        unreadable_overrides: Vec::new(),
        resolved: HashMap::new(),
    };
    // Additions last: they are checked against what the copy keeps.
    for (i, e) in edits.iter().enumerate().filter(|(_, e)| !matches!(e, PackEdit::AddDependency { .. })) {
        p.edit(i, e)?;
    }
    for (i, e) in edits.iter().enumerate().filter(|(_, e)| matches!(e, PackEdit::AddDependency { .. })) {
        p.edit(i, e)?;
    }

    // Collisions: a new path must be the only entry with that path, and no override file the
    // copy keeps may land on it (overrides are copied over the downloads on install).
    for (_, name) in &p.left_out {
        kept_names.remove(&fold(name));
    }
    // Declared files copied unchanged that Modrinth did not identify.
    let unchanged: Vec<String> = p
        .files
        .iter()
        .zip(&original_sha1s)
        .filter_map(|(f, orig)| {
            let f = f.as_ref()?;
            (entry_sha1(f) == *orig).then(|| entry_path(f).unwrap_or_default().to_string())
        })
        .collect();
    match &p.lookup {
        Lookup::Done { found, failed } => {
            let unknown: Vec<String> = p
                .files
                .iter()
                .zip(&original_sha1s)
                .filter_map(|(f, orig)| {
                    let f = f.as_ref()?;
                    let sha1 = entry_sha1(f)?;
                    (Some(&sha1) == orig.as_ref() && !found.contains_key(&sha1)).then(|| {
                        let path = display_name(entry_path(f).unwrap_or_default());
                        if failed.contains(&sha1) {
                            format!("{path} (Modrinth did not answer)")
                        } else {
                            path
                        }
                    })
                })
                .collect();
            if !unknown.is_empty() {
                warnings.push(format!(
                    "{} the copy keeps from the pack's index {} not identified on Modrinth, so Modpack Doctor could not check {}; {} copied as {}: {}.",
                    plural(unknown.len(), "file", "files"),
                    if unknown.len() == 1 { "was" } else { "were" },
                    if unknown.len() == 1 { "it" } else { "them" },
                    if unknown.len() == 1 { "it is" } else { "they are" },
                    if unknown.len() == 1 { "it is" } else { "they are" },
                    listed(&unknown)
                ));
            }
        }
        Lookup::Off if !unchanged.is_empty() => warnings.push(format!(
            "Looking up mods online is switched off, so the {} the copy keeps from the pack's index {} not identified on Modrinth; {} copied as {}.",
            plural(unchanged.len(), "file", "files"),
            if unchanged.len() == 1 { "was" } else { "were" },
            if unchanged.len() == 1 { "it is" } else { "they are" },
            if unchanged.len() == 1 { "it is" } else { "they are" },
        )),
        Lookup::Failed(e) if !unchanged.is_empty() => warnings.push(format!(
            "Modrinth could not be asked about the {} the copy keeps from the pack's index ({}), so they were not identified; they are copied as they are.",
            plural(unchanged.len(), "file", "files"),
            e.to_string().trim_end_matches('.')
        )),
        _ => {}
    }
    let mut left_out = p.left_out;
    let ops: Vec<PackFixOp> = p.ops.into_iter().flatten().collect();
    if ops.len() != edits.len() {
        return Err(Error::Internal("an edit of the fixed copy was not planned".into()));
    }
    warnings.extend(p.warnings);
    let added_labels: Vec<String> = p.new_paths.iter().map(|(_, l)| l.clone()).collect();
    let final_files: Vec<Value> = p.files.into_iter().flatten().chain(p.added).collect();
    if final_files.len() > MAX_INDEX_FILES {
        let label = added_labels.last().cloned().unwrap_or_else(|| "The copy".into());
        return Err(refuse(
            &label,
            format!("the copy's {INDEX_NAME} would list {} files, more than the {MAX_INDEX_FILES} Modpack Doctor reads", final_files.len()),
        ));
    }
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
    // Kept entries with links outside the allowlist, and paths that differ only in letter case.
    let outside: Vec<String> = final_files
        .iter()
        .filter_map(|f| outside_download(f).map(|host| format!("{} ({host})", display_name(entry_path(f).unwrap_or_default()))))
        .collect();
    if !outside.is_empty() {
        warnings.push(format!(
            "{} the copy keeps {} download links outside Modrinth's allowlist ({}), so launchers may refuse {} or fetch {} from elsewhere: {}.",
            plural(outside.len(), "file", "files"),
            if outside.len() == 1 { "has" } else { "have" },
            DOWNLOAD_HOSTS.join(", "),
            if outside.len() == 1 { "it" } else { "them" },
            if outside.len() == 1 { "it" } else { "them" },
            listed(&outside)
        ));
    }
    let mut seen: HashMap<String, String> = HashMap::new();
    let mut cased: Vec<String> = Vec::new();
    for f in &final_files {
        let path = entry_path(f).unwrap_or_default();
        if let Some(prev) = seen.insert(fold(path), path.to_string()) {
            cased.push(format!("{} and {}", display_name(&prev), display_name(path)));
        }
    }
    if !cased.is_empty() {
        warnings.push(format!(
            "The copy's index keeps paths that differ only in letter case ({}); on Windows the later one replaces the earlier.",
            listed(&cased)
        ));
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

    if !unsafe_entries.is_empty() {
        let names: Vec<String> = unsafe_entries.iter().map(|(_, n, why)| format!("{} ({why})", display_name(n))).collect();
        warnings.push(format!(
            "{} the scan skipped {} left out of the copy: {}.",
            plural(unsafe_entries.len(), "unsafe entry", "unsafe entries"),
            if unsafe_entries.len() == 1 { "is" } else { "are" },
            listed(&names)
        ));
    }
    left_out.extend(unsafe_entries.into_iter().map(|(i, n, _)| (i, n)));

    let plan = PackFixPlan { id: crate::fix::fsops::random_hex(2), instance_id: instance_id.to_string(), pack_file_name, ops, warnings };
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

/// What to write for the path the save dialog returned: the path with `.mrpack`, and whether an
/// existing file there may be replaced — only when the dialog confirmed that exact path (a name
/// that needed the extension appended was never confirmed).
pub fn destination(picked: PathBuf) -> Result<(PathBuf, bool)> {
    let dest = enforce_mrpack_extension(picked.clone())?;
    let may_replace = dest == picked;
    Ok((dest, may_replace))
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

/// Which file `path` names (links followed): (volume serial number, file index).
#[cfg(windows)]
fn file_identity(path: &Path) -> std::io::Result<(u64, u64)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS};
    // Read access with full sharing (std's default), like any reader; folders need the flag.
    let f = OpenOptions::new().read(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0).open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is owned by `f` and open for the call; `info` is a valid out pointer.
    unsafe { GetFileInformationByHandle(HANDLE(f.as_raw_handle()), &mut info) }.map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok((u64::from(info.dwVolumeSerialNumber), (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow)))
}

/// Which file `path` names (links followed): (device, inode).
#[cfg(unix)]
fn file_identity(path: &Path) -> std::io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::metadata(path)?;
    Ok((m.dev(), m.ino()))
}

fn opened_error(shown: &str) -> Error {
    Error::Invalid(format!("{shown} is an opened pack, which Modpack Doctor never changes; save the fixed copy under another name"))
}

/// Refuse a `dest` that is an opened pack under another name: the same file (hard link,
/// junction or symlinked folder, network-share alias). A `dest` that exists but cannot be
/// identified is refused only when it would be replaced (`may_replace`).
fn refuse_same_file(shown: &str, dest: &Path, opened: &[PathBuf], may_replace: bool) -> Result<()> {
    match file_identity(dest) {
        Ok(id) => {
            if opened.iter().any(|p| file_identity(p).is_ok_and(|o| o == id)) {
                return Err(opened_error(shown));
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) if may_replace && fs::symlink_metadata(dest).is_ok() => Err(Error::io(dest, e)),
        Err(_) => Ok(()),
    }
}

#[cfg(test)]
pub(crate) mod hook {
    //! Tests: run something at a step of a save (after the copy is written, right before it is
    //! moved into place).
    use std::cell::RefCell;
    use std::path::Path;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Stage {
        /// The temp file is written and fsynced; the pack is not stamped again yet.
        Written,
        /// Checked; right before the move into place.
        BeforeMove,
    }

    type Hook = Box<dyn FnMut(Stage, &Path, &Path) -> std::io::Result<()>>;

    thread_local! {
        static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) };
    }

    pub fn set(f: impl FnMut(Stage, &Path, &Path) -> std::io::Result<()> + 'static) {
        HOOK.with(|h| *h.borrow_mut() = Some(Box::new(f)));
    }

    pub fn clear() {
        HOOK.with(|h| *h.borrow_mut() = None);
    }

    pub(super) fn at(stage: Stage, temp: &Path, dest: &Path) -> std::io::Result<()> {
        HOOK.with(|h| h.borrow_mut().as_mut().map_or(Ok(()), |f| f(stage, temp, dest)))
    }
}

#[cfg(test)]
fn hook_at(stage: hook::Stage, temp: &Path, dest: &Path) -> Result<()> {
    hook::at(stage, temp, dest).map_err(|e| Error::io(dest, e))
}

/// Why a save failed, and whether the plan may be used again.
enum SaveError {
    /// The plan stays usable (another destination, a passing problem).
    Keep(Error),
    /// The pack changed since planning: the plan is dropped.
    Stale(Error),
}

impl From<Error> for SaveError {
    fn from(e: Error) -> Self {
        SaveError::Keep(e)
    }
}

fn changed() -> SaveError {
    SaveError::Stale(Error::Conflict("The pack file changed since the fixed copy was planned. Review the edits again, then save.".into()))
}

/// Save the stored plan `plan_id` as a new pack at `dest` (picked in the native save dialog).
/// An existing `dest` is replaced only when `may_replace` (the dialog confirmed that path).
/// Single use on success; a failed save keeps the plan for another try unless the pack changed
/// since planning.
pub fn save(st: &AppState, store: &PackFixStore, plan_id: &str, dest: &Path, may_replace: bool) -> Result<SavedPack> {
    if !is_plan_id(plan_id) {
        return Err(expired_error());
    }
    let stored = store.take(plan_id)?;
    match write_copy(st, &stored, dest, may_replace) {
        Ok(saved) => Ok(saved),
        Err(SaveError::Keep(e)) => {
            store.put_back(stored);
            Err(e)
        }
        Err(SaveError::Stale(e)) => Err(e),
    }
}

fn write_copy(st: &AppState, stored: &StoredPlan, dest: &Path, may_replace: bool) -> std::result::Result<SavedPack, SaveError> {
    let shown = dest.display().to_string();
    let file_name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let dir = match dest.parent() {
        Some(d) if !d.as_os_str().is_empty() && !file_name.is_empty() => d,
        _ => return Err(Error::Invalid(format!("{shown} is not a file path")).into()),
    };
    if has_stream_colon(dest) || dest.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(Error::Invalid(format!("{shown} is not a usable file name for the copy")).into());
    }
    if !has_mrpack_extension(&file_name) {
        return Err(Error::Invalid(format!("{shown} does not end in .mrpack")).into());
    }
    // Never the opened pack itself (nor any other opened pack), under any name: those files are
    // never changed.
    let target = resolved(dest)?;
    let opened: Vec<PathBuf> = st.opened_packs().iter().map(|i| PathBuf::from(&i.root)).chain(std::iter::once(stored.pack.clone())).collect();
    if opened.iter().any(|p| same_path(p, &target) || dunce::canonicalize(p).is_ok_and(|c| same_path(&c, &target))) {
        return Err(opened_error(&shown).into());
    }
    refuse_same_file(&shown, dest, &opened, may_replace)?;
    match fs::symlink_metadata(dest) {
        Ok(m) if m.is_dir() => return Err(Error::Invalid(format!("{shown} is a folder; choose a file name")).into()),
        Ok(_) if !may_replace => return Err(exists(&shown).into()),
        _ => {}
    }

    // The pack must be exactly what was planned.
    let canon = st.guard.check_existing(&stored.pack)?;
    let Opened { mut zip, stamp, .. } = open_pack_file(&canon)?;
    if stamp != stored.stamp {
        return Err(changed());
    }
    let left_out: HashSet<usize> = stored.left_out.iter().map(|(i, _)| *i).collect();
    for (i, name) in stored.left_out.iter().chain(std::iter::once(&stored.index_entry)) {
        if archive::inspect_entry(&mut zip, *i).map(|e| e.name).as_deref() != Some(name.as_str()) {
            return Err(SaveError::Stale(Error::Conflict("The pack's contents differ from the plan. Review the edits again, then save.".into())));
        }
    }

    remove_stale_temps(dir);
    let (temp_path, temp) = create_temp(dir)?;
    let result = (|| -> std::result::Result<(), SaveError> {
        write_entries(&mut zip, stored, &left_out, temp).map_err(|e| write_error(dir, &canon, e))?;
        #[cfg(test)]
        hook_at(hook::Stage::Written, &temp_path, dest)?;
        // The pack must not have changed while it was copied.
        let still = st.guard.check_existing(&stored.pack).ok().and_then(|c| File::open(c).ok()).and_then(|mut f| stamp_of(&mut f).ok());
        if still.as_ref() != Some(&stored.stamp) {
            return Err(changed());
        }
        verify_copy(&temp_path, stored)?;
        #[cfg(test)]
        hook_at(hook::Stage::BeforeMove, &temp_path, dest)?;
        move_into_place(&temp_path, dest, may_replace, &shown, &opened)?;
        Ok(())
    })();
    drop(zip);
    if let Err(e) = result {
        let _ = fs::remove_file(&temp_path);
        return Err(e);
    }
    sync_dir(dir);
    Ok(SavedPack { path: dest.display().to_string(), file_name })
}

fn exists(shown: &str) -> Error {
    Error::Conflict(format!("{shown} already exists. Save the fixed copy again and choose another name."))
}

/// A copy failure as a sentence: I/O problems name the destination folder (disk full, no
/// permission, …); anything else means the pack's entry could not be copied.
fn write_error(dir: &Path, pack: &Path, e: ZipError) -> SaveError {
    match e {
        ZipError::Io(io) => Error::io(dir, io).into(),
        other => Error::Corrupt { path: pack.display().to_string(), reason: format!("an entry could not be copied ({other})") }.into(),
    }
}

/// True for `.modpack-doctor-pack-<16 lower-case hex>.tmp`, the temp names [`create_temp`] makes.
fn is_temp_name(name: &str) -> bool {
    name.strip_prefix(TEMP_PREFIX)
        .and_then(|r| r.strip_suffix(TEMP_SUFFIX))
        .is_some_and(|hex| hex.len() == 16 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// Best effort: remove temp files of earlier, interrupted saves in `dir` (regular files with
/// exactly the temp name pattern, last modified over [`STALE_TEMP_AGE`] ago). Nothing else.
fn remove_stale_temps(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for e in entries.flatten() {
        if !e.file_name().to_str().is_some_and(is_temp_name) {
            continue;
        }
        let path = e.path();
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        let old = meta.modified().ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age > STALE_TEMP_AGE);
        if meta.is_file() && old {
            let _ = fs::remove_file(&path);
        }
    }
}

/// A new, empty temp file in `dir` (`create_new`).
fn create_temp(dir: &Path) -> Result<(PathBuf, File)> {
    for _ in 0..16 {
        let candidate = dir.join(format!("{TEMP_PREFIX}{}{TEMP_SUFFIX}", crate::fix::fsops::random_hex(1)));
        match OpenOptions::new().write(true).read(true).create_new(true).open(&candidate) {
            Ok(f) => return Ok((candidate, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(Error::io(dir, e)),
        }
    }
    Err(Error::Conflict(format!("No free temporary file name was found in {}. Save the fixed copy again.", dir.display())))
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
    let bad = |why: String| Error::Internal(format!("the fixed copy did not read back correctly ({})", why.trim_end_matches('.')));
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

/// A plain rename (replacing) only when `may_replace`, after checking once more that `dest` is
/// not an opened pack under another name; else an atomic no-replace rename.
fn move_into_place(temp: &Path, dest: &Path, may_replace: bool, shown: &str, opened: &[PathBuf]) -> Result<()> {
    let moved = if may_replace {
        refuse_same_file(shown, dest, opened, true)?;
        fs::rename(temp, dest)
    } else {
        crate::fix::fsops::rename_noreplace(temp, dest)
    };
    match moved {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(exists(&dest.display().to_string())),
        Err(e) => Err(Error::io(dest, e)),
    }
}

/// Best effort: make the rename durable (Unix; on Windows the rename is the last step and the
/// copy itself was flushed).
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests;
