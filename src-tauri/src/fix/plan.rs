//! `plan_work_order`: intents → a stored, fingerprinted work order. Never mutates anything.
//!
//! Refusal rules (each names the action, e.g. "Replace sodium-0.5.8.jar: …"):
//! - the instance id is malformed or unknown, or the instance is a read-only `.mrpack`;
//! - no actions, or more than [`MAX_ACTIONS`];
//! - the `PackIdentity` contradicts a stored override or the launcher/mrpack metadata;
//! - a jar id that is not `mods/<file>` (optionally `#disabled`), or does not resolve to a file
//!   in a fresh listing of `mods/`, or resolves outside the PathGuard roots (symlinks);
//! - Disable of a disabled jar, Enable of an enabled jar, or a rename destination that exists;
//! - RemoveDuplicate with `keep == remove`, or a `keep` jar that is missing;
//! - two actions touching the same file;
//! - Replace / InstallDependency with Modrinth off (`Offline`), a version id that is invalid or
//!   unknown, a version without the pack loader (NeoForge 1.20.1 also accepts `forge`, Quilt
//!   also `fabric`), without the pack MC version, without a download file under the invariant-8
//!   rule, without a size, with an unsafe file name, or whose `mods/<file>` already exists;
//! - Replace of a disabled jar, of a jar Modrinth does not know by its sha1, of a jar from
//!   another project, with a version not published strictly after the current one (or a date
//!   missing), or of a jar that declares no mod id (the download could not be verified);
//! - InstallDependency with a malformed mod id.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::jar_id;
use crate::model::{
    FileOp, FixAction, Instance, Launcher, LoaderInfo, LoaderKind, MetadataSource, MrFile, MrVersion, PackIdentity,
    PackOverride, PlannedOp, WorkOrder, WorkOrderKind,
};
use crate::state::AppState;

use super::fsops::{self, Stamp};
use super::remote::Remote;
use super::{Check, Expect, Loc, OpPlan, StoredOrder};

pub const MAX_ACTIONS: usize = 500;
const MAX_MANUAL_STEPS: usize = 50;
const MAX_STEP_CHARS: usize = 500;
/// Leaves room for `.<name>.<16 hex>.part` within the client's 200-byte file name limit.
const MAX_FILE_NAME: usize = 160;
const EXCLUDED_FILE_TYPES: [&str; 4] = ["sources-jar", "dev-jar", "javadoc-jar", "signature"];

fn refuse(label: &str, msg: impl std::fmt::Display) -> Error {
    Error::Invalid(format!("{label}: {msg}"))
}

/// Keep the action's own wording on network errors; everything else becomes a readable refusal.
fn remote_error(label: &str, e: Error) -> Error {
    match e {
        Error::Offline | Error::RateLimited { .. } => e,
        Error::Network(m) => Error::Network(format!("{m} (while checking \"{label}\")")),
        Error::NotFound { path } => refuse(label, format!("Modrinth does not know {path}")),
        Error::Invalid(m) => refuse(label, m),
        other => other,
    }
}

// ── Pack identity ────────────────────────────────────────────────────────────

fn describe_loader(l: &LoaderInfo) -> String {
    let kind = match l.kind {
        LoaderKind::Forge => "Forge",
        LoaderKind::Neoforge => "NeoForge",
        LoaderKind::Fabric => "Fabric",
        LoaderKind::Quilt => "Quilt",
        LoaderKind::Legacyforge => "legacy Forge",
        LoaderKind::Unknown => "an unknown loader",
    };
    match &l.version {
        Some(v) => format!("{kind} {v}"),
        None => kind.to_string(),
    }
}

/// The identity sent with the plan must agree with a stored override (highest precedence) and
/// otherwise with launcher/mrpack metadata, exactly as `src/core/pack` resolves it. Parts the
/// metadata does not supply (`metadataSource: inferred`) are accepted as sent.
pub fn validate_pack(inst: &Instance, ov: Option<&PackOverride>, pack: &PackIdentity) -> Result<()> {
    let contradiction = |what: &str, sent: &str, known: &str, from: &str| {
        Error::Invalid(format!(
            "the pack {what} sent with the fixes ({sent}) contradicts the {from} ({known}); rescan the instance and review the fixes again"
        ))
    };
    let meta = matches!(inst.metadata_source, MetadataSource::Launcher | MetadataSource::Mrpack);
    let mc = pack.mc_version.trim();
    if mc.is_empty() || mc != pack.mc_version {
        return Err(Error::Invalid("the pack's Minecraft version is missing or malformed".into()));
    }
    if let Some(want) = ov.and_then(|o| o.mc_version.as_deref()).filter(|v| !v.is_empty()) {
        if want != mc {
            return Err(contradiction("Minecraft version", mc, want, "stored override"));
        }
    } else if let (true, Some(want)) = (meta, inst.mc_version.as_deref()) {
        if want != mc {
            return Err(contradiction("Minecraft version", mc, want, "launcher metadata"));
        }
    }
    if let Some(want) = ov.and_then(|o| o.loader.as_ref()) {
        if *want != pack.loader {
            return Err(contradiction("loader", &describe_loader(&pack.loader), &describe_loader(want), "stored override"));
        }
    } else if meta {
        match &inst.loader {
            Some(want) if *want != pack.loader => {
                return Err(contradiction("loader", &describe_loader(&pack.loader), &describe_loader(want), "launcher metadata"));
            }
            // Launcher metadata without a loader = vanilla; only "unknown" agrees with that.
            None if pack.loader.kind != LoaderKind::Unknown || pack.loader.version.is_some() => {
                return Err(contradiction("loader", &describe_loader(&pack.loader), "vanilla, no mod loader", "launcher metadata"));
            }
            _ => {}
        }
    }
    Ok(())
}

/// Modrinth loader names that the pack loads (the TS `modrinthLoaders` twin).
pub fn modrinth_loaders(pack: &PackIdentity) -> Vec<&'static str> {
    match pack.loader.kind {
        LoaderKind::Forge | LoaderKind::Legacyforge => vec!["forge"],
        LoaderKind::Neoforge if pack.mc_version.trim() == "1.20.1" => vec!["neoforge", "forge"],
        LoaderKind::Neoforge => vec!["neoforge"],
        LoaderKind::Fabric => vec!["fabric"],
        LoaderKind::Quilt => vec!["quilt", "fabric"],
        LoaderKind::Unknown => vec![],
    }
}

// ── Modrinth version checks ──────────────────────────────────────────────────

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// `datePublished` as (epoch seconds, nanoseconds): ISO 8601 with a time and an explicit zone,
/// exactly what the TS `publishedKey` accepts. None = missing or invalid (never "newer").
pub fn published_key(s: &str) -> Option<(i64, u32)> {
    let b = s.trim().as_bytes();
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = b.get(r)?;
        if part.iter().all(u8::is_ascii_digit) {
            std::str::from_utf8(part).ok()?.parse().ok()
        } else {
            None
        }
    };
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d, h, mi, sec) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    let mut i = 19;
    let mut nanos: u32 = 0;
    if matches!(b.get(i), Some(b'.' | b',')) {
        i += 1;
        let start = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return None;
        }
        let digits = std::str::from_utf8(&b[start..i.min(start + 9)]).ok()?;
        nanos = format!("{digits:0<9}").parse().ok()?;
    }
    let offset_s = match b.get(i) {
        Some(b'Z' | b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) => {
            let rest = &b[i + 1..];
            let (oh, om) = match rest.len() {
                5 if rest[2] == b':' => (num(i + 1..i + 3)?, num(i + 4..i + 6)?),
                4 => (num(i + 1..i + 3)?, num(i + 3..i + 5)?),
                _ => return None,
            };
            if oh > 23 || om > 59 {
                return None;
            }
            let o = (oh * 60 + om) * 60;
            if *sign == b'-' {
                -o
            } else {
                o
            }
        }
        _ => return None,
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec - offset_s;
    Some((secs, nanos))
}

/// True only when `candidate` is another version published strictly after `current`.
pub fn is_newer(candidate: &MrVersion, current: &MrVersion) -> bool {
    let key = |v: &MrVersion| v.date_published.as_deref().and_then(published_key);
    match (key(candidate), key(current)) {
        (Some(a), Some(b)) => candidate.id != current.id && a > b,
        _ => false,
    }
}

/// The invariant-8 download file (identical to the TS `downloadFile`): excluded file types
/// dropped; the primary file, else the sole file; refused when the primary was dropped, or when
/// none is primary and the client dropped any file.
pub fn download_file(v: &MrVersion) -> std::result::Result<&MrFile, &'static str> {
    if v.primary_dropped {
        return Err("Modrinth's primary file for this version is not a verifiable CDN download");
    }
    let candidates: Vec<&MrFile> = v
        .files
        .iter()
        .filter(|f| f.file_type.as_deref().is_none_or(|t| !EXCLUDED_FILE_TYPES.contains(&t)))
        .collect();
    if let Some(p) = candidates.iter().find(|f| f.primary) {
        return Ok(p);
    }
    if v.dropped_files > 0 {
        return Err("no file of this version is marked primary and some of its files are not verifiable CDN downloads");
    }
    match candidates.as_slice() {
        [only] => Ok(only),
        [] => Err("this version has no downloadable file"),
        _ => Err("this version has several files and none is marked primary"),
    }
}

/// A downloaded file name must be one safe path segment ending in `.jar`.
pub fn check_jar_file_name(name: &str) -> std::result::Result<(), String> {
    let bad = || Err(format!("Modrinth's file name \"{}\" is not a safe jar file name", clip(name, 80)));
    if name.len() > MAX_FILE_NAME || name.contains("..") || name.contains(['/', '\\']) || name.starts_with('.') {
        return bad();
    }
    if !name.to_ascii_lowercase().ends_with(".jar") || name.len() <= 4 {
        return bad();
    }
    if crate::modrinth::validate::file_name(name).is_err() || PathGuard::join_relative(Path::new("mods"), name).is_err() {
        return bad();
    }
    Ok(())
}

fn clip(s: &str, n: usize) -> String {
    let mut out: String = s.chars().filter(|c| !c.is_control()).take(n).collect();
    if s.chars().count() > n {
        out.push('…');
    }
    out
}

/// Loader + MC checks shared by Replace and InstallDependency.
fn check_version_fits(label: &str, v: &MrVersion, pack: &PackIdentity) -> Result<()> {
    let wanted = modrinth_loaders(pack);
    if wanted.is_empty() {
        return Err(refuse(label, "the pack's mod loader is unknown, so a Modrinth version cannot be checked against it"));
    }
    if !v.loaders.iter().any(|l| wanted.iter().any(|w| l.eq_ignore_ascii_case(w))) {
        return Err(refuse(
            label,
            format!(
                "version {} is for {}, not for this pack's loader ({})",
                v.version_number,
                if v.loaders.is_empty() { "no listed loader".to_string() } else { v.loaders.join(", ") },
                describe_loader(&pack.loader)
            ),
        ));
    }
    if !v.game_versions.iter().any(|g| g == &pack.mc_version) {
        return Err(refuse(
            label,
            format!("version {} does not list Minecraft {}, the pack's version", v.version_number, pack.mc_version),
        ));
    }
    Ok(())
}

// ── Planner ──────────────────────────────────────────────────────────────────

/// A jar resolved against a fresh stat of `mods/`.
struct Jar {
    /// Actual relative path (`mods/x.jar` or `mods/x.jar.disabled`).
    rel: String,
    full: PathBuf,
    stamp: Stamp,
    disabled: bool,
}

enum TitleItem {
    Disable(String),
    Enable(String),
    Remove(String),
    Replace(String),
    Install(String),
    Manual(usize),
}

struct Planner<'a> {
    guard: &'a PathGuard,
    game_dir: PathBuf,
    pack: &'a PackIdentity,
    remote: Option<&'a dyn Remote>,
    ops: Vec<PlannedOp>,
    plans: Vec<OpPlan>,
    notes: Vec<String>,
    title: Vec<TitleItem>,
    /// Folded relative path → (index, label) of the action that touches it.
    touched: HashMap<String, (u32, String)>,
    /// Index of the action being planned.
    current: u32,
}

/// The file name shown in action labels for a jar id.
pub(crate) fn id_name(id: &str) -> String {
    let base = id.strip_suffix(jar_id::DISABLED_MARKER).unwrap_or(id);
    clip(fsops::file_name_of(base), 80)
}

impl<'a> Planner<'a> {
    fn resolve(&self, label: &str, id: &str) -> Result<Jar> {
        let base = id.strip_suffix(jar_id::DISABLED_MARKER).unwrap_or(id);
        let name = base.strip_prefix("mods/").unwrap_or("");
        if name.is_empty() || name.contains(['/', '\\']) || !crate::scan::is_jar_file_name(name) || id.contains("!/") {
            return Err(refuse(label, format!("\"{}\" is not a jar in the mods folder", clip(id, 80))));
        }
        PathGuard::join_relative(&self.game_dir, base).map_err(|_| refuse(label, format!("\"{}\" is not a safe path", clip(id, 80))))?;
        let rel = jar_id::resolve(&self.game_dir, id)
            .ok_or_else(|| refuse(label, format!("{} is no longer in the mods folder; rescan the instance and try again", id_name(id))))?;
        let full = fsops::existing(self.guard, &self.game_dir, &rel)?;
        let stamp = fsops::stamp(&full)?;
        let disabled = jar_id::strip_disabled(&rel).is_some();
        Ok(Jar { rel, full, stamp, disabled })
    }

    fn touch(&mut self, label: &str, rel: &str) -> Result<()> {
        let key = fsops::fold(rel);
        if let Some((index, other)) = self.touched.get(&key) {
            if *index != self.current {
                return Err(refuse(label, format!("\"{other}\" also changes {rel}; apply them one at a time")));
            }
        }
        self.touched.insert(key, (self.current, label.to_string()));
        Ok(())
    }

    fn push(&mut self, action_index: u32, op: FileOp, plan: OpPlan) {
        self.ops.push(PlannedOp { action_index, op });
        self.plans.push(plan);
    }

    fn absent(&self, label: &str, rel: &str) -> Result<()> {
        let p = fsops::new_path(self.guard, &self.game_dir, rel)?;
        if !fsops::is_absent(&p) {
            return Err(refuse(label, format!("{rel} already exists and is never overwritten")));
        }
        Ok(())
    }

    fn rename(&mut self, i: u32, label: &str, jar: Jar, to: String) -> Result<()> {
        self.absent(label, &to)?;
        self.touch(label, &jar.rel)?;
        self.touch(label, &to)?;
        let checks = vec![
            Check { loc: Loc::Game, rel: jar.rel.clone(), expect: Expect::File(jar.stamp) },
            Check { loc: Loc::Game, rel: to.clone(), expect: Expect::Absent },
        ];
        self.push(i, FileOp::Rename { from: jar.rel, to }, OpPlan { checks, expect_mod_ids: Vec::new() });
        Ok(())
    }

    fn remote(&self) -> Result<&'a dyn Remote> {
        self.remote.ok_or(Error::Offline)
    }

    /// The version (validated) and its download file, with the safe destination.
    fn version_and_file(&self, label: &str, version_id: &str) -> Result<(MrVersion, MrFile, String)> {
        if !crate::modrinth::validate::is_base62_id(version_id) {
            return Err(refuse(label, format!("\"{}\" is not a Modrinth version id", clip(version_id, 40))));
        }
        let v = self.remote()?.version(version_id).map_err(|e| remote_error(label, e))?;
        check_version_fits(label, &v, self.pack)?;
        let file = download_file(&v).map_err(|m| refuse(label, m))?.clone();
        check_jar_file_name(&file.filename).map_err(|m| refuse(label, m))?;
        if file.size.is_none() {
            return Err(refuse(label, format!("Modrinth did not report the size of {}", file.filename)));
        }
        let dest = format!("mods/{}", file.filename);
        Ok((v, file, dest))
    }

    fn action(&mut self, i: u32, action: &FixAction) -> Result<()> {
        match action {
            FixAction::Disable { jar_id } => {
                let label = format!("Disable {}", id_name(jar_id));
                let jar = self.resolve(&label, jar_id)?;
                if jar.disabled {
                    return Err(refuse(&label, "the jar is already disabled"));
                }
                let to = format!("{}{}", jar.rel, jar_id::DISABLED_SUFFIX);
                self.title.push(TitleItem::Disable(fsops::file_name_of(&jar.rel).to_string()));
                self.rename(i, &label, jar, to)
            }
            FixAction::Enable { jar_id } => {
                let label = format!("Enable {}", id_name(jar_id));
                let jar = self.resolve(&label, jar_id)?;
                let Some(base) = jar_id::strip_disabled(&jar.rel).map(str::to_string) else {
                    return Err(refuse(&label, "the jar is already enabled"));
                };
                self.title.push(TitleItem::Enable(fsops::file_name_of(&base).to_string()));
                self.rename(i, &label, jar, base)
            }
            FixAction::RemoveDuplicate { keep, remove } => {
                let label = format!("Remove {}", id_name(remove));
                if keep == remove {
                    return Err(refuse(&label, "the jar to keep and the jar to remove are the same"));
                }
                let gone = self.resolve(&label, remove)?;
                let kept = self.resolve(&label, keep).map_err(|e| match e {
                    Error::Invalid(m) if m.contains("no longer in the mods folder") => {
                        refuse(&label, format!("the jar to keep ({}) is not in the mods folder", id_name(keep)))
                    }
                    other => other,
                })?;
                if fsops::fold(&kept.rel) == fsops::fold(&gone.rel) {
                    return Err(refuse(&label, "the jar to keep and the jar to remove are the same file"));
                }
                self.touch(&label, &gone.rel)?;
                self.touch(&label, &kept.rel)?;
                let backup = format!("files/{}", gone.rel);
                let checks = vec![
                    Check { loc: Loc::Game, rel: gone.rel.clone(), expect: Expect::File(gone.stamp) },
                    Check { loc: Loc::Game, rel: kept.rel.clone(), expect: Expect::File(kept.stamp) },
                    Check { loc: Loc::Snapshot, rel: backup, expect: Expect::Absent },
                ];
                self.title.push(TitleItem::Remove(fsops::file_name_of(&gone.rel).to_string()));
                self.push(i, FileOp::MoveToBackup { path: gone.rel }, OpPlan { checks, expect_mod_ids: Vec::new() });
                Ok(())
            }
            FixAction::Replace { jar_id, version_id } => {
                let label = format!("Replace {}", id_name(jar_id));
                let jar = self.resolve(&label, jar_id)?;
                if jar.disabled {
                    return Err(refuse(&label, "the jar is disabled; enable it first"));
                }
                let remote = self.remote()?;
                let (v, file, dest) = self.version_and_file(&label, version_id)?;
                let current = remote
                    .identify(&jar.stamp.sha1)
                    .map_err(|e| remote_error(&label, e))?
                    .ok_or_else(|| refuse(&label, "Modrinth does not know this jar by its hash, so it cannot be replaced"))?;
                if current.project_id != v.project_id {
                    return Err(refuse(&label, format!("version {} belongs to a different Modrinth project than the installed jar", v.version_number)));
                }
                if !is_newer(&v, &current) {
                    return Err(refuse(
                        &label,
                        format!(
                            "version {} is not published after the installed version {} (that would be a downgrade or a reinstall)",
                            v.version_number, current.version_number
                        ),
                    ));
                }
                let same_path = fsops::fold(&dest) == fsops::fold(&jar.rel);
                if !same_path {
                    self.absent(&label, &dest)?;
                } else {
                    fsops::new_path(self.guard, &self.game_dir, &dest)?;
                }
                let ids = declared_mod_ids(&jar)?;
                if ids.is_empty() {
                    return Err(refuse(&label, "the installed jar declares no mod id, so the download could not be verified"));
                }
                self.touch(&label, &jar.rel)?;
                self.touch(&label, &dest)?;
                let mut checks = vec![
                    Check { loc: Loc::Game, rel: jar.rel.clone(), expect: Expect::File(jar.stamp.clone()) },
                    Check { loc: Loc::Snapshot, rel: format!("files/{}", jar.rel), expect: Expect::Absent },
                ];
                if !same_path {
                    checks.push(Check { loc: Loc::Game, rel: dest.clone(), expect: Expect::Absent });
                }
                let title = remote.project_title(&v.project_id).unwrap_or_else(|| ids[0].clone());
                self.title.push(TitleItem::Replace(title.clone()));
                let op = FileOp::Download {
                    project_title: title,
                    version_number: v.version_number.clone(),
                    size_bytes: file.size.unwrap_or(0),
                    url: file.url.clone(),
                    sha512: file.sha512.clone(),
                    dest,
                    replaces: Some(jar.rel.clone()),
                };
                self.push(i, op, OpPlan { checks, expect_mod_ids: ids });
                Ok(())
            }
            FixAction::InstallDependency { mod_id, version_id } => {
                let label = format!("Install {}", clip(mod_id, 64));
                let ok = !mod_id.is_empty()
                    && mod_id.len() <= 64
                    && mod_id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
                if !ok {
                    return Err(refuse(&label, "that is not a valid mod id"));
                }
                let remote = self.remote()?;
                let (v, file, dest) = self.version_and_file(&label, version_id)?;
                self.absent(&label, &dest)?;
                self.touch(&label, &dest)?;
                let title = remote.project_title(&v.project_id).unwrap_or_else(|| mod_id.clone());
                self.title.push(TitleItem::Install(mod_id.clone()));
                let op = FileOp::Download {
                    project_title: title,
                    version_number: v.version_number.clone(),
                    size_bytes: file.size.unwrap_or(0),
                    url: file.url.clone(),
                    sha512: file.sha512.clone(),
                    dest: dest.clone(),
                    replaces: None,
                };
                let checks = vec![Check { loc: Loc::Game, rel: dest, expect: Expect::Absent }];
                self.push(i, op, OpPlan { checks, expect_mod_ids: vec![mod_id.clone()] });
                Ok(())
            }
            FixAction::Manual { steps } => {
                if steps.len() > MAX_MANUAL_STEPS {
                    return Err(Error::Invalid(format!("a manual fix has more than {MAX_MANUAL_STEPS} steps")));
                }
                let mut n = 0;
                for s in steps {
                    let s = clip(s.trim(), MAX_STEP_CHARS);
                    if !s.is_empty() {
                        self.notes.push(format!("Manual step: {s}"));
                        n += 1;
                    }
                }
                if n > 0 {
                    self.title.push(TitleItem::Manual(n));
                }
                Ok(())
            }
        }
    }
}

/// Mod ids (incl. `provides`) the top-level jar itself declares.
pub(crate) fn jar_mod_ids(bytes: &[u8], rel: &str) -> Vec<String> {
    let name = fsops::file_name_of(rel);
    let records = crate::scan::scan_jar_bytes(rel, rel, name, bytes, 0, None);
    let mut ids: Vec<String> = Vec::new();
    if let Some(top) = records.iter().find(|r| r.id == rel) {
        for m in &top.mods {
            for id in std::iter::once(&m.mod_id).chain(m.provides.iter()) {
                if !id.is_empty() && !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
    }
    ids
}

/// The installed jar's own mod ids (not `provides`): the replacement must declare one of them.
fn declared_mod_ids(jar: &Jar) -> Result<Vec<String>> {
    let bytes = std::fs::read(&jar.full).map_err(|e| Error::io(&jar.full, e))?;
    let records = crate::scan::scan_jar_bytes(&jar.rel, &jar.rel, fsops::file_name_of(&jar.rel), &bytes, 0, None);
    let mut ids: Vec<String> = Vec::new();
    if let Some(top) = records.iter().find(|r| r.id == jar.rel) {
        for m in &top.mods {
            if !m.mod_id.is_empty() && !ids.contains(&m.mod_id) {
                ids.push(m.mod_id.clone());
            }
        }
    }
    Ok(ids)
}

fn title_of(items: &[TitleItem]) -> String {
    #[derive(PartialEq, Clone, Copy)]
    enum K {
        Disable,
        Enable,
        Remove,
        Replace,
        Install,
        Manual,
    }
    let mut groups: Vec<(K, Vec<&str>, usize)> = Vec::new();
    for it in items {
        let (k, name, n) = match it {
            TitleItem::Disable(s) => (K::Disable, Some(s.as_str()), 1),
            TitleItem::Enable(s) => (K::Enable, Some(s.as_str()), 1),
            TitleItem::Remove(s) => (K::Remove, Some(s.as_str()), 1),
            TitleItem::Replace(s) => (K::Replace, Some(s.as_str()), 1),
            TitleItem::Install(s) => (K::Install, Some(s.as_str()), 1),
            TitleItem::Manual(n) => (K::Manual, None, *n),
        };
        match groups.iter_mut().find(|g| g.0 == k) {
            Some(g) => {
                g.1.extend(name);
                g.2 += n;
            }
            None => groups.push((k, name.into_iter().collect(), n)),
        }
    }
    let parts: Vec<String> = groups
        .into_iter()
        .map(|(k, names, n)| {
            let one = names.first().copied().unwrap_or("");
            match (k, n) {
                (K::Disable, 1) => format!("disable {one}"),
                (K::Disable, n) => format!("disable {n} mods"),
                (K::Enable, 1) => format!("enable {one}"),
                (K::Enable, n) => format!("enable {n} mods"),
                (K::Remove, 1) => format!("remove {one}"),
                (K::Remove, n) => format!("remove {n} duplicates"),
                (K::Replace, 1) => format!("replace {one}"),
                (K::Replace, n) => format!("replace {n} mods"),
                (K::Install, 1) => format!("install {one}"),
                (K::Install, n) => format!("install {n} dependencies"),
                (K::Manual, 1) => "1 manual step".to_string(),
                (K::Manual, n) => format!("{n} manual steps"),
            }
        })
        .collect();
    capitalize(&parts.join(", "))
}

pub(crate) fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

/// Lower-case the first character (for "Undo disable x").
pub(crate) fn decapitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().chain(c).collect(),
        None => String::new(),
    }
}

/// "Disable x.jar", "Replace sodium.jar", "Install cloth-config", "Manual steps".
pub(crate) fn action_label(a: &FixAction) -> String {
    match a {
        FixAction::Disable { jar_id } => format!("Disable {}", id_name(jar_id)),
        FixAction::Enable { jar_id } => format!("Enable {}", id_name(jar_id)),
        FixAction::RemoveDuplicate { remove, .. } => format!("Remove {}", id_name(remove)),
        FixAction::Replace { jar_id, .. } => format!("Replace {}", id_name(jar_id)),
        FixAction::InstallDependency { mod_id, .. } => format!("Install {}", clip(mod_id, 64)),
        FixAction::Manual { .. } => "Manual steps".to_string(),
    }
}

pub(crate) fn title_for(actions: &[FixAction]) -> String {
    // Names without resolving files (used for undo titles).
    let items: Vec<TitleItem> = actions
        .iter()
        .filter_map(|a| match a {
            FixAction::Disable { jar_id } => Some(TitleItem::Disable(id_name(jar_id))),
            FixAction::Enable { jar_id } => Some(TitleItem::Enable(id_name(jar_id))),
            FixAction::RemoveDuplicate { remove, .. } => Some(TitleItem::Remove(id_name(remove))),
            FixAction::Replace { jar_id, .. } => Some(TitleItem::Replace(id_name(jar_id))),
            FixAction::InstallDependency { mod_id, .. } => Some(TitleItem::Install(clip(mod_id, 64))),
            FixAction::Manual { steps } => (!steps.is_empty()).then_some(TitleItem::Manual(steps.len())),
        })
        .collect();
    title_of(&items)
}

/// The instance an order may act on (registered, not a `.mrpack`), with its game dir vetted.
pub(crate) fn instance_for(st: &AppState, instance_id: &str) -> Result<(Instance, PathBuf)> {
    if !super::is_instance_id(instance_id) {
        return Err(Error::Invalid(format!("\"{}\" is not an instance id", clip(instance_id, 40))));
    }
    let reg = st.instance(instance_id)?;
    if reg.instance.launcher == Launcher::Mrpack {
        return Err(Error::Invalid(format!("\"{}\" is a .mrpack file, which Modpack Doctor never changes", reg.instance.name)));
    }
    let game_dir = st.guard.check_existing(&reg.game_dir)?;
    Ok((reg.instance, game_dir))
}

/// `plan_work_order`. `remote` is None when Modrinth is turned off (Replace / InstallDependency
/// then fail with `Offline`). Stores the order and returns it.
pub fn plan_order(
    st: &AppState,
    remote: Option<&dyn Remote>,
    instance_id: &str,
    pack: &PackIdentity,
    actions: &[FixAction],
) -> Result<WorkOrder> {
    let (inst, game_dir) = instance_for(st, instance_id)?;
    if actions.is_empty() {
        return Err(Error::Invalid("there are no fixes to apply".into()));
    }
    if actions.len() > MAX_ACTIONS {
        return Err(Error::Invalid(format!("at most {MAX_ACTIONS} fixes can be applied at once")));
    }
    let ov = st.settings.get().overrides.get(instance_id).cloned();
    validate_pack(&inst, ov.as_ref(), pack)?;
    let backups_root = st.fixes.backups_root()?;

    let mut p = Planner {
        guard: &st.guard,
        game_dir: game_dir.clone(),
        pack,
        remote,
        ops: Vec::new(),
        plans: Vec::new(),
        notes: Vec::new(),
        title: Vec::new(),
        touched: HashMap::new(),
        current: 0,
    };
    for (i, a) in actions.iter().enumerate() {
        p.current = u32::try_from(i).unwrap_or(u32::MAX);
        p.action(p.current, a)?;
    }

    let created_ms = loop {
        let ms = st.fixes.next_ms();
        if fsops::is_absent(&super::snapshot_dir(&backups_root, instance_id, ms)) {
            break ms;
        }
    };
    let snapshot_dir = super::snapshot_dir(&backups_root, instance_id, created_ms);
    let order = WorkOrder {
        id: fsops::random_hex(2),
        instance_id: instance_id.to_string(),
        kind: WorkOrderKind::Fix,
        title: title_of(&p.title),
        actions: actions.to_vec(),
        ops: p.ops,
        notes: p.notes,
        backup_dir: snapshot_dir.display().to_string(),
    };
    st.fixes.store(StoredOrder {
        order: order.clone(),
        plans: p.plans,
        game_dir,
        snapshot_dir,
        backup_id: format!("{instance_id}/{created_ms}"),
        created_ms,
        undo: None,
        expires: Instant::now() + st.fixes.ttl(),
    });
    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_match_the_ts_rule() {
        let a = published_key("2024-05-01T10:00:00.123456Z").expect("a");
        let b = published_key("2024-05-01T10:00:00.123455Z").expect("b");
        assert!(a > b);
        assert_eq!(published_key("2024-05-01T12:00:00+02:00"), published_key("2024-05-01T10:00:00Z"));
        assert_eq!(published_key("1970-01-01T00:00:00Z"), Some((0, 0)));
        for bad in ["", "2024-02-30T00:00:00Z", "2024-05-01", "2024-05-01T10:00:00", "2024-13-01T00:00:00Z", "2024-05-01T10:00:00+24:00"] {
            assert_eq!(published_key(bad), None, "{bad}");
        }
        assert!(published_key("2024-02-29T00:00:00Z").is_some());
    }

    #[test]
    fn jar_file_names() {
        assert!(check_jar_file_name("sodium-fabric-0.5.13+mc1.20.1.jar").is_ok());
        for bad in ["", ".jar", "../x.jar", "a/b.jar", "a\\b.jar", "CON.jar", "x.zip", "x.jar ", "x.jar.", ".hidden.jar", "a..b.jar"] {
            assert!(check_jar_file_name(bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn titles() {
        let items = vec![
            TitleItem::Disable("a.jar".into()),
            TitleItem::Replace("Sodium".into()),
            TitleItem::Disable("b.jar".into()),
        ];
        assert_eq!(title_of(&items), "Disable 2 mods, replace Sodium");
        assert_eq!(title_of(&[TitleItem::Manual(1)]), "1 manual step");
    }
}
