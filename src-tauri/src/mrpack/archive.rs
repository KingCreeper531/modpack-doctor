//! Safe, read-only access to a `.mrpack` zip: central-directory limits checked before the zip
//! library parses anything, duplicate names, entry path checks, local/central header
//! consistency, archive-wide limits and capped reads. Nothing is ever extracted to disk.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

use zip::read::ZipReadOptions;
use zip::result::ZipError;
use zip::ZipArchive;

use super::{
    display_name, issue, INDEX_NAME, MAX_CD_BYTES, MAX_ENTRIES, MAX_ENTRY_ISSUES, MAX_RATIO, MAX_TOTAL_UNCOMPRESSED,
    OVERRIDE_DIRS,
};
use crate::guard::PathGuard;
use crate::model::ScanIssue;

const EOCD_SIG: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
const EOCD64_LOCATOR_SIG: [u8; 4] = [0x50, 0x4b, 0x06, 0x07];
const EOCD64_SIG: [u8; 4] = [0x50, 0x4b, 0x06, 0x06];
const EOCD_LEN: usize = 22;
const EOCD64_LOCATOR_LEN: usize = 20;
const EOCD64_LEN: usize = 56;
/// How far from the end an end-of-central-directory record is looked for: the record, a
/// maximal comment, and some slack (the zip library looks no further).
const EOCD_SEARCH: u64 = (EOCD_LEN as u64) + 65_535 + 1024;
/// Largest gap searched between where a ZIP64 locator says the ZIP64 record is and the locator
/// (the zip library searches the whole gap; a normal zip has the record right before it).
const MAX_EOCD64_GAP: u64 = 1024 * 1024;

fn u16_at(b: &[u8], at: usize) -> u64 {
    u64::from(u16::from_le_bytes([b[at], b[at + 1]]))
}

fn u32_at(b: &[u8], at: usize) -> u64 {
    u64::from(u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]))
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[at..at + 8]);
    u64::from_le_bytes(a)
}

/// The entry-count and size limits on what the central directory announces.
fn cd_limits(entries: u64, cd_size: u64) -> Result<(), String> {
    if entries > MAX_ENTRIES as u64 {
        return Err(format!(
            "The pack has {entries} entries, more than the {MAX_ENTRIES} Modpack Doctor reads, so it was not scanned (it may be a zip bomb)."
        ));
    }
    if cd_size > MAX_CD_BYTES {
        return Err(format!(
            "The pack's table of contents is {cd_size} bytes, more than the {MAX_CD_BYTES} Modpack Doctor reads, so it was not scanned (it may be a zip bomb)."
        ));
    }
    Ok(())
}

/// Read the end-of-central-directory records by hand (before `ZipArchive::new`, which would
/// allocate for whatever they announce) and refuse a pack whose central directory is too big.
///
/// Conservative on purpose: every EOCD signature in the tail the zip library searches is
/// checked, not just the one it would pick. For a record whose fields are the ZIP64 markers and
/// that has a ZIP64 locator right before it, every ZIP64 record signature between the offset the
/// locator names and the locator is checked instead (a gap over [`MAX_EOCD64_GAP`] is refused).
/// A file without any EOCD signature passes; the zip library then rejects it. Err is a readable
/// sentence.
pub fn check_central_directory<R: Read + Seek>(r: &mut R) -> Result<(), String> {
    let io = |e: std::io::Error| format!("The pack could not be read: {e}.");
    let len = r.seek(SeekFrom::End(0)).map_err(io)?;
    let start = len.saturating_sub(EOCD_SEARCH);
    r.seek(SeekFrom::Start(start)).map_err(io)?;
    let mut tail = Vec::new();
    r.by_ref().take(len - start).read_to_end(&mut tail).map_err(io)?;
    for pos in (0..tail.len().saturating_sub(EOCD_LEN - 1)).rev() {
        if tail[pos..pos + 4] != EOCD_SIG {
            continue;
        }
        let e = &tail[pos..pos + EOCD_LEN];
        let (on_disk, total, cd_size, cd_offset) = (u16_at(e, 8), u16_at(e, 10), u32_at(e, 12), u32_at(e, 16));
        let may_be_zip64 = on_disk == 0xFFFF || total == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF;
        let abs = start + pos as u64;
        if may_be_zip64 && abs >= EOCD64_LOCATOR_LEN as u64 {
            let locator_at = abs - EOCD64_LOCATOR_LEN as u64;
            let mut loc = [0u8; EOCD64_LOCATOR_LEN];
            r.seek(SeekFrom::Start(locator_at)).map_err(io)?;
            if r.read_exact(&mut loc).is_ok() && loc[..4] == EOCD64_LOCATOR_SIG {
                check_zip64_records(r, u64_at(&loc, 8), locator_at)?;
                continue;
            }
        }
        cd_limits(on_disk.max(total), cd_size)?;
    }
    r.seek(SeekFrom::Start(0)).map_err(io)?;
    Ok(())
}

/// Every ZIP64 end record signature in `[from, locator_at)` (where the zip library looks).
fn check_zip64_records<R: Read + Seek>(r: &mut R, from: u64, locator_at: u64) -> Result<(), String> {
    if from >= locator_at {
        return Ok(()); // The zip library rejects this layout itself.
    }
    let gap = locator_at - from;
    if gap > MAX_EOCD64_GAP {
        return Err(format!(
            "The pack's ZIP64 end record is said to be {gap} bytes before its locator, which a normal zip never is, so it was not scanned."
        ));
    }
    let io = |e: std::io::Error| format!("The pack could not be read: {e}.");
    r.seek(SeekFrom::Start(from)).map_err(io)?;
    let mut buf = Vec::new();
    r.by_ref().take(gap).read_to_end(&mut buf).map_err(io)?;
    for pos in 0..buf.len().saturating_sub(EOCD64_LEN - 1) {
        if buf[pos..pos + 4] == EOCD64_SIG {
            let z = &buf[pos..pos + EOCD64_LEN];
            cd_limits(u64_at(z, 24).max(u64_at(z, 32)), u64_at(z, 40))?;
        }
    }
    Ok(())
}

/// Why a path from the pack (zip entry name or index `files[].path`) is unsafe, or None.
///
/// Refused: empty paths, NUL, backslashes, absolute paths (`/…`), drive letters (`C:…`), `..`
/// components, and components that `PathGuard::join_relative` rejects (Windows reserved device
/// names such as `CON` or `nul.txt`, control characters, `<>:"|?*`, trailing dots or spaces).
/// One trailing `/` (a directory entry) is allowed.
pub fn path_problem(path: &str) -> Option<&'static str> {
    let p = path.strip_suffix('/').unwrap_or(path);
    if p.is_empty() {
        return Some("its path is empty");
    }
    if p.contains('\0') {
        return Some("its path contains a NUL character");
    }
    if p.contains('\\') {
        return Some("its path contains a backslash");
    }
    if p.starts_with('/') {
        return Some("it is an absolute path");
    }
    let b = p.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return Some("it starts with a drive letter");
    }
    if p.split('/').any(|c| c == "..") {
        return Some("its path contains \"..\"");
    }
    if PathGuard::join_relative(std::path::Path::new(""), p).is_err() {
        return Some("its path contains a name Windows reserves (such as CON or NUL) or a character not allowed in file names");
    }
    None
}

/// True for `*.jar` (ASCII case-insensitive).
fn is_jar_name(name: &str) -> bool {
    name.len() > 4 && name.as_bytes()[name.len() - 4..].eq_ignore_ascii_case(b".jar")
}

/// True when `rest` (a path inside an override folder) is a file directly in `mods/`, with `mods`
/// in any letter case: on Windows `MODS/` and `mods/` are one folder, so a loader loads it.
pub fn directly_in_mods(rest: &str) -> bool {
    rest.len() > 5 && rest.as_bytes()[..5].eq_ignore_ascii_case(b"mods/") && !rest[5..].contains('/')
}

/// What the central directory says, after the safety checks.
#[derive(Debug, Default)]
pub struct Listing {
    /// Index of `modrinth.index.json` (a regular entry at the root).
    pub index: Option<usize>,
    /// Override jars directly in an override `mods/` folder: (entry index, path inside the zip),
    /// in archive order.
    pub jars: Vec<(usize, String)>,
    /// Unsafe, symlink and header-inconsistent entries skipped, jars outside `mods/` (each
    /// capped), archive-limit problems.
    pub issues: Vec<ScanIssue>,
    /// True when an archive-wide limit was exceeded or names are duplicated: nothing may be read
    /// from the pack.
    pub refused: bool,
}

/// Why the pack must be refused for duplicate entry names, or None. Exact duplicates (which
/// the zip library collapses into one, so it is unknowable which copy another tool uses), and
/// names that differ only in letter case (one file on Windows), unless both are folders.
fn duplicate_problem<R: Read + Seek>(zip: &ZipArchive<R>) -> Option<String> {
    const TAIL: &str = "tools disagree about which copy counts, so it was not scanned";
    if zip.has_duplicate_names() {
        return Some(format!("The pack lists the same entry name more than once; {TAIL}."));
    }
    let mut seen: HashMap<String, (String, bool)> = HashMap::new();
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index_data(i) else { continue };
        let name = entry.name().map(|n| n.into_owned()).unwrap_or_else(|_| String::from_utf8_lossy(entry.name_raw()).into_owned());
        let is_dir = entry.is_dir();
        let key = name.trim_end_matches('/').to_lowercase();
        if let Some((prev, prev_dir)) = seen.get(&key) {
            if !(is_dir && *prev_dir) {
                return Some(format!(
                    "The pack has entries named \"{}\" and \"{}\", which are the same file on Windows; {TAIL}.",
                    display_name(prev),
                    display_name(&name)
                ));
            }
            continue;
        }
        seen.insert(key, (name, is_dir));
    }
    None
}

/// Whether entry `idx`'s local header disagrees with its central-directory record (name,
/// compression, flags, sizes, CRC, …): Some(reason) for a mismatch. An entry the zip library
/// cannot open for other reasons (unsupported compression, …) is not judged here.
///
/// The zip crate has no typed error for this (it is an `InvalidArchive` with a message), so it is
/// detected by behaviour, not by the message text: the entry fails to open with the consistency
/// check and opens without it.
fn header_mismatch<R: Read + Seek>(zip: &mut ZipArchive<R>, idx: usize) -> Option<&'static str> {
    let strict = zip.by_index_with_options(idx, ZipReadOptions::new().enforce_header_consistency(true)).map(drop);
    match strict {
        Err(ZipError::InvalidArchive(_)) if zip.by_index_with_options(idx, ZipReadOptions::new()).is_ok() => Some(HEADER_MISMATCH),
        _ => None,
    }
}

const HEADER_MISMATCH: &str =
    "its local header does not match the archive's table of contents (a tool reading one or the other would see a different file)";

/// Check the whole archive against the entry-count and total-size limits and for duplicate
/// names, then classify every entry (path checks, symlinks, local/central header consistency).
/// Reads the central directory and every local header; never entry data.
pub fn list<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Listing {
    let mut out = Listing::default();
    if zip.len() > MAX_ENTRIES {
        out.issues.push(issue(
            "",
            format!(
                "The pack has {} entries, more than the {MAX_ENTRIES} Modpack Doctor reads, so it was not scanned (it may be a zip bomb).",
                zip.len()
            ),
        ));
        out.refused = true;
        return out;
    }
    if let Some(why) = duplicate_problem(zip) {
        out.issues.push(issue("", why));
        out.refused = true;
        return out;
    }
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        if let Ok(e) = zip.by_index_data(i) {
            total = total.saturating_add(e.size());
        }
    }
    if total > MAX_TOTAL_UNCOMPRESSED {
        out.issues.push(issue(
            "",
            format!(
                "The pack would unpack to {} MiB, more than the {} MiB limit, so it was not scanned (it may be a zip bomb).",
                total / super::MIB,
                MAX_TOTAL_UNCOMPRESSED / super::MIB
            ),
        ));
        out.refused = true;
        return out;
    }

    let mut skipped = 0usize;
    let mut skip = |out: &mut Listing, name: &str, why: &str| {
        skipped += 1;
        if skipped <= MAX_ENTRY_ISSUES {
            out.issues.push(issue(&display_name(name), format!("Skipped this pack entry: {why}.")));
        }
    };
    let mut ignored = 0usize;
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index_data(i) else { continue };
        let raw = entry.name_raw();
        let name = match entry.name() {
            Ok(n) => n.into_owned(),
            Err(_) => String::from_utf8_lossy(raw).into_owned(),
        };
        // The decoded name may have lost a NUL; check the raw bytes too.
        let problem = if raw.contains(&0) { Some("its path contains a NUL character") } else { path_problem(&name) };
        let (is_symlink, is_dir) = (entry.is_symlink(), entry.is_dir());
        if let Some(why) = problem {
            skip(&mut out, &name, why);
            continue;
        }
        if is_symlink {
            skip(&mut out, &name, "it is a symbolic link");
            continue;
        }
        if let Some(why) = header_mismatch(zip, i) {
            skip(&mut out, &name, why);
            continue;
        }
        if is_dir {
            continue;
        }
        if name == INDEX_NAME {
            out.index = Some(i);
        } else if OVERRIDE_DIRS.iter().any(|d| name.starts_with(d)) && is_jar_name(&name) {
            let in_mods = OVERRIDE_DIRS.iter().any(|d| name.strip_prefix(d).is_some_and(directly_in_mods));
            if in_mods {
                out.jars.push((i, name));
            } else {
                ignored += 1;
                if ignored <= MAX_ENTRY_ISSUES {
                    out.issues.push(issue(
                        &display_name(&name),
                        "This jar is not directly in the mods/ folder of the pack's overrides, where mod loaders look for mods, so it was not scanned.".to_string(),
                    ));
                }
            }
        }
    }
    if skipped > MAX_ENTRY_ISSUES {
        out.issues.push(issue("", format!("{} more unsafe pack entries were skipped.", skipped - MAX_ENTRY_ISSUES)));
    }
    if ignored > MAX_ENTRY_ISSUES {
        out.issues.push(issue(
            "",
            format!("{} more jars outside the override mods/ folders were not scanned.", ignored - MAX_ENTRY_ISSUES),
        ));
    }
    out
}

/// Remaining inflation allowance for one scan of a pack (all entries read share it).
#[derive(Debug)]
pub struct Budget {
    pub left: u64,
}

impl Budget {
    pub fn new() -> Self {
        Budget { left: MAX_TOTAL_UNCOMPRESSED }
    }
}

impl Default for Budget {
    fn default() -> Self {
        Self::new()
    }
}

/// Why an entry must not be read, judged from the central directory alone: larger than `cap`,
/// compression ratio above [`MAX_RATIO`], or more than the budget left.
pub fn size_problem<R: Read + Seek>(zip: &ZipArchive<R>, idx: usize, cap: u64, budget: &Budget) -> Option<String> {
    let entry = match zip.by_index_data(idx) {
        Ok(e) => e,
        Err(e) => return Some(format!("it could not be read ({e})")),
    };
    let (size, packed) = (entry.size(), entry.compressed_size());
    if size > cap {
        return Some(format!("it unpacks to {} bytes, more than the {} MiB limit", size, cap / super::MIB));
    }
    if size > packed.saturating_mul(MAX_RATIO) {
        return Some(format!(
            "its compression ratio is above {MAX_RATIO}:1 ({size} bytes from {packed}), so it may be a zip bomb"
        ));
    }
    if size > budget.left {
        return Some("the pack's total unpacked-size limit was reached".into());
    }
    None
}

/// Read one entry fully into memory after [`size_problem`] passed, with its local header checked
/// against the central directory again (also for callers that did not go through [`list`]):
/// never more than the size the entry declares (an entry that inflates past it is refused),
/// charged to `budget`.
pub fn read_entry<R: Read + Seek>(zip: &mut ZipArchive<R>, idx: usize, cap: u64, budget: &mut Budget) -> Result<Vec<u8>, String> {
    if let Some(why) = size_problem(zip, idx, cap, budget) {
        return Err(why);
    }
    if let Some(why) = header_mismatch(zip, idx) {
        return Err(why.to_string());
    }
    let opts = ZipReadOptions::new().enforce_header_consistency(true);
    let mut file = zip.by_index_with_options(idx, opts).map_err(|e| format!("it could not be unpacked ({e})"))?;
    let declared = file.size();
    let mut buf = Vec::with_capacity(usize::try_from(declared.min(super::MIB)).unwrap_or(0));
    (&mut file)
        .take(declared.saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|e| format!("it could not be unpacked ({e})"))?;
    let got = buf.len() as u64;
    budget.left = budget.left.saturating_sub(got);
    if got > declared {
        return Err("it unpacks to more data than it declares, so it may be a zip bomb".into());
    }
    if got < declared {
        return Err(format!("it is truncated ({got} of {declared} bytes)"));
    }
    Ok(buf)
}
