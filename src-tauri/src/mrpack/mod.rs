//! Opened `.mrpack` files (CONTRACTS.md invariant 15). Read-only: a pack is never extracted to
//! disk, never mutated, and nothing is ever downloaded.
//!
//! - [`check_pack_file`] decides whether a picked or dropped path may be opened: a regular file
//!   named `*.mrpack` (case-insensitive) of at most [`MAX_PACK_BYTES`].
//! - [`describe_pack`] builds the `Instance` (`launcher: mrpack`, `root` = `gameDir` = the pack's
//!   canonical path, id from that path, MC version and loader from the index `dependencies`).
//! - [`scan_pack`] reads `modrinth.index.json` into `ScanResult.declared` and scans every `.jar`
//!   under `overrides/`, `client-overrides/` and `server-overrides/` in memory. Jar ids and
//!   paths are the paths inside the zip.
//!
//! Zip safety ([`archive`]): entries whose path has `..`, is absolute or drive-prefixed, contains
//! a backslash or NUL, or uses a Windows reserved name are skipped as `ScanIssue`s, as are symlink
//! entries. Whole-archive limits: at most [`MAX_ENTRIES`] entries and [`MAX_TOTAL_UNCOMPRESSED`]
//! declared unpacked bytes (otherwise nothing is read). Every entry read must have a compression
//! ratio of at most [`MAX_RATIO`]:1, must not inflate past the size it declares, and is charged to
//! a per-scan budget of [`MAX_TOTAL_UNCOMPRESSED`]. The index is read only up to
//! [`MAX_INDEX_BYTES`] and may list at most [`MAX_INDEX_FILES`] files; an override jar is read
//! only up to [`MAX_OVERRIDE_JAR_BYTES`]. Every problem is a `ScanIssue`; only a pack file that
//! cannot be opened at all is an error.
//!
//! Override precedence (the Modrinth installer copies `overrides/` first, then `client-overrides/`
//! or `server-overrides/` over it): a jar present in both `overrides/` and a side folder is
//! scanned twice (distinct ids) and the shadowed `overrides/` copy gets a `ScanIssue` naming the
//! file that replaces it on that side.

pub mod archive;
pub mod index;

#[cfg(test)]
mod tests;

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use zip::ZipArchive;

use crate::discovery::{self, Os};
use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::jar_id;
use crate::model::{
    Instance, JarRecord, JarStatus, JarStub, Launcher, MetadataSource, ScanIssue, ScanProgress, ScanResult, Side,
};
use archive::{Budget, Listing};
use index::PackIndex;

pub(crate) const MIB: u64 = 1024 * 1024;
/// Largest `.mrpack` file opened.
pub const MAX_PACK_BYTES: u64 = 512 * MIB;
/// Largest `modrinth.index.json` read (unpacked).
pub const MAX_INDEX_BYTES: u64 = 8 * MIB;
/// Most `files[]` entries read from the index.
pub const MAX_INDEX_FILES: usize = 10_000;
/// Most zip entries in a pack.
pub const MAX_ENTRIES: usize = 20_000;
/// Most unpacked bytes, declared over all entries and actually read per scan.
pub const MAX_TOTAL_UNCOMPRESSED: u64 = 2 * 1024 * MIB;
/// Highest compression ratio (unpacked : packed) of an entry that is read.
pub const MAX_RATIO: u64 = 200;
/// Largest override jar read into memory.
pub const MAX_OVERRIDE_JAR_BYTES: u64 = 256 * MIB;
/// Unsafe entries reported individually; the rest are summed up in one issue.
pub const MAX_ENTRY_ISSUES: usize = 100;
pub const INDEX_NAME: &str = "modrinth.index.json";
/// Folders whose jars are scanned, in the order the Modrinth installer applies them.
pub const OVERRIDE_DIRS: [&str; 3] = ["overrides/", "client-overrides/", "server-overrides/"];
const EXTENSION: &str = ".mrpack";

pub(crate) fn issue(subject: &str, message: String) -> ScanIssue {
    ScanIssue { subject: subject.to_string(), message }
}

/// A path or string from the pack made safe to show: control characters replaced, at most 200
/// characters.
pub(crate) fn display_name(s: &str) -> String {
    let mut out: String = s.chars().take(200).map(|c| if c.is_control() { '?' } else { c }).collect();
    if s.chars().count() > 200 {
        out.push('…');
    }
    out
}

/// True for `*.mrpack` (ASCII case-insensitive).
pub fn has_mrpack_extension(name: &str) -> bool {
    name.len() > EXTENSION.len() && name.as_bytes()[name.len() - EXTENSION.len()..].eq_ignore_ascii_case(EXTENSION.as_bytes())
}

/// The rule for opening, on already-gathered facts (pure, so every branch is testable). Err is a
/// readable reason that completes "… was not added: <reason>".
pub fn check_pack_meta(name: &str, is_dir: bool, is_file: bool, len: u64) -> std::result::Result<(), String> {
    if is_dir {
        return Err("it is a folder. To add an instance folder, use Add folder instead.".into());
    }
    if !is_file {
        return Err("it is not a regular file.".into());
    }
    if !has_mrpack_extension(name) {
        return Err("only Modrinth modpacks (.mrpack files) and instance folders can be added.".into());
    }
    if len > MAX_PACK_BYTES {
        return Err(format!("it is larger than {} MiB, the most Modpack Doctor opens.", MAX_PACK_BYTES / MIB));
    }
    Ok(())
}

/// Whether `path` may be opened as a pack; returns its canonical path. Links are followed, and
/// both the given and the resolved file name must end in `.mrpack`.
pub fn check_pack_file(path: &Path) -> std::result::Result<PathBuf, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let meta = std::fs::metadata(path).map_err(|e| format!("it could not be read ({e})."))?;
    check_pack_meta(&name, meta.is_dir(), meta.is_file(), meta.len())?;
    let canon = dunce::canonicalize(path).map_err(|e| format!("it could not be read ({e})."))?;
    let canon_name = canon.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let meta = std::fs::metadata(&canon).map_err(|e| format!("it could not be read ({e})."))?;
    check_pack_meta(&canon_name, meta.is_dir(), meta.is_file(), meta.len())?;
    Ok(canon)
}

/// Open the pack's zip. Err is a readable sentence.
fn open_zip(canon: &Path) -> std::result::Result<ZipArchive<BufReader<File>>, String> {
    let file = File::open(canon).map_err(|e| format!("The pack could not be read: {e}."))?;
    ZipArchive::new(BufReader::new(file)).map_err(|e| format!("The pack is not a valid .mrpack (zip) file: {e}."))
}

/// Read and parse the index (problems appended to `issues`).
fn read_index(
    zip: &mut ZipArchive<BufReader<File>>,
    listing: &Listing,
    budget: &mut Budget,
    issues: &mut Vec<ScanIssue>,
) -> Option<PackIndex> {
    let Some(idx) = listing.index else {
        issues.push(issue(INDEX_NAME, format!("The pack has no {INDEX_NAME}, so its downloaded files could not be listed.")));
        return None;
    };
    match archive::read_entry(zip, idx, MAX_INDEX_BYTES, budget) {
        Ok(bytes) => index::parse(&bytes, issues),
        Err(why) => {
            issues.push(issue(INDEX_NAME, format!("The pack's {INDEX_NAME} was not read: {why}.")));
            None
        }
    }
}

/// The instance for an opened pack at canonical path `canon`. Never fails: when the index is
/// unusable the name is the file name and the metadata is left to inference.
pub fn describe_pack(canon: &Path) -> Instance {
    let file_name = canon.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = file_name.get(..file_name.len().saturating_sub(EXTENSION.len())).unwrap_or(&file_name).to_string();
    let shown = canon.display().to_string();
    let mut inst = Instance {
        id: discovery::instance_id(canon, Os::current()),
        name: if stem.trim().is_empty() { file_name.clone() } else { stem },
        launcher: Launcher::Mrpack,
        root: shown.clone(),
        game_dir: shown,
        mc_version: None,
        loader: None,
        side: Side::Client,
        metadata_source: MetadataSource::Inferred,
        mod_count: 0,
    };
    let Ok(mut zip) = open_zip(canon) else { return inst };
    let listing = archive::list(&zip);
    if listing.refused {
        return inst;
    }
    let mut ignored = Vec::new();
    let Some(index) = read_index(&mut zip, &listing, &mut Budget::new(), &mut ignored) else { return inst };
    if let Some(name) = index.name {
        inst.name = name;
    }
    inst.mc_version = index.mc_version;
    inst.loader = index.loader;
    inst.metadata_source = MetadataSource::Mrpack;
    let declared_jars = index.files.iter().filter(|f| f.path.to_ascii_lowercase().ends_with(".jar")).count();
    inst.mod_count = u32::try_from(declared_jars + listing.jars.len()).unwrap_or(u32::MAX);
    inst
}

/// Scan the opened pack at `pack` (checked with `guard.check_existing`, so only a registered
/// pack is read). `on_start` receives the override jars (sorted by file name, case-insensitive)
/// before any is read; `on_progress` fires once per override jar. Blocking.
///
/// Err only when the pack file itself cannot be opened (missing, outside scope, unreadable);
/// every content problem is a `ScanIssue`.
pub fn scan_pack(
    guard: &PathGuard,
    pack: &Path,
    instance_id: &str,
    on_start: impl FnOnce(&[JarStub]),
    on_progress: impl Fn(ScanProgress),
) -> Result<ScanResult> {
    let started_at_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let t0 = Instant::now();
    let canon = guard.check_existing(pack)?;
    let meta = std::fs::metadata(&canon).map_err(|e| Error::io(&canon, e))?;
    let mut res = ScanResult {
        instance_id: instance_id.to_string(),
        started_at_ms,
        duration_ms: 0,
        jars: Vec::new(),
        declared: Vec::new(),
        issues: Vec::new(),
    };
    let finish = |mut res: ScanResult| {
        res.jars.sort_by(|a, b| a.id.cmp(&b.id));
        res.issues.sort_by(|a, b| a.subject.cmp(&b.subject).then_with(|| a.message.cmp(&b.message)));
        res.duration_ms = u32::try_from(t0.elapsed().as_millis()).unwrap_or(u32::MAX);
        res
    };
    // The file was checked when it was opened; it may have changed since.
    if let Err(why) = check_pack_meta("pack.mrpack", meta.is_dir(), meta.is_file(), meta.len()) {
        res.issues.push(issue("", format!("The pack was not scanned: {why}")));
        on_start(&[]);
        return Ok(finish(res));
    }
    let mut zip = match open_zip(&canon) {
        Ok(z) => z,
        Err(why) => {
            res.issues.push(issue("", why));
            on_start(&[]);
            return Ok(finish(res));
        }
    };
    let listing = archive::list(&zip);
    res.issues.extend(listing.issues.iter().cloned());
    if listing.refused {
        on_start(&[]);
        return Ok(finish(res));
    }
    let mut budget = Budget::new();
    if let Some(index) = read_index(&mut zip, &listing, &mut budget, &mut res.issues) {
        res.declared = index.files;
    }

    // Override jars: refuse oversized / bomb-like entries before announcing the stubs.
    let mut jars: Vec<(usize, String)> = Vec::new();
    for (idx, name) in &listing.jars {
        match archive::size_problem(&zip, *idx, MAX_OVERRIDE_JAR_BYTES, &budget) {
            None => jars.push((*idx, name.clone())),
            Some(why) => res.issues.push(issue(&display_name(name), format!("Skipped this override jar: {why}."))),
        }
    }
    let rels: Vec<String> = jars.iter().map(|(_, n)| n.clone()).collect();
    let mut work: Vec<(JarStub, usize)> = jar_id::top_level_ids(&rels)
        .into_iter()
        .zip(&jars)
        .map(|((id, path), (idx, _))| {
            let file_name = path.rsplit('/').next().unwrap_or(&path).to_string();
            (JarStub { id, path, file_name, disabled: false }, *idx)
        })
        .collect();
    work.sort_by(|(a, _), (b, _)| {
        a.file_name.to_lowercase().cmp(&b.file_name.to_lowercase()).then_with(|| a.path.cmp(&b.path))
    });
    let stubs: Vec<JarStub> = work.iter().map(|(s, _)| s.clone()).collect();
    on_start(&stubs);

    let total = u32::try_from(work.len()).unwrap_or(u32::MAX);
    for (n, (stub, idx)) in work.iter().enumerate() {
        let (records, issues) = match archive::read_entry(&mut zip, *idx, MAX_OVERRIDE_JAR_BYTES, &mut budget) {
            Ok(bytes) => crate::scan::scan_top_level_bytes(&stub.id, &stub.path, &stub.file_name, &bytes),
            Err(why) => {
                let reason = format!("it could not be read from the pack: {why}");
                (vec![unreadable(stub, reason.clone())], vec![issue(&stub.id, format!("{} {reason}.", stub.file_name))])
            }
        };
        let parsed = records.iter().find(|r| r.id == stub.id).is_some_and(|r| r.status == JarStatus::Ok);
        res.jars.extend(records);
        res.issues.extend(issues);
        on_progress(ScanProgress {
            instance_id: instance_id.to_string(),
            done: u32::try_from(n + 1).unwrap_or(u32::MAX),
            total,
            jar_id: stub.id.clone(),
            parsed,
        });
    }
    res.issues.extend(precedence_notes(&stubs));
    Ok(finish(res))
}

/// One note per `overrides/` jar that a side folder replaces on install.
fn precedence_notes(stubs: &[JarStub]) -> Vec<ScanIssue> {
    let mut out = Vec::new();
    for s in stubs {
        let Some(rest) = s.path.strip_prefix("overrides/") else { continue };
        for (dir, side) in [("client-overrides/", "client"), ("server-overrides/", "server")] {
            let over = format!("{dir}{rest}");
            if stubs.iter().any(|o| o.path == over) {
                out.push(issue(&s.id, format!("On a {side} install, {over} replaces this file.")));
            }
        }
    }
    out
}

/// The record for an override jar that could not be read from the pack.
fn unreadable(stub: &JarStub, reason: String) -> JarRecord {
    JarRecord {
        id: stub.id.clone(),
        path: stub.path.clone(),
        file_name: stub.file_name.clone(),
        size: 0,
        mtime_ms: 0,
        sha1: String::new(),
        sha512: String::new(),
        disabled: false,
        depth: 0,
        parent_id: None,
        status: JarStatus::Unreadable { reason },
        metadata_errors: Vec::new(),
        loaders: Vec::new(),
        mods: Vec::new(),
        packages: Vec::new(),
        mixin_configs: Vec::new(),
        max_class_major: None,
        module_name: None,
        fml_mod_type: None,
        jarjar: None,
        nested: Vec::new(),
    }
}
