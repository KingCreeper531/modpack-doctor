//! PathGuard: the only gate between a path and the filesystem for anything that
//! originated outside Rust. Every path is canonicalised (symlinks resolved) and must sit
//! inside a registered root. Tauri capabilities cannot scope custom commands, so this is
//! where filesystem scoping is enforced.
//!
//! Symlinked folders: users commonly symlink `mods/` (or single jars) to shared storage.
//! Discovery therefore registers, besides the instance root, the canonical targets of the
//! instance's `mods/`, `logs/` and `crash-reports/` (one level, no recursion) as roots.
//! Anything else that resolves outside every root is `OutsideScope`.

use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

use crate::error::{Error, Result};

#[derive(Debug, Default)]
pub struct PathGuard {
    /// (canonical root, root as originally given) — the latter lets a root be removed after
    /// its folder was deleted.
    roots: RwLock<Vec<(PathBuf, PathBuf)>>,
}

impl PathGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a root (instance root, symlink target of mods/logs/crash-reports, manual
    /// folder, launcher root, opened .mrpack, app data dir). Registering a missing path is an error.
    pub fn add_root(&self, root: &Path) -> Result<PathBuf> {
        let canon = canonical(root)?;
        let mut roots = self.roots.write().map_err(|_| poisoned())?;
        if !roots.iter().any(|(c, _)| c == &canon) {
            roots.push((canon.clone(), root.to_path_buf()));
        }
        Ok(canon)
    }

    /// Unregister a root. Works even if the folder no longer exists.
    pub fn remove_root(&self, root: &Path) {
        let canon = canonical(root).ok();
        if let Ok(mut roots) = self.roots.write() {
            roots.retain(|(c, given)| Some(c) != canon.as_ref() && given != root);
        }
    }

    pub fn roots(&self) -> Vec<PathBuf> {
        self.roots
            .read()
            .map(|r| r.iter().map(|(c, _)| c.clone()).collect())
            .unwrap_or_default()
    }

    /// Resolve an existing path and check it is inside a registered root.
    pub fn check_existing(&self, path: &Path) -> Result<PathBuf> {
        let canon = canonical(path)?;
        self.ensure_inside(&canon, path)?;
        Ok(canon)
    }

    /// Resolve a path that may not exist yet (rename/restore/download target): its parent must
    /// exist and be inside a root, the final component must be a safe plain file name, and if
    /// something already exists there it must not be a symlink (a write would follow it).
    pub fn check_new(&self, path: &Path) -> Result<PathBuf> {
        let name = match path.components().next_back() {
            Some(Component::Normal(n)) => n.to_owned(),
            _ => return Err(Error::Invalid(format!("{} is not a file path", path.display()))),
        };
        validate_component(&name.to_string_lossy(), &path.display().to_string())?;
        let parent = path
            .parent()
            .ok_or_else(|| Error::Invalid(format!("{} has no parent folder", path.display())))?;
        let canon_parent = canonical(parent)?;
        self.ensure_inside(&canon_parent, path)?;
        let target = canon_parent.join(name);
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                Err(Error::OutsideScope { path: path.display().to_string() })
            }
            _ => Ok(target),
        }
    }

    /// Join a relative, `/`-separated path (as used in the IPC contract) onto a base,
    /// rejecting absolute paths, drive prefixes, `..`, and names Windows would rewrite or
    /// treat as devices.
    pub fn join_relative(base: &Path, rel: &str) -> Result<PathBuf> {
        if rel.is_empty() || Path::new(rel).is_absolute() || rel.starts_with(['/', '\\']) {
            return Err(Error::OutsideScope { path: rel.to_string() });
        }
        let mut out = base.to_path_buf();
        for part in rel.split(['/', '\\']) {
            if part.is_empty() || part == "." {
                continue;
            }
            validate_component(part, rel)?;
            out.push(part);
        }
        Ok(out)
    }

    fn ensure_inside(&self, canon: &Path, original: &Path) -> Result<()> {
        let roots = self.roots.read().map_err(|_| poisoned())?;
        if roots.iter().any(|(r, _)| canon.starts_with(r)) {
            Ok(())
        } else {
            Err(Error::OutsideScope { path: original.display().to_string() })
        }
    }
}

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "CONIN$", "CONOUT$",
];

/// One path component from outside Rust. Rejected on every OS so behaviour is identical:
/// `..`, trailing dots/spaces (Windows strips them, so `.. ` == `..`), reserved device names
/// (with any extension), control characters, and `<>:"|?*`.
fn validate_component(part: &str, whole: &str) -> Result<()> {
    let bad = || Error::OutsideScope { path: whole.to_string() };
    let trimmed = part.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() || trimmed != part {
        return Err(bad());
    }
    if part.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return Err(bad());
    }
    let stem = part.split('.').next().unwrap_or(part).trim_end().to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(bad());
    }
    Ok(())
}

fn canonical(path: &Path) -> Result<PathBuf> {
    dunce::canonicalize(path).map_err(|e| Error::io(path, e))
}

fn poisoned() -> Error {
    Error::Internal("the path guard lock was poisoned".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup() -> (tempfile::TempDir, PathGuard, PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("Instänce ü 名前");
        fs::create_dir_all(root.join("mods")).expect("mkdir");
        fs::write(root.join("mods").join("a.jar"), b"x").expect("write");
        let guard = PathGuard::new();
        guard.add_root(&root).expect("add root");
        (tmp, guard, root)
    }

    /// Directory link that needs no privilege: junction on Windows, symlink elsewhere.
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .expect("run mklink");
            assert!(status.status.success(), "mklink /J failed: {status:?}");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).expect("symlink");
    }

    #[test]
    fn allows_paths_inside_root_with_non_ascii() {
        let (_t, g, root) = setup();
        assert!(g.check_existing(&root.join("mods").join("a.jar")).is_ok());
    }

    #[test]
    fn rejects_dotdot_escape() {
        let (t, g, root) = setup();
        fs::write(t.path().join("secret.txt"), b"s").expect("write");
        let escaped = root.join("mods").join("..").join("..").join("secret.txt");
        assert!(matches!(g.check_existing(&escaped), Err(Error::OutsideScope { .. })));
    }

    #[test]
    fn rejects_unregistered_path() {
        let (t, g, _root) = setup();
        fs::write(t.path().join("other.txt"), b"o").expect("write");
        assert!(matches!(g.check_existing(&t.path().join("other.txt")), Err(Error::OutsideScope { .. })));
    }

    #[test]
    fn check_new_requires_parent_in_scope() {
        let (t, g, root) = setup();
        assert!(g.check_new(&root.join("mods").join("b.jar.disabled")).is_ok());
        assert!(g.check_new(&t.path().join("nope.jar")).is_err());
    }

    #[test]
    fn check_new_rejects_reserved_and_trailing_names() {
        let (_t, g, root) = setup();
        for bad in ["CON", "nul.jar", "COM1.txt", "a.jar.", "a.jar ", "a?.jar"] {
            assert!(g.check_new(&root.join("mods").join(bad)).is_err(), "{bad} accepted");
        }
    }

    #[test]
    fn join_relative_rejects_escapes() {
        let base = Path::new("base");
        assert!(PathGuard::join_relative(base, "mods/a.jar").is_ok());
        for bad in [
            "",
            "../a.jar",
            "mods/../../a.jar",
            "mods/.. /a.jar",
            "/etc/passwd",
            "C:/Windows",
            "\\\\server\\share",
            "mods/CON",
            "mods/aux.jar",
            "mods/a.jar.",
        ] {
            assert!(PathGuard::join_relative(base, bad).is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn rejects_symlink_escape() {
        let (t, g, root) = setup();
        let outside = t.path().join("outside");
        fs::create_dir_all(&outside).expect("mkdir");
        fs::write(outside.join("x.jar"), b"x").expect("write");
        link_dir(&outside, &root.join("mods").join("link"));
        assert!(g.check_existing(&root.join("mods").join("link").join("x.jar")).is_err());
        // Registering the link target (as discovery does for a linked mods/) makes it allowed.
        g.add_root(&outside).expect("add target");
        assert!(g.check_existing(&root.join("mods").join("link").join("x.jar")).is_ok());
    }

    #[test]
    fn check_new_rejects_existing_link_at_destination() {
        let (t, g, root) = setup();
        let outside = t.path().join("outside2");
        fs::create_dir_all(&outside).expect("mkdir");
        link_dir(&outside, &root.join("mods").join("dest"));
        assert!(g.check_new(&root.join("mods").join("dest")).is_err());
    }

    #[test]
    fn remove_root_works_after_folder_deleted() {
        let (_t, g, root) = setup();
        fs::remove_dir_all(&root).expect("rm");
        g.remove_root(&root);
        assert!(g.roots().is_empty());
    }
}
