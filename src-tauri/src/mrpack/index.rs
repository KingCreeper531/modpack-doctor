//! `modrinth.index.json` (formatVersion 1, docs/research/modrinth-api.md §8) → pack metadata and
//! `DeclaredFile`s. Every problem becomes a `ScanIssue`; nothing here can fail or panic.

use serde_json::{Map, Value};

use super::archive::path_problem;
use super::{display_name, issue, INDEX_NAME, MAX_INDEX_FILES};
use crate::model::{DeclaredFile, LoaderInfo, LoaderKind, ScanIssue};

/// Longest pack name kept (characters).
const MAX_NAME_CHARS: usize = 128;
/// Download URLs kept per declared file.
const MAX_DOWNLOADS: usize = 16;
/// Longest download URL kept (bytes); longer ones are dropped.
const MAX_URL_BYTES: usize = 4096;
/// Problems reported per index (one per bad `files[]` entry, up to this many).
const MAX_FILE_ISSUES: usize = 100;

/// What the index says about the pack.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PackIndex {
    pub name: Option<String>,
    pub mc_version: Option<String>,
    pub loader: Option<LoaderInfo>,
    pub files: Vec<DeclaredFile>,
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
    if files.len() > MAX_INDEX_FILES {
        issues.push(index_issue(format!(
            "The pack's {INDEX_NAME} lists {} files, more than the {MAX_INDEX_FILES} Modpack Doctor reads, so its files were not checked.",
            files.len()
        )));
        return Some(out);
    }
    let mut bad = 0usize;
    for (i, f) in files.iter().enumerate() {
        match declared_file(f) {
            Ok(d) => out.files.push(d),
            Err(why) => {
                bad += 1;
                if bad <= MAX_FILE_ISSUES {
                    issues.push(index_issue(format!("Skipped files[{i}] of the pack's {INDEX_NAME}: {why}.")));
                }
            }
        }
    }
    if bad > MAX_FILE_ISSUES {
        issues.push(index_issue(format!("{} more files of the pack's {INDEX_NAME} were skipped.", bad - MAX_FILE_ISSUES)));
    }
    Some(out)
}

fn index_issue(message: String) -> ScanIssue {
    issue(INDEX_NAME, message)
}

/// One `files[]` entry, or why it was skipped.
fn declared_file(v: &Value) -> Result<DeclaredFile, String> {
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
    let downloads = obj
        .get("downloads")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|u| u.len() <= MAX_URL_BYTES)
                .take(MAX_DOWNLOADS)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Ok(DeclaredFile {
        path: path.to_string(),
        sha1,
        sha512,
        size: obj.get("fileSize").and_then(Value::as_u64).unwrap_or(0),
        client: side("client"),
        server: side("server"),
        downloads,
    })
}

/// A lowercase hex hash of exactly `len` digits.
fn hash(hashes: Option<&Map<String, Value>>, key: &str, len: usize) -> Option<String> {
    let h = hashes?.get(key)?.as_str()?.trim();
    (h.len() == len && h.bytes().all(|b| b.is_ascii_hexdigit())).then(|| h.to_ascii_lowercase())
}

/// Pack name for display: control characters removed, trimmed, at most 128 characters.
fn clean_name(s: &str) -> Option<String> {
    let cleaned: String = s.chars().filter(|c| !c.is_control()).take(MAX_NAME_CHARS).collect();
    let t = cleaned.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Version strings: trimmed, non-empty, at most 64 characters, no control characters.
fn clean_version(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty() && t.len() <= 64 && !t.chars().any(char::is_control)).then(|| t.to_string())
}

fn short_json(v: &Value) -> String {
    let s = v.to_string();
    if s.chars().count() > 40 {
        format!("{}…", s.chars().take(40).collect::<String>())
    } else {
        s
    }
}
