//! PathGuard: the only gate between a path and the filesystem for anything that
//! originated outside Rust. Every path is canonicalised (symlinks resolved) and must sit
//! inside a registered root. Tauri capabilities cannot scope custom commands, so this is
//! where filesystem scoping is enforced.
//!
//! Symlinked folders: users commonly symlink `mods/` (or single jars) to shared storage.
//! Discovery therefore registers, besides the instance root, the canonical targets of the
//! instance's `mods/`, `logs/` and `crash-reports/` (one level, no recursion) as roots.
//! Anything else that resolves outside every root is `OutsideScope`.
//!
//! **hs_err dirs** (narrow read-only rule; CONTRACTS invariant 11, CurseForge hs_err). A folder
//! registered with [`PathGuard::set_hs_err_dirs`] is *not* a root. [`PathGuard::check_existing`]
//! additionally accepts a path that resolves (symlinks followed) to a regular file named exactly
//! `hs_err_pid<pid>.log` (decimal pid, no leading zero) directly inside such a folder, and
//! nothing else: not the folder itself, no other file name, nothing in a subfolder.
//! [`PathGuard::check_new`] never accepts anything in it, so nothing there can be created,
//! renamed onto or written. Discovery sets the list to the CurseForge `Install` folders of the
//! discovered CurseForge instances (empty when there are none).

use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

use crate::error::{Error, Result};

#[derive(Debug, Default)]
pub struct PathGuard {
    /// (canonical root, root as originally given) — the latter lets a root be removed after
    /// its folder was deleted.
    roots: RwLock<Vec<(PathBuf, PathBuf)>>,
    /// Canonical folders whose `hs_err_pid<pid>.log` files (directly inside) are readable.
    hs_err_dirs: RwLock<Vec<PathBuf>>,
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

    /// Replace the read-only hs_err dirs (see the module docs). Folders that do not exist (or
    /// cannot be resolved) are skipped; an empty list switches the rule off.
    pub fn set_hs_err_dirs(&self, dirs: &[PathBuf]) {
        let mut canon: Vec<PathBuf> = Vec::new();
        for d in dirs {
            match canonical(d) {
                Ok(c) if c.is_dir() && !canon.contains(&c) => canon.push(c),
                Ok(_) => {}
                Err(e) => eprintln!("path guard: not reading hs_err files in {}: {e}", d.display()),
            }
        }
        if let Ok(mut current) = self.hs_err_dirs.write() {
            *current = canon;
        }
    }

    /// The canonical read-only hs_err dirs currently active.
    pub fn hs_err_dirs(&self) -> Vec<PathBuf> {
        self.hs_err_dirs.read().map(|d| d.clone()).unwrap_or_default()
    }

    /// Resolve an existing path and check it is inside a registered root, or is an
    /// `hs_err_pid<pid>.log` file directly in an hs_err dir (read-only rule, module docs).
    pub fn check_existing(&self, path: &Path) -> Result<PathBuf> {
        let canon = canonical(path)?;
        if self.ensure_inside(&canon, path).is_ok() || self.hs_err_rule_allows(&canon)? {
            return Ok(canon);
        }
        Err(Error::OutsideScope { path: path.display().to_string() })
    }

    /// Whether the canonical path `canon` is a regular `hs_err_pid<pid>.log` file directly in
    /// an hs_err dir.
    fn hs_err_rule_allows(&self, canon: &Path) -> Result<bool> {
        let dirs = self.hs_err_dirs.read().map_err(|_| poisoned())?;
        if dirs.is_empty() {
            return Ok(false);
        }
        let (Some(parent), Some(name)) = (canon.parent(), canon.file_name().and_then(|n| n.to_str())) else {
            return Ok(false);
        };
        Ok(is_hs_err_file_name(name)
            && dirs.iter().any(|d| d == parent)
            && std::fs::metadata(canon).map(|m| m.is_file()).unwrap_or(false))
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

/// Exactly `hs_err_pid<pid>.log` as HotSpot writes it: a decimal pid without leading zero.
fn is_hs_err_file_name(name: &str) -> bool {
    let Some(digits) = name.strip_prefix("hs_err_pid").and_then(|r| r.strip_suffix(".log")) else {
        return false;
    };
    !digits.is_empty()
        && digits.len() <= 10
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'))
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

    // ── Read-only hs_err dirs ────────────────────────────────────────────────

    /// A guard with one instance root and a CurseForge-like `Install` folder full of files that
    /// must stay unreadable, plus one hs_err file.
    fn hs_err_setup() -> (tempfile::TempDir, PathGuard, PathBuf, PathBuf) {
        let (t, g, root) = setup();
        let install = dunce::canonicalize(t.path()).expect("canon").join("minecraft").join("Install");
        fs::create_dir_all(install.join("sub")).expect("mkdir");
        for f in [
            "hs_err_pid1234.log",
            "launcher_log.txt",
            "launcher_msa_credentials.bin",
            "launcher_profiles.json",
            "hs_err_pid1.log.bak",
            "hs_err_pid01.log",
            "hs_err_pid.log",
            "HS_ERR_PID7.LOG",
            "crash.txt",
            "sub/hs_err_pid1.log",
        ] {
            fs::write(install.join(f), b"x").expect("write");
        }
        fs::create_dir_all(install.join("hs_err_pid9.log")).expect("dir named like a log");
        g.set_hs_err_dirs(std::slice::from_ref(&install));
        (t, g, root, install)
    }

    #[test]
    fn hs_err_dir_allows_reading_only_hs_err_files_directly_inside() {
        let (_t, g, _root, install) = hs_err_setup();
        assert_eq!(g.hs_err_dirs(), vec![install.clone()]);
        assert_eq!(g.check_existing(&install.join("hs_err_pid1234.log")).expect("hs_err"), install.join("hs_err_pid1234.log"));
        for bad in [
            "launcher_log.txt",
            "launcher_msa_credentials.bin",
            "launcher_profiles.json",
            "hs_err_pid1.log.bak",
            "hs_err_pid01.log",
            "hs_err_pid.log",
            "HS_ERR_PID7.LOG",
            "crash.txt",
            "sub/hs_err_pid1.log",
            "sub",
            "hs_err_pid9.log",
            ".",
        ] {
            let err = g.check_existing(&install.join(bad)).expect_err(bad);
            assert!(matches!(err, Error::OutsideScope { .. }), "{bad}: {err}");
        }
        assert!(g.check_existing(&install).is_err(), "the folder itself is not readable");
        assert!(g.check_existing(&install.join("sub").join("..").join("launcher_log.txt")).is_err());
        // It is not a root.
        assert!(!g.roots().contains(&install));
    }

    #[test]
    fn hs_err_dir_is_never_writable() {
        let (_t, g, _root, install) = hs_err_setup();
        for name in ["hs_err_pid1234.log", "hs_err_pid5.log", "x.jar", "launcher_log.txt"] {
            assert!(g.check_new(&install.join(name)).is_err(), "{name}");
        }
        assert!(g.check_new(&install.join("sub").join("hs_err_pid5.log")).is_err());
    }

    #[test]
    fn hs_err_rule_is_switched_off_by_an_empty_list() {
        let (_t, g, _root, install) = hs_err_setup();
        g.set_hs_err_dirs(&[]);
        assert!(g.hs_err_dirs().is_empty());
        assert!(g.check_existing(&install.join("hs_err_pid1234.log")).is_err());
        // Missing folders are skipped.
        g.set_hs_err_dirs(&[install.join("missing")]);
        assert!(g.hs_err_dirs().is_empty());
    }

    #[test]
    fn hs_err_rule_refuses_links_escaping_the_dir() {
        let (t, g, _root, install) = hs_err_setup();
        let outside = t.path().join("outside");
        fs::create_dir_all(&outside).expect("mkdir");
        fs::write(outside.join("secret.txt"), b"s").expect("write");
        fs::write(outside.join("hs_err_pid42.log"), b"s").expect("write");
        // A junction (no privilege needed) inside the dir: its files are in a subfolder.
        link_dir(&outside, &install.join("linked"));
        assert!(g.check_existing(&install.join("linked").join("hs_err_pid42.log")).is_err());
        // A file symlink named like an hs_err file that points elsewhere (needs a privilege on
        // Windows; skipped when it cannot be created).
        let link = install.join("hs_err_pid77.log");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(outside.join("secret.txt"), &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside.join("secret.txt"), &link);
        match made {
            Ok(()) => assert!(g.check_existing(&link).is_err(), "symlink escaping the hs_err dir"),
            Err(_) => eprintln!("skipped the file-symlink case: creating symlinks needs a privilege here"),
        }
    }

    #[test]
    fn remove_root_works_after_folder_deleted() {
        let (_t, g, root) = setup();
        fs::remove_dir_all(&root).expect("rm");
        g.remove_root(&root);
        assert!(g.roots().is_empty());
    }
}
