//! `modrinth.index.json` (formatVersion 1, docs/research/modrinth-api.md §8) → pack metadata and
//! `DeclaredFile`s. Every problem becomes a `ScanIssue`; nothing here can fail or panic.

use std::collections::HashMap;

use serde_json::{Map, Value};

use super::archive::path_problem;
use super::{display_name, is_hidden_char, issue, strip_hidden, INDEX_NAME, MAX_INDEX_FILES};
use crate::model::{DeclaredFile, LoaderInfo, LoaderKind, ScanIssue, UnverifiedDownload};

/// Longest pack name kept (characters).
const MAX_NAME_CHARS: usize = 128;
/// Most download URLs kept per declared file, the [`MORE_URLS`] sentinel included.
pub const MAX_DOWNLOADS: usize = 64;
/// Longest download URL kept (bytes); a longer one is replaced by [`TOO_LONG`].
pub const MAX_URL_BYTES: usize = 4096;
/// Longest `UnverifiedDownload.entry` kept (characters).
const MAX_ENTRY_CHARS: usize = 256;
/// Problems reported per index (one per bad `files[]` entry, up to this many; the same again for
/// download-link and duplicate-path notes).
const MAX_FILE_ISSUES: usize = 100;

// Download-link sentinels. A `downloads` value is never dropped silently: whatever cannot be kept
// verbatim is replaced by one of these strings (with a `ScanIssue`). None of them is an absolute
// URL (no `://`), so `src/core`'s `classifyDownloadUrl` puts each outside the allowlist and the
// file gets W-MRPACK-DOWNLOAD.
/// Replaces a URL longer than [`MAX_URL_BYTES`].
pub const TOO_LONG: &str = "invalid:too-long";
/// Replaces a `downloads` entry that is not a string.
pub const NOT_A_STRING: &str = "invalid:not-a-string";
/// The last kept entry when a file lists more than [`MAX_DOWNLOADS`] links.
pub const MORE_URLS: &str = "invalid:more-urls";
/// The only entry when `downloads` is present but not a list.
pub const NOT_A_LIST: &str = "invalid:not-a-list";

/// What the index says about the pack.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PackIndex {
    pub name: Option<String>,
    pub mc_version: Option<String>,
    pub loader: Option<LoaderInfo>,
    pub files: Vec<DeclaredFile>,
    /// Download links of `files[]` entries not in `files`: skipped (not an object, no path, unsafe
    /// or folder path, bad hashes, or the whole list over [`MAX_INDEX_FILES`]) or shadowed by a
    /// later entry with the same path. In index order.
    pub unverified: Vec<UnverifiedDownload>,
}

/// Loader dependency keys, in the order used when a pack (wrongly) names several.
const LOADER_KEYS: [(&str, LoaderKind); 4] = [
    ("neoforge", LoaderKind::Neoforge),
    ("forge", LoaderKind::Forge),
    ("quilt-loader", LoaderKind::Quilt),
    ("fabric-loader", LoaderKind::Fabric),
];

/// Parse the index. None when it is unusable (bad JSON, not an object, wrong `formatVersion` or
/// `game`); every problem is appended to `issues`. Bad `files[]` entries are skipped one by one.
pub fn parse(bytes: &[u8], issues: &mut Vec<ScanIssue>) -> Option<PackIndex> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let root: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => {
            issues.push(index_issue(format!("The pack's {INDEX_NAME} is not valid JSON ({e}), so its files could not be listed.")));
            return None;
        }
    };
    let Some(obj) = root.as_object() else {
        issues.push(index_issue(format!("The pack's {INDEX_NAME} is not a JSON object, so its files could not be listed.")));
        return None;
    };
    match obj.get("formatVersion") {
        Some(v) if v.as_u64() == Some(1) => {}
        other => {
            let shown = other.map_or_else(|| "none".to_string(), short_json);
            issues.push(index_issue(format!(
                "The pack's {INDEX_NAME} has formatVersion {shown}; only formatVersion 1 is supported, so its files could not be listed."
            )));
            return None;
        }
    }
    match obj.get("game").and_then(Value::as_str) {
        Some("minecraft") => {}
        other => {
            let shown = other.map_or_else(|| "no game".to_string(), |g| format!("the game \"{}\"", display_name(g)));
            issues.push(index_issue(format!(
                "The pack's {INDEX_NAME} is for {shown}, not Minecraft, so its files could not be listed."
            )));
            return None;
        }
    }

    let mut out = PackIndex { name: obj.get("name").and_then(Value::as_str).and_then(clean_name), ..PackIndex::default() };
    if let Some(deps) = obj.get("dependencies").and_then(Value::as_object) {
        out.mc_version = deps.get("minecraft").and_then(Value::as_str).and_then(clean_version);
        out.loader = LOADER_KEYS.iter().find_map(|(key, kind)| {
            deps.get(*key).map(|v| LoaderInfo { kind: *kind, version: v.as_str().and_then(clean_version) })
        });
    } else {
        issues.push(index_issue(format!("The pack's {INDEX_NAME} has no dependencies, so its Minecraft version and loader are unknown.")));
    }

    let Some(files) = obj.get("files").and_then(Value::as_array) else {
        issues.push(index_issue(format!("The pack's {INDEX_NAME} has no files list.")));
        return Some(out);
    };
    let mut notes = Notes::default();
    let mut unverified: Vec<(usize, UnverifiedDownload)> = Vec::new();
    if files.len() > MAX_INDEX_FILES {
        issues.push(index_issue(format!(
            "The pack's {INDEX_NAME} lists {} files, more than the {MAX_INDEX_FILES} Modpack Doctor reads, so its files were not checked (only their download links).",
            files.len()
        )));
        for (i, f) in files.iter().enumerate() {
            unverified.extend(skipped_downloads(i, f, issues, &mut notes).into_iter().map(|u| (i, u)));
        }
        out.unverified = unverified.into_iter().map(|(_, u)| u).collect();
        notes.finish(issues);
        return Some(out);
    }
    let mut bad = 0usize;
    let mut kept: Vec<(usize, DeclaredFile)> = Vec::new();
    for (i, f) in files.iter().enumerate() {
        match declared_file(f) {
            Ok((d, file_notes)) => {
                for n in file_notes {
                    notes.push(issues, format!("files[{i}] of the pack's {INDEX_NAME}: {n}."));
                }
                kept.push((i, d));
            }
            Err(why) => {
                bad += 1;
                if bad <= MAX_FILE_ISSUES {
                    issues.push(index_issue(format!("Skipped files[{i}] of the pack's {INDEX_NAME}: {why}.")));
                }
                unverified.extend(skipped_downloads(i, f, issues, &mut notes).into_iter().map(|u| (i, u)));
            }
        }
    }
    if bad > MAX_FILE_ISSUES {
        issues.push(index_issue(format!("{} more files of the pack's {INDEX_NAME} were skipped.", bad - MAX_FILE_ISSUES)));
    }
    out.files = dedupe(kept, issues, &mut notes, &mut unverified);
    notes.finish(issues);
    // Stable: the links of one entry stay in their order.
    unverified.sort_by_key(|(i, _)| *i);
    out.unverified = unverified.into_iter().map(|(_, u)| u).collect();
    Some(out)
}

/// `UnverifiedDownload.entry` for a path as written: control and format characters removed, at
/// most [`MAX_ENTRY_CHARS`] characters; None when nothing is left.
fn entry_label(path: &str) -> Option<String> {
    let label: String = strip_hidden(path).chars().take(MAX_ENTRY_CHARS).collect();
    (!label.is_empty()).then_some(label)
}

/// The download links of `files[i]`, which was skipped, as [`UnverifiedDownload`]s (same
/// sentinel rules as declared files, notes included). Nothing for a value that is not an object.
fn skipped_downloads(i: usize, v: &Value, issues: &mut Vec<ScanIssue>, notes: &mut Notes) -> Vec<UnverifiedDownload> {
    let Some(obj) = v.as_object() else { return Vec::new() };
    let entry = obj.get("path").and_then(Value::as_str).and_then(entry_label).unwrap_or_else(|| format!("files[{i}]"));
    let (urls, file_notes) = downloads(obj.get("downloads"), &display_name(&entry));
    for n in file_notes {
        notes.push(issues, format!("files[{i}] of the pack's {INDEX_NAME} (skipped): {n}."));
    }
    urls.into_iter().map(|url| UnverifiedDownload { entry: entry.clone(), url }).collect()
}

fn index_issue(message: String) -> ScanIssue {
    issue(INDEX_NAME, message)
}

/// Download-link and duplicate-path notes, capped at [`MAX_FILE_ISSUES`] (the rest summed up).
#[derive(Default)]
struct Notes {
    count: usize,
}

impl Notes {
    fn push(&mut self, issues: &mut Vec<ScanIssue>, message: String) {
        self.count += 1;
        if self.count <= MAX_FILE_ISSUES {
            issues.push(index_issue(message));
        }
    }

    fn finish(self, issues: &mut Vec<ScanIssue>) {
        if self.count > MAX_FILE_ISSUES {
            issues.push(index_issue(format!(
                "{} more problems with download links or duplicate paths in the pack's {INDEX_NAME} were found.",
                self.count - MAX_FILE_ISSUES
            )));
        }
    }
}

/// Files listed more than once under the same `path`: installers write them in order, so the
/// last one is what ends up on disk. Only it is kept; each earlier one is a note, and its download
/// links go to `unverified` (a launcher still fetches it before overwriting it). Paths that differ
/// only in letter case are both kept, with a note (on Windows they are the same file).
fn dedupe(
    kept: Vec<(usize, DeclaredFile)>,
    issues: &mut Vec<ScanIssue>,
    notes: &mut Notes,
    unverified: &mut Vec<(usize, UnverifiedDownload)>,
) -> Vec<DeclaredFile> {
    let mut last: HashMap<String, usize> = HashMap::new();
    for (i, d) in &kept {
        last.insert(d.path.clone(), *i);
    }
    let mut files = Vec::with_capacity(last.len());
    for (i, d) in kept {
        let winner = last[&d.path];
        if winner == i {
            files.push(d);
        } else {
            notes.push(
                issues,
                format!(
                    "files[{i}] and files[{winner}] of the pack's {INDEX_NAME} both install \"{}\"; installers keep the last one, so only files[{winner}] was checked.",
                    display_name(&d.path)
                ),
            );
            let entry = entry_label(&d.path).unwrap_or_else(|| format!("files[{i}]"));
            unverified.extend(d.downloads.into_iter().map(|url| (i, UnverifiedDownload { entry: entry.clone(), url })));
        }
    }
    let mut by_folded: HashMap<String, usize> = HashMap::new();
    for (n, d) in files.iter().enumerate() {
        if let Some(prev) = by_folded.insert(d.path.to_lowercase(), n) {
            notes.push(
                issues,
                format!(
                    "The pack's {INDEX_NAME} lists \"{}\" and \"{}\", which differ only in letter case; on Windows the later one replaces the earlier.",
                    display_name(&files[prev].path),
                    display_name(&d.path)
                ),
            );
        }
    }
    files
}

/// One `files[]` entry plus notes about its download links, or why it was skipped.
pub(crate) fn declared_file(v: &Value) -> Result<(DeclaredFile, Vec<String>), String> {
    let obj = v.as_object().ok_or("it is not a JSON object")?;
    let path = obj.get("path").and_then(Value::as_str).ok_or("it has no path")?;
    if let Some(why) = path_problem(path) {
        return Err(format!("\"{}\" is unsafe: {why}", display_name(path)));
    }
    if path.ends_with('/') {
        return Err(format!("\"{}\" is a folder, not a file", display_name(path)));
    }
    let shown = display_name(path);
    let hashes = obj.get("hashes").and_then(Value::as_object);
    let sha1 = hash(hashes, "sha1", 40).ok_or_else(|| format!("\"{shown}\" has no valid sha1 hash"))?;
    let sha512 = hash(hashes, "sha512", 128).ok_or_else(|| format!("\"{shown}\" has no valid sha512 hash"))?;
    let env = obj.get("env").and_then(Value::as_object);
    let side = |key: &str| env.and_then(|e| e.get(key)).and_then(Value::as_str).map(display_name);
    let (downloads, notes) = downloads(obj.get("downloads"), &shown);
    let file = DeclaredFile {
        path: path.to_string(),
        sha1,
        sha512,
        size: obj.get("fileSize").and_then(Value::as_u64).unwrap_or(0),
        client: side("client"),
        server: side("server"),
        downloads,
    };
    Ok((file, notes))
}

/// The `downloads` of the file shown as `shown`, as kept: every string up to [`MAX_URL_BYTES`]
/// verbatim and in order; anything else becomes a sentinel (never dropped silently), with notes.
/// Absent or `null` is an empty list.
pub fn downloads(v: Option<&Value>, shown: &str) -> (Vec<String>, Vec<String>) {
    let mut notes = Vec::new();
    let list = match v {
        None | Some(Value::Null) => return (Vec::new(), notes),
        Some(Value::Array(a)) => a,
        Some(_) => {
            notes.push(format!("the download links of \"{shown}\" are not a list, so where it comes from is unknown"));
            return (vec![NOT_A_LIST.to_string()], notes);
        }
    };
    let mut out = Vec::with_capacity(list.len().min(MAX_DOWNLOADS));
    let (mut long, mut odd) = (0usize, 0usize);
    for (n, u) in list.iter().enumerate() {
        if n + 1 == MAX_DOWNLOADS && list.len() > MAX_DOWNLOADS {
            out.push(MORE_URLS.to_string());
            notes.push(format!(
                "\"{shown}\" lists {} download links; only the first {} were checked",
                list.len(),
                MAX_DOWNLOADS - 1
            ));
            break;
        }
        match u.as_str() {
            Some(s) if s.len() <= MAX_URL_BYTES => out.push(s.to_string()),
            Some(_) => {
                long += 1;
                out.push(TOO_LONG.to_string());
            }
            None => {
                odd += 1;
                out.push(NOT_A_STRING.to_string());
            }
        }
    }
    if long > 0 {
        notes.push(format!("{long} download link(s) of \"{shown}\" are longer than {MAX_URL_BYTES} bytes and were not checked"));
    }
    if odd > 0 {
        notes.push(format!("{odd} download link(s) of \"{shown}\" are not text"));
    }
    (out, notes)
}

/// A lowercase hex hash of exactly `len` digits.
fn hash(hashes: Option<&Map<String, Value>>, key: &str, len: usize) -> Option<String> {
    let h = hashes?.get(key)?.as_str()?.trim();
    (h.len() == len && h.bytes().all(|b| b.is_ascii_hexdigit())).then(|| h.to_ascii_lowercase())
}

/// Pack name for display: control and invisible format characters (bidi controls, zero-width
/// characters, BOM, …) removed, trimmed, at most 128 characters.
pub(crate) fn clean_name(s: &str) -> Option<String> {
    let cleaned: String = strip_hidden(s).chars().take(MAX_NAME_CHARS).collect();
    let t = cleaned.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Version strings: trimmed, non-empty, at most 64 characters, no control or format characters.
fn clean_version(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty() && t.len() <= 64 && !t.chars().any(is_hidden_char)).then(|| t.to_string())
}

fn short_json(v: &Value) -> String {
    let s = v.to_string();
    if s.chars().count() > 40 {
        format!("{}…", s.chars().take(40).collect::<String>())
    } else {
        s
    }
}
