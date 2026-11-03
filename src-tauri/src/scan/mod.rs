//! Parallel jar scanner + metadata parsers. Owner: M2 agent A.
//!
//! - [`scan_mods_dir`] scans the **top level** of `<game_dir>/mods` (`*.jar` and
//!   `*.jar.disabled`, case-insensitive; subfolders are not descended into, matching how the
//!   loaders read `mods/`).
//! - [`scan_paths`] scans arbitrary relative paths under a root (e.g. `.mrpack` overrides).
//! - [`scan_jar_bytes`] analyses one in-memory jar plus all of its nested jars.
//! - [`ScanCache`] lets a caller skip unchanged jars across rescans.
//!
//! Each top-level file is read once into memory; SHA-1 and SHA-512 are computed over that
//! buffer and the zip is opened over a cursor of the same buffer. Top-level jars are scanned
//! in parallel with rayon; output is sorted by id, so it is deterministic. A broken jar never
//! aborts the scan: it is recorded as `Corrupt`/`Unreadable` with a matching `ScanIssue`.
//!
//! Jar ids come only from `crate::jar_id` (`top_level_ids`, `nested_id`).

mod fabric;
mod forge;
mod jar;
mod legacy;
mod quilt;
mod util;

#[cfg(test)]
mod perf;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use rayon::prelude::*;

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::jar_id;
use crate::model::{JarRecord, JarStatus, JarStub, ScanIssue, ScanProgress, ScanResult};
use jar::{empty_record, scan_into, JarCtx};

/// Nested jars are followed at most this many levels below a top-level jar.
pub const MAX_NESTED_DEPTH: u32 = 4;

/// True for `*.jar` / `*.jar.disabled` (ASCII case-insensitive).
pub fn is_jar_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".jar") || lower.ends_with(".jar.disabled")
}

fn is_disabled_path(path: &str) -> bool {
    jar_id::strip_disabled(path).is_some()
}

fn file_name_of(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Scan one in-memory jar (`id`/`path`/`file_name` as they should appear in the record) and all
/// of its nested jars, flattened and sorted by id. The first record with `id == id` is the jar
/// itself. Problems are reflected in each record's `status`.
pub fn scan_jar_bytes(id: &str, path: &str, file_name: &str, bytes: &[u8], depth: u32, parent_id: Option<&str>) -> Vec<JarRecord> {
    let ctx = JarCtx {
        id: id.to_string(),
        path: path.to_string(),
        file_name: file_name.to_string(),
        depth,
        parent_id: parent_id.map(str::to_string),
        disabled: is_disabled_path(path),
        mtime_ms: 0,
    };
    let mut out = Vec::new();
    let mut issues = Vec::new();
    scan_into(&ctx, bytes, &mut out, &mut issues);
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------

struct CacheEntry {
    size: u64,
    mtime_ms: u64,
    records: Vec<JarRecord>,
    issues: Vec<ScanIssue>,
}

/// Results of previous scans keyed by absolute file path + size + mtime. Hold one across
/// rescans of the same instance; unchanged jars are then not re-read. Thread-safe.
///
/// Ids are re-derived on every scan (an `x.jar.disabled` becomes `x.jar#disabled` when an
/// `x.jar` appears), so cached records are re-keyed to the current id on a hit.
#[derive(Default)]
pub struct ScanCache {
    inner: Mutex<HashMap<PathBuf, CacheEntry>>,
}

impl ScanCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, CacheEntry>> {
        // A panic while holding the lock cannot leave an entry half-written, so recover.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Cached records for `path` if its size and mtime still match.
    pub fn get(&self, path: &Path, size: u64, mtime_ms: u64) -> Option<Vec<JarRecord>> {
        self.get_entry(path, size, mtime_ms).map(|(r, _)| r)
    }

    fn get_entry(&self, path: &Path, size: u64, mtime_ms: u64) -> Option<(Vec<JarRecord>, Vec<ScanIssue>)> {
        let map = self.lock();
        let e = map.get(path)?;
        (e.size == size && e.mtime_ms == mtime_ms).then(|| (e.records.clone(), e.issues.clone()))
    }

    fn insert(&self, path: PathBuf, size: u64, mtime_ms: u64, records: Vec<JarRecord>, issues: Vec<ScanIssue>) {
        self.lock().insert(path, CacheEntry { size, mtime_ms, records, issues });
    }

    /// Drop entries under `dir` that are not in `keep` (files that disappeared).
    fn prune(&self, dir: &Path, keep: &HashSet<PathBuf>) {
        self.lock().retain(|p, _| !p.starts_with(dir) || keep.contains(p));
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        self.lock().clear();
    }
}

/// Rewrite ids from a cached scan so the top-level id is `new_id`.
fn rekey(records: &mut [JarRecord], issues: &mut [ScanIssue], old_id: &str, new_id: &str) {
    if old_id == new_id {
        return;
    }
    let prefix = format!("{old_id}!/");
    let map = |s: &str| -> Option<String> {
        if s == old_id {
            Some(new_id.to_string())
        } else {
            s.strip_prefix(&prefix).map(|rest| format!("{new_id}!/{rest}"))
        }
    };
    let remap = |s: &mut String| {
        if let Some(n) = map(s) {
            *s = n;
        }
    };
    for r in records.iter_mut() {
        remap(&mut r.id);
        if let Some(p) = r.parent_id.as_mut() {
            remap(p);
        }
        r.nested.iter_mut().for_each(remap);
    }
    for i in issues.iter_mut() {
        remap(&mut i.subject);
    }
}

// ---------------------------------------------------------------------------------------------
// Directory / path scanning
// ---------------------------------------------------------------------------------------------

/// Relative paths (`mods/<name>`) of the top-level jars in `<game_dir>/mods`, plus issues for
/// entries that could not be listed. A missing `mods/` folder is an empty list.
fn list_mods_dir(game_dir: &Path) -> Result<(Vec<String>, Vec<ScanIssue>)> {
    let dir = game_dir.join("mods");
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), Vec::new())),
        Err(e) => return Err(Error::io(&dir, e)),
    };
    let mut paths = Vec::new();
    let mut issues = Vec::new();
    for entry in rd {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                issues.push(ScanIssue { subject: "mods".into(), message: format!("Could not list part of the mods folder: {e}.") });
                continue;
            }
        };
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(raw) => {
                if is_jar_file_name(&raw.to_string_lossy()) {
                    issues.push(ScanIssue {
                        subject: "mods".into(),
                        message: format!("Skipped {}: its file name is not valid Unicode.", raw.to_string_lossy()),
                    });
                }
                continue;
            }
        };
        if !is_jar_file_name(&name) {
            continue;
        }
        // Follow symlinks; skip directories named like jars. Unstattable files are still
        // listed so they show up as unreadable.
        if std::fs::metadata(entry.path()).map(|m| m.is_dir()).unwrap_or(false) {
            continue;
        }
        paths.push(format!("mods/{name}"));
    }
    Ok((paths, issues))
}

/// Scan the top-level `*.jar` / `*.jar.disabled` files of `<game_dir>/mods`.
///
/// `on_start` receives every stub, sorted by file name (case-insensitive), before work starts.
/// `on_progress` fires once per top-level jar as it completes (completion order).
pub fn scan_mods_dir(
    game_dir: &Path,
    instance_id: &str,
    on_start: impl FnOnce(&[JarStub]),
    on_progress: impl Fn(ScanProgress) + Sync,
) -> Result<ScanResult> {
    scan_mods_dir_cached(game_dir, instance_id, None, on_start, on_progress)
}

/// [`scan_mods_dir`] reusing (and updating) `cache`.
pub fn scan_mods_dir_cached(
    game_dir: &Path,
    instance_id: &str,
    cache: Option<&ScanCache>,
    on_start: impl FnOnce(&[JarStub]),
    on_progress: impl Fn(ScanProgress) + Sync,
) -> Result<ScanResult> {
    let started_at_ms = now_ms();
    let t0 = Instant::now();
    let (paths, issues) = list_mods_dir(game_dir)?;
    let mut res = scan_rel(game_dir, &paths, instance_id, cache, on_start, on_progress);
    if let Some(c) = cache {
        let keep: HashSet<PathBuf> = paths.iter().filter_map(|p| PathGuard::join_relative(game_dir, p).ok()).collect();
        c.prune(&game_dir.join("mods"), &keep);
    }
    res.issues.extend(issues);
    finish(&mut res, started_at_ms, t0);
    Ok(res)
}

/// Scan `rel_paths` (relative to `root`, any separator) as top-level jars. Ids are the
/// normalised relative paths (see `jar_id`), e.g. `client-overrides/mods/y.jar`.
pub fn scan_paths(
    root: &Path,
    rel_paths: &[String],
    instance_id: &str,
    on_start: impl FnOnce(&[JarStub]),
    on_progress: impl Fn(ScanProgress) + Sync,
) -> Result<ScanResult> {
    scan_paths_cached(root, rel_paths, instance_id, None, on_start, on_progress)
}

/// [`scan_paths`] reusing (and updating) `cache`.
pub fn scan_paths_cached(
    root: &Path,
    rel_paths: &[String],
    instance_id: &str,
    cache: Option<&ScanCache>,
    on_start: impl FnOnce(&[JarStub]),
    on_progress: impl Fn(ScanProgress) + Sync,
) -> Result<ScanResult> {
    let started_at_ms = now_ms();
    let t0 = Instant::now();
    let mut res = scan_rel(root, rel_paths, instance_id, cache, on_start, on_progress);
    finish(&mut res, started_at_ms, t0);
    Ok(res)
}

fn finish(res: &mut ScanResult, started_at_ms: u64, t0: Instant) {
    res.jars.sort_by(|a, b| a.id.cmp(&b.id));
    res.issues.sort_by(|a, b| a.subject.cmp(&b.subject).then_with(|| a.message.cmp(&b.message)));
    res.started_at_ms = started_at_ms;
    res.duration_ms = u32::try_from(t0.elapsed().as_millis()).unwrap_or(u32::MAX);
}

fn scan_rel(
    root: &Path,
    rel_paths: &[String],
    instance_id: &str,
    cache: Option<&ScanCache>,
    on_start: impl FnOnce(&[JarStub]),
    on_progress: impl Fn(ScanProgress) + Sync,
) -> ScanResult {
    let mut stubs: Vec<JarStub> = jar_id::top_level_ids(rel_paths)
        .into_iter()
        .map(|(id, path)| JarStub { file_name: file_name_of(&path), disabled: is_disabled_path(&path), id, path })
        .collect();
    stubs.sort_by(|a, b| {
        a.file_name
            .to_lowercase()
            .cmp(&b.file_name.to_lowercase())
            .then_with(|| a.file_name.cmp(&b.file_name))
            .then_with(|| a.path.cmp(&b.path))
    });
    stubs.dedup_by(|a, b| a.path == b.path);
    on_start(&stubs);

    let total = u32::try_from(stubs.len()).unwrap_or(u32::MAX);
    let done = AtomicU32::new(0);
    let parts: Vec<(Vec<JarRecord>, Vec<ScanIssue>)> = stubs
        .par_iter()
        .map(|stub| {
            let (records, issues) = scan_top_level(root, stub, cache);
            let parsed = records.iter().find(|r| r.id == stub.id).is_some_and(|r| r.status == JarStatus::Ok);
            let n = done.fetch_add(1, Ordering::SeqCst) + 1;
            on_progress(ScanProgress { instance_id: instance_id.to_string(), done: n, total, jar_id: stub.id.clone(), parsed });
            (records, issues)
        })
        .collect();

    let mut jars = Vec::new();
    let mut issues = Vec::new();
    for (r, i) in parts {
        jars.extend(r);
        issues.extend(i);
    }
    ScanResult { instance_id: instance_id.to_string(), started_at_ms: 0, duration_ms: 0, jars, declared: Vec::new(), issues }
}

fn unreadable(ctx: &JarCtx, size: u64, err: Error) -> (Vec<JarRecord>, Vec<ScanIssue>) {
    let reason = err.to_string();
    let issue = ScanIssue { subject: ctx.id.clone(), message: reason.clone() };
    (vec![empty_record(ctx, size, JarStatus::Unreadable { reason })], vec![issue])
}

fn scan_top_level(root: &Path, stub: &JarStub, cache: Option<&ScanCache>) -> (Vec<JarRecord>, Vec<ScanIssue>) {
    let mut ctx = JarCtx {
        id: stub.id.clone(),
        path: stub.path.clone(),
        file_name: stub.file_name.clone(),
        depth: 0,
        parent_id: None,
        disabled: stub.disabled,
        mtime_ms: 0,
    };
    let full = match PathGuard::join_relative(root, &stub.path) {
        Ok(p) => p,
        Err(e) => return unreadable(&ctx, 0, e),
    };
    let meta = match std::fs::metadata(&full) {
        Ok(m) => m,
        Err(e) => return unreadable(&ctx, 0, Error::io(&stub.path, e)),
    };
    if meta.is_dir() {
        return unreadable(&ctx, 0, Error::Invalid(format!("{} is a folder, not a jar file", stub.path)));
    }
    ctx.mtime_ms = mtime_ms(&meta);

    if let Some((mut records, mut issues)) = cache.and_then(|c| c.get_entry(&full, meta.len(), ctx.mtime_ms)) {
        let old = records.iter().find(|r| r.depth == 0).map(|r| r.id.clone());
        if let Some(old) = old {
            rekey(&mut records, &mut issues, &old, &stub.id);
            return (records, issues);
        }
    }

    let bytes = match std::fs::read(&full) {
        Ok(b) => b,
        Err(e) => return unreadable(&ctx, meta.len(), Error::io(&stub.path, e)),
    };
    let mut records = Vec::new();
    let mut issues = Vec::new();
    scan_into(&ctx, &bytes, &mut records, &mut issues);
    if let Some(c) = cache {
        if bytes.len() as u64 == meta.len() {
            c.insert(full, meta.len(), ctx.mtime_ms, records.clone(), issues.clone());
        }
    }
    (records, issues)
}
