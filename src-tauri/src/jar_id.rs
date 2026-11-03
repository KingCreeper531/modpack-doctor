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

/// Ids for a set of top-level jar paths (relative to the scan root, any separator).
/// Returns `(id, normalized path)` in input order.
pub fn top_level_ids(paths: &[String]) -> Vec<(String, String)> {
    let normalized: Vec<String> = paths.iter().map(|p| normalize(p)).collect();
    let enabled: HashSet<&str> = normalized
        .iter()
        .filter(|p| !p.ends_with(DISABLED_SUFFIX))
        .map(String::as_str)
        .collect();
    normalized
        .iter()
        .map(|path| {
            let id = match path.strip_suffix(DISABLED_SUFFIX) {
                Some(base) if enabled.contains(base) => format!("{base}{DISABLED_MARKER}"),
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
        let p = format!("{base}{DISABLED_SUFFIX}");
        return exists(&p).then_some(p);
    }
    if exists(id) {
        return Some(id.to_string());
    }
    let p = format!("{id}{DISABLED_SUFFIX}");
    exists(&p).then_some(p)
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
