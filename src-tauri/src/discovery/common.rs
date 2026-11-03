//! Shared helpers: text decoding, INI parsing, directory probing, instance construction.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::model::{Instance, Launcher, LauncherProbe, LoaderInfo, LoaderKind, MetadataSource, ProbeResult, Side};

use super::env::Os;
use super::instance_id;

// ---------------------------------------------------------------------------------------------
// Text

/// Decode a launcher text file: BOM-sniffed (UTF-8/UTF-16), else UTF-8, else Windows-1252.
pub(crate) fn decode_text(bytes: &[u8]) -> String {
    if let Some((enc, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        return text.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(_) => encoding_rs::WINDOWS_1252.decode_without_bom_handling(bytes).0.into_owned(),
    }
}

pub(crate) fn read_text(path: &Path) -> io::Result<String> {
    fs::read(path).map(|b| decode_text(&b))
}

/// Read and parse a JSON file. `Ok(None)` when the file does not exist.
pub(crate) fn read_json(path: &Path) -> Result<Option<serde_json::Value>, String> {
    match read_text(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("{} is not valid JSON ({e})", file_label(path))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {} ({e})", file_label(path))),
    }
}

pub(crate) fn file_label(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| display(path))
}

/// Case-insensitive key lookup in a JSON object (exact case preferred).
pub(crate) fn json_get<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
    let obj = v.as_object()?;
    obj.get(key).or_else(|| obj.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v))
}

/// A non-empty string field (numbers are stringified).
pub(crate) fn json_str(v: &serde_json::Value, key: &str) -> Option<String> {
    match json_get(v, key)? {
        serde_json::Value::String(s) => non_empty(s),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

pub(crate) fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

// ---------------------------------------------------------------------------------------------
// INI (Qt/QSettings-flavoured: optional sections, quoted values, `\\` escaping)

#[derive(Debug, Default)]
pub(crate) struct Ini {
    entries: Vec<(String, String)>,
}

impl Ini {
    pub(crate) fn parse(text: &str) -> Ini {
        let mut entries = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with(';') || line.starts_with('[') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                entries.push((k.trim().to_string(), ini_value(v.trim())));
            }
        }
        Ini { entries }
    }

    pub(crate) fn read(path: &Path) -> io::Result<Ini> {
        read_text(path).map(|t| Ini::parse(&t))
    }

    /// First value for `key` (exact case preferred, then case-insensitive).
    pub(crate) fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .or_else(|| self.entries.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)))
            .map(|(_, v)| v.as_str())
    }

    pub(crate) fn get_non_empty(&self, key: &str) -> Option<String> {
        self.get(key).and_then(non_empty)
    }
}

fn ini_value(raw: &str) -> String {
    if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        return unescape(&raw[1..raw.len() - 1]);
    }
    // Launcher-written values double every backslash; a hand-edited path with single
    // backslashes (`C:\new folder`) must stay literal.
    if raw.contains("\\\\") {
        unescape(raw)
    } else {
        raw.to_string()
    }
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('\\') => out.push('\\'),
            Some('"') => out.push('"'),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('#') => out.push('#'),
            Some(';') => out.push(';'),
            Some('x') => {
                let mut hex = String::new();
                while hex.len() < 4 {
                    match chars.peek() {
                        Some(h) if h.is_ascii_hexdigit() => {
                            hex.push(*h);
                            chars.next();
                        }
                        _ => break,
                    }
                }
                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    Some(ch) if !hex.is_empty() => out.push(ch),
                    _ => {
                        out.push_str("\\x");
                        out.push_str(&hex);
                    }
                }
            }
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Loader strings

/// Map a launcher loader name (`vanilla|forge|fabric|quilt|neoforge`, any case) to `LoaderInfo`.
/// `None` means vanilla / no loader.
pub(crate) fn loader_from_name(name: &str, version: Option<String>) -> Option<LoaderInfo> {
    let n = name.trim().to_ascii_lowercase();
    let kind = match n.as_str() {
        "" | "vanilla" | "none" | "minecraft" => return None,
        "forge" | "minecraftforge" => LoaderKind::Forge,
        "neoforge" | "neoforged" => LoaderKind::Neoforge,
        "fabric" | "fabric-loader" | "fabricloader" => LoaderKind::Fabric,
        "quilt" | "quilt-loader" => LoaderKind::Quilt,
        _ => LoaderKind::Unknown,
    };
    Some(LoaderInfo { kind, version: version.and_then(|v| non_empty(&v)) })
}

/// Does `s` look like the start of a Minecraft version (`1.20.1`, `1.20.5-pre1`, `26.1`,
/// `26.4-snapshot-6`, `23w51a`)? Loader pre-release tags (`beta.1`, `rc.2`) do not.
fn looks_like_mc(s: &str) -> bool {
    let b = s.as_bytes();
    if !b.first().is_some_and(u8::is_ascii_digit) {
        return false;
    }
    let head = s.split('-').next().unwrap_or(s);
    let weekly = b.len() >= 6 && b[..2].iter().all(u8::is_ascii_digit) && b[2] == b'w' && b[3..5].iter().all(u8::is_ascii_digit);
    head.contains('.') || weekly
}

/// Split `<loader version>-<mc version>` (Fabric/Quilt ids) where both halves may contain
/// hyphens (`0.16.0-beta.1-1.20.5-pre1`). A known MC version (from other metadata) is matched
/// as a suffix first; otherwise the first `-` followed by something MC-shaped splits.
pub(crate) fn split_loader_mc(rest: &str, known_mc: Option<&str>) -> (String, Option<String>) {
    if let Some(mc) = known_mc.map(str::trim).filter(|m| !m.is_empty()) {
        if let Some(lv) = rest.strip_suffix(mc).and_then(|r| r.strip_suffix('-')).filter(|lv| !lv.is_empty()) {
            return (lv.to_string(), Some(mc.to_string()));
        }
    }
    for (i, _) in rest.match_indices('-') {
        let (lv, mc) = (&rest[..i], &rest[i + 1..]);
        if !lv.is_empty() && looks_like_mc(mc) {
            return (lv.to_string(), Some(mc.to_string()));
        }
    }
    (rest.to_string(), None)
}

// ---------------------------------------------------------------------------------------------
// Filesystem

pub(crate) fn display(p: &Path) -> String {
    dunce::simplified(p).display().to_string()
}

pub(crate) fn is_dir(p: &Path) -> bool {
    fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

pub(crate) fn is_file(p: &Path) -> bool {
    fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

pub(crate) fn canonical(p: &Path) -> Option<PathBuf> {
    dunce::canonicalize(p).ok()
}

/// Absolute, lexically normalised path (no filesystem access).
pub(crate) fn absolute(p: &Path) -> PathBuf {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    abs.components().collect()
}

/// Canonical path even when `p` does not exist yet: the nearest existing ancestor is
/// canonicalised (resolving junctions/symlinks such as OneDrive folders or macOS
/// `/var` → `/private/var`) and the missing components are appended. So the result does not
/// change once the folder is created.
pub(crate) fn resolve(p: &Path) -> PathBuf {
    if let Some(c) = canonical(p) {
        return c;
    }
    let abs = absolute(p);
    let mut missing = Vec::new();
    let mut cur = abs.as_path();
    while let Some(parent) = cur.parent() {
        match cur.file_name() {
            Some(name) => missing.push(name.to_os_string()),
            None => return abs, // `..` or a root: give up on resolving.
        }
        cur = parent;
        if let Some(mut out) = canonical(cur) {
            for name in missing.iter().rev() {
                out.push(name);
            }
            return out;
        }
    }
    abs
}

/// Key for de-duplicating locations: canonical if it exists, case-folded on
/// case-insensitive systems.
pub(crate) fn location_key(p: &Path, os: Os) -> String {
    let base = resolve(p);
    let s = base.to_string_lossy().into_owned();
    if os.case_insensitive() {
        s.to_lowercase()
    } else {
        s
    }
}

pub(crate) enum DirState {
    Missing,
    Dir,
    NotDir,
    Denied,
    Failed(String),
}

pub(crate) fn dir_state(p: &Path) -> DirState {
    match fs::metadata(p) {
        Ok(m) if m.is_dir() => DirState::Dir,
        Ok(_) => DirState::NotDir,
        Err(e) => match e.kind() {
            io::ErrorKind::NotFound => DirState::Missing,
            io::ErrorKind::PermissionDenied => DirState::Denied,
            _ => DirState::Failed(e.to_string()),
        },
    }
}

/// Sub-directories of `dir` (links followed), skipping dot-folders, sorted by name.
pub(crate) fn list_subdirs(dir: &Path) -> io::Result<Vec<(OsString, PathBuf)>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if is_dir(&path) {
            out.push((name, path));
        }
    }
    out.sort();
    Ok(out)
}

/// `*.jar` + `*.jar.disabled` (case-insensitive) directly in `<game_dir>/mods`.
pub(crate) fn mod_count(game_dir: &Path) -> u32 {
    let Ok(rd) = fs::read_dir(game_dir.join("mods")) else { return 0 };
    let mut n = 0u32;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if (name.ends_with(".jar") || name.ends_with(".jar.disabled")) && is_file(&entry.path()) {
            n = n.saturating_add(1);
        }
    }
    n
}

// ---------------------------------------------------------------------------------------------
// Results

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Meta {
    pub mc_version: Option<String>,
    pub loader: Option<LoaderInfo>,
    pub source: MetadataSource,
}

impl Meta {
    pub(crate) fn inferred() -> Meta {
        Meta { mc_version: None, loader: None, source: MetadataSource::Inferred }
    }

    pub(crate) fn launcher(mc_version: Option<String>, loader: Option<LoaderInfo>) -> Meta {
        Meta { mc_version, loader, source: MetadataSource::Launcher }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Found {
    pub instance: Instance,
    pub root: PathBuf,
    pub game_dir: PathBuf,
}

pub(crate) struct NewInstance<'a> {
    pub launcher: Launcher,
    pub name: String,
    pub root: &'a Path,
    pub game_dir: &'a Path,
    pub meta: Meta,
    pub side: Side,
}

pub(crate) fn build(os: Os, n: NewInstance<'_>) -> Found {
    let root = absolute(n.root);
    let game_dir = absolute(n.game_dir);
    let instance = Instance {
        id: instance_id(&game_dir, os),
        name: n.name,
        launcher: n.launcher,
        root: display(&root),
        game_dir: display(&game_dir),
        mc_version: n.meta.mc_version,
        loader: n.meta.loader,
        side: n.side,
        metadata_source: n.meta.source,
        mod_count: mod_count(&game_dir),
    };
    Found { instance, root, game_dir }
}

pub(crate) fn name_of(folder: &std::ffi::OsStr) -> String {
    folder.to_string_lossy().into_owned()
}

/// What one probed location produced.
#[derive(Debug, Clone)]
pub(crate) struct Outcome {
    pub probe: LauncherProbe,
    pub instances: Vec<Found>,
}

impl Outcome {
    pub(crate) fn new(launcher: Launcher, path: &Path, result: ProbeResult) -> Outcome {
        Outcome {
            probe: LauncherProbe { launcher, path: display(path), result, notes: Vec::new() },
            instances: Vec::new(),
        }
    }

    pub(crate) fn not_installed(launcher: Launcher, path: &Path) -> Outcome {
        Outcome::new(launcher, path, ProbeResult::NotInstalled)
    }

    /// Result for a location that is not a usable directory, or `None` if it is one.
    pub(crate) fn from_dir_state(launcher: Launcher, path: &Path) -> Option<Outcome> {
        match dir_state(path) {
            DirState::Dir => None,
            DirState::Missing => Some(Outcome::not_installed(launcher, path)),
            DirState::Denied => Some(Outcome::new(launcher, path, ProbeResult::PermissionDenied)),
            DirState::NotDir => Some(Outcome::new(
                launcher,
                path,
                ProbeResult::Error { message: "This path is a file, not a folder.".into() },
            )),
            DirState::Failed(m) => Some(Outcome::new(launcher, path, ProbeResult::Error { message: m })),
        }
    }

    pub(crate) fn from_io(launcher: Launcher, path: &Path, e: &io::Error) -> Outcome {
        let result = if e.kind() == io::ErrorKind::PermissionDenied {
            ProbeResult::PermissionDenied
        } else {
            ProbeResult::Error { message: format!("Could not list {}: {e}", display(path)) }
        };
        Outcome::new(launcher, path, result)
    }

    pub(crate) fn note(&mut self, note: impl Into<String>) {
        self.probe.notes.push(note.into());
    }

    /// Set `Found { count }` from the collected instances.
    pub(crate) fn finish(mut self) -> Outcome {
        let count = u32::try_from(self.instances.len()).unwrap_or(u32::MAX);
        self.probe.result = ProbeResult::Found { count };
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_bom_and_cp1252() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFname=x"), "name=x");
        assert_eq!(decode_text(b"name=Caf\xE9"), "name=Café");
        assert_eq!(decode_text("name=名前".as_bytes()), "name=名前");
        assert_eq!(decode_text(b"\xFF\xFEa\x00b\x00"), "ab");
    }

    #[test]
    fn ini_sections_quotes_and_escapes() {
        let ini = Ini::parse(
            "[General]\nInstanceDir=\"D:\\\\Games\\\\Inst\"\nname=My \\x540d Pack\n# c\nPlain=C:\\new folder\nEsc=C:\\\\Users\\\\xavier\n",
        );
        assert_eq!(ini.get("InstanceDir"), Some("D:\\Games\\Inst"));
        assert_eq!(ini.get("instancedir"), Some("D:\\Games\\Inst"));
        assert_eq!(ini.get("name"), Some("My \\x540d Pack"));
        assert_eq!(ini.get("Plain"), Some("C:\\new folder"));
        assert_eq!(ini.get("Esc"), Some("C:\\Users\\xavier"));
        assert_eq!(Ini::parse("n=\"\\x540d\"").get("n"), Some("名"));
        assert_eq!(ini.get("missing"), None);
    }

    #[test]
    fn loader_names() {
        assert_eq!(loader_from_name("vanilla", None), None);
        assert_eq!(loader_from_name("NeoForge", Some("21.1.1".into())).map(|l| l.kind), Some(LoaderKind::Neoforge));
        assert_eq!(loader_from_name("liteloader", None).map(|l| l.kind), Some(LoaderKind::Unknown));
        assert_eq!(loader_from_name("fabric", Some(" ".into())).and_then(|l| l.version), None);
    }
}
