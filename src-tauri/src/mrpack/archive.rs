//! Safe, read-only access to a `.mrpack` zip: entry path checks, archive-wide limits and capped
//! reads. Nothing is ever extracted to disk.

use std::io::{Read, Seek};

use zip::ZipArchive;

use super::{
    display_name, issue, INDEX_NAME, MAX_ENTRIES, MAX_ENTRY_ISSUES, MAX_RATIO, MAX_TOTAL_UNCOMPRESSED, OVERRIDE_DIRS,
};
use crate::guard::PathGuard;
use crate::model::ScanIssue;

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

/// What the central directory says, after the safety checks.
#[derive(Debug, Default)]
pub struct Listing {
    /// Index of `modrinth.index.json` (a regular entry at the root).
    pub index: Option<usize>,
    /// Override jars: (entry index, path inside the zip), in archive order.
    pub jars: Vec<(usize, String)>,
    /// Unsafe and symlink entries skipped (capped), archive-limit problems.
    pub issues: Vec<ScanIssue>,
    /// True when an archive-wide limit was exceeded: nothing may be read from the pack.
    pub refused: bool,
}

/// Check the whole archive against the entry-count and total-size limits, then classify every
/// entry. Reads only the central directory.
pub fn list<R: Read + Seek>(zip: &ZipArchive<R>) -> Listing {
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
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index_data(i) else { continue };
        let raw = entry.name_raw();
        let name = match entry.name() {
            Ok(n) => n.into_owned(),
            Err(_) => String::from_utf8_lossy(raw).into_owned(),
        };
        // The decoded name may have lost a NUL; check the raw bytes too.
        let problem = if raw.contains(&0) { Some("its path contains a NUL character") } else { path_problem(&name) };
        if let Some(why) = problem {
            skip(&mut out, &name, why);
            continue;
        }
        if entry.is_symlink() {
            skip(&mut out, &name, "it is a symbolic link");
            continue;
        }
        if entry.is_dir() {
            continue;
        }
        if name == INDEX_NAME {
            out.index = Some(i);
        } else if OVERRIDE_DIRS.iter().any(|d| name.starts_with(d)) && is_jar_name(&name) {
            out.jars.push((i, name));
        }
    }
    if skipped > MAX_ENTRY_ISSUES {
        out.issues.push(issue("", format!("{} more unsafe pack entries were skipped.", skipped - MAX_ENTRY_ISSUES)));
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

/// Read one entry fully into memory after [`size_problem`] passed: never more than the size the
/// entry declares (an entry that inflates past it is refused), charged to `budget`.
pub fn read_entry<R: Read + Seek>(zip: &mut ZipArchive<R>, idx: usize, cap: u64, budget: &mut Budget) -> Result<Vec<u8>, String> {
    if let Some(why) = size_problem(zip, idx, cap, budget) {
        return Err(why);
    }
    let mut file = zip.by_index(idx).map_err(|e| format!("it could not be unpacked ({e})"))?;
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
