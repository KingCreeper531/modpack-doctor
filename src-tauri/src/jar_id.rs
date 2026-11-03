//! Jar id ↔ path mapping (CONTRACTS.md invariant 5). FROZEN (M1). The scanner builds ids with
//! `top_level_ids`; the fix engine resolves them with `resolve`. Both sides use only this
//! module, so a mod keeps its id when it is disabled or re-enabled.

use std::collections::HashSet;
use std::path::Path;

pub const DISABLED_SUFFIX: &str = ".disabled";
pub const DISABLED_MARKER: &str = "#disabled";

/// `\` → `/`.
pub fn normalize(rel: &str) -> String {
    rel.replace('\\', "/")
}

/// `path` without a `.disabled` suffix, matched ASCII case-insensitively (launchers treat
/// `X.JAR.DISABLED` as disabled too). None when there is no such suffix.
pub fn strip_disabled(path: &str) -> Option<&str> {
    let cut = path.len().checked_sub(DISABLED_SUFFIX.len())?;
    let (base, suffix) = (path.get(..cut)?, path.get(cut..)?);
    suffix.eq_ignore_ascii_case(DISABLED_SUFFIX).then_some(base)
}

/// Ids for a set of top-level jar paths (relative to the scan root, any separator).
/// Returns `(id, normalized path)` in input order.
pub fn top_level_ids(paths: &[String]) -> Vec<(String, String)> {
    top_level_ids_with(paths, CASE_INSENSITIVE_FS)
}

/// Windows and macOS (APFS/HFS+ default) resolve file names case-insensitively, so `X.jar` and
/// `x.jar.disabled` are twins there and the disabled one must get the `#disabled` marker.
pub const CASE_INSENSITIVE_FS: bool = cfg!(any(windows, target_os = "macos"));

fn top_level_ids_with(paths: &[String], case_insensitive: bool) -> Vec<(String, String)> {
    let fold = |s: &str| if case_insensitive { s.to_lowercase() } else { s.to_string() };
    let normalized: Vec<String> = paths.iter().map(|p| normalize(p)).collect();
    let enabled: HashSet<String> = normalized
        .iter()
        .filter(|p| strip_disabled(p).is_none())
        .map(|p| fold(p))
        .collect();
    normalized
        .iter()
        .map(|path| {
            let id = match strip_disabled(path) {
                Some(base) if enabled.contains(&fold(base)) => format!("{base}{DISABLED_MARKER}"),
                Some(base) => base.to_string(),
                None => path.clone(),
            };
            (id, path.clone())
        })
        .collect()
}

/// Nested jar id: `<parentId>!/<entry path>`.
pub fn nested_id(parent_id: &str, entry: &str) -> String {
    format!("{parent_id}!/{}", normalize(entry))
}

/// Resolve a top-level id to the file currently on disk under `root`, as a relative
/// `/`-separated path. `#disabled` → `<base>.disabled`; otherwise `<base>` if it exists, else
/// `<base>.disabled`. None when neither exists, the id is nested, or it fails
/// `PathGuard::join_relative` validation (ids come from the UI). Callers still run
/// `PathGuard::check_existing` on the result before touching the file.
pub fn resolve(root: &Path, id: &str) -> Option<String> {
    if id.contains("!/") {
        return None;
    }
    let exists = |rel: &str| {
        crate::guard::PathGuard::join_relative(root, rel)
            .map(|p| p.is_file())
            .unwrap_or(false)
    };
    if let Some(base) = id.strip_suffix(DISABLED_MARKER) {
        return disabled_twin(root, base);
    }
    if exists(id) {
        return Some(id.to_string());
    }
    disabled_twin(root, id)
}

/// `<base>.disabled` as it exists on disk, with its `.disabled` suffix in any letter case.
fn disabled_twin(root: &Path, base: &str) -> Option<String> {
    let canonical = format!("{base}{DISABLED_SUFFIX}");
    let dir = crate::guard::PathGuard::join_relative(root, &canonical).ok()?;
    if dir.is_file() {
        return Some(canonical);
    }
    let (parent_rel, base_name) = match base.rsplit_once('/') {
        Some((p, n)) => (Some(p), n),
        None => (None, base),
    };
    let parent = dir.parent()?;
    std::fs::read_dir(parent).ok()?.flatten().find_map(|entry| {
        let name = entry.file_name().into_string().ok()?;
        let matches = strip_disabled(&name) == Some(base_name) && entry.path().is_file();
        matches.then(|| match parent_rel {
            Some(p) => format!("{p}/{name}"),
            None => name,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(paths: &[&str]) -> Vec<String> {
        let owned: Vec<String> = paths.iter().map(|s| s.to_string()).collect();
        top_level_ids(&owned).into_iter().map(|(id, _)| id).collect()
    }

    #[test]
    fn disabled_keeps_base_id() {
        assert_eq!(ids(&["mods/a.jar", "mods/b.jar.disabled"]), vec!["mods/a.jar", "mods/b.jar"]);
    }

    #[test]
    fn collision_marks_disabled_twin() {
        assert_eq!(ids(&["mods/x.jar.disabled", "mods/x.jar"]), vec!["mods/x.jar#disabled", "mods/x.jar"]);
    }

    #[test]
    fn disabled_suffix_is_case_insensitive() {
        assert_eq!(ids(&["mods/A.JAR.DISABLED"]), vec!["mods/A.JAR"]);
        assert_eq!(ids(&["mods/a.jar.Disabled", "mods/a.jar"]), vec!["mods/a.jar#disabled", "mods/a.jar"]);
        assert_eq!(strip_disabled("x.jar.DISABLED"), Some("x.jar"));
        assert_eq!(strip_disabled("x.jar"), None);
        assert_eq!(strip_disabled("ü.disabled"), Some("ü"));
        assert_eq!(strip_disabled("ab"), None);
    }

    #[test]
    fn case_insensitive_twins_get_marker() {
        let paths: Vec<String> = vec!["mods/X.jar".into(), "mods/x.jar.disabled".into()];
        let ci: Vec<String> = top_level_ids_with(&paths, true).into_iter().map(|(id, _)| id).collect();
        assert_eq!(ci, vec!["mods/X.jar", "mods/x.jar#disabled"]);
        let cs: Vec<String> = top_level_ids_with(&paths, false).into_iter().map(|(id, _)| id).collect();
        assert_eq!(cs, vec!["mods/X.jar", "mods/x.jar"]);
    }

    #[test]
    fn resolve_finds_upper_case_disabled_suffix() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mods = tmp.path().join("mods");
        std::fs::create_dir_all(&mods).expect("mkdir");
        std::fs::write(mods.join("b.jar.DISABLED"), b"x").expect("write");
        let got = resolve(tmp.path(), "mods/b.jar").expect("resolved");
        assert!(got.eq_ignore_ascii_case("mods/b.jar.disabled"), "{got}");
    }

    #[test]
    fn separators_are_forward_slashes() {
        assert_eq!(ids(&["mods\\sub\\a.jar"]), vec!["mods/sub/a.jar"]);
        assert_eq!(nested_id("mods/a.jar", "META-INF\\jarjar\\b.jar"), "mods/a.jar!/META-INF/jarjar/b.jar");
    }

    #[test]
    fn resolve_follows_toggle() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mods = tmp.path().join("mods");
        std::fs::create_dir_all(&mods).expect("mkdir");
        std::fs::write(mods.join("a.jar"), b"x").expect("write");
        assert_eq!(resolve(tmp.path(), "mods/a.jar").as_deref(), Some("mods/a.jar"));
        std::fs::rename(mods.join("a.jar"), mods.join("a.jar.disabled")).expect("rename");
        assert_eq!(resolve(tmp.path(), "mods/a.jar").as_deref(), Some("mods/a.jar.disabled"));
        std::fs::write(mods.join("a.jar"), b"y").expect("write");
        assert_eq!(resolve(tmp.path(), "mods/a.jar").as_deref(), Some("mods/a.jar"));
        assert_eq!(resolve(tmp.path(), "mods/a.jar#disabled").as_deref(), Some("mods/a.jar.disabled"));
        assert_eq!(resolve(tmp.path(), "mods/missing.jar"), None);
        assert_eq!(resolve(tmp.path(), "mods/a.jar!/inner.jar"), None);
        assert_eq!(resolve(tmp.path(), "../mods/a.jar"), None);
    }
}
