//! Filesystem primitives of the fix engine. Every path goes through the PathGuard; nothing here
//! ever deletes a user file. A "move" is a rename, or (across volumes) a verified copy followed
//! by removing the source, and it never replaces an existing destination.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::error::{Error, Result};
use crate::guard::PathGuard;

/// A file's fingerprint: size, modification time (epoch ms) and sha1 (lower-case hex).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub size: u64,
    pub mtime_ms: u64,
    pub sha1: String,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Streaming sha1 of a file.
pub fn sha1_file(path: &Path) -> Result<String> {
    let mut f = fs::File::open(path).map_err(|e| Error::io(path, e))?;
    let mut h = Sha1::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| Error::io(path, e))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

pub fn sha1_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha1::digest(bytes))
}

/// Size + mtime + sha1 of a regular file (links are followed; the guard already vetted them).
pub fn stamp(path: &Path) -> Result<Stamp> {
    let meta = fs::metadata(path).map_err(|e| Error::io(path, e))?;
    if !meta.is_file() {
        return Err(Error::Invalid(format!("{} is not a file", path.display())));
    }
    let sha1 = sha1_file(path)?;
    Ok(Stamp { size: meta.len(), mtime_ms: mtime_ms(&meta), sha1 })
}

/// Size + mtime only (cheap pre-check before hashing).
pub fn quick_stat(path: &Path) -> std::io::Result<(u64, u64, bool)> {
    let meta = fs::metadata(path)?;
    Ok((meta.len(), mtime_ms(&meta), meta.is_file()))
}

/// True when nothing at all (not even a dangling link) exists at `path`. Errors other than
/// "not found" count as "something is there" (refuse rather than guess).
pub fn is_absent(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}

/// An existing file `rel` under `base`, vetted by the guard. Returns the path with a canonical
/// parent and the original final component, so a symlinked jar is acted on as the link itself
/// (renamed or moved), never its target.
pub fn existing(guard: &PathGuard, base: &Path, rel: &str) -> Result<PathBuf> {
    let joined = PathGuard::join_relative(base, rel)?;
    guard.check_existing(&joined)?;
    let name = joined
        .file_name()
        .ok_or_else(|| Error::Invalid(format!("{rel} is not a file path")))?
        .to_owned();
    let parent = joined.parent().ok_or_else(|| Error::Invalid(format!("{rel} has no parent folder")))?;
    Ok(guard.check_existing(parent)?.join(name))
}

/// A path `rel` under `base` that is about to be created, vetted by the guard (parent must
/// exist inside a root; an existing link there is refused).
pub fn new_path(guard: &PathGuard, base: &Path, rel: &str) -> Result<PathBuf> {
    let joined = PathGuard::join_relative(base, rel)?;
    guard.check_new(&joined)
}

/// Create the parent folders of `rel` under `base` (both inside the guard), e.g. `files/mods`.
pub fn ensure_parent(guard: &PathGuard, base: &Path, rel: &str) -> Result<()> {
    let joined = PathGuard::join_relative(base, rel)?;
    if let Some(parent) = joined.parent() {
        guard.check_existing(base)?;
        fs::create_dir_all(parent).map_err(|e| Error::io(parent, e))?;
        guard.check_existing(parent)?;
    }
    Ok(())
}

/// A random lower-case hex string of `16 * words` characters. Not cryptographic, but keyed
/// with the process's random SipHash keys, so ids and nonces are unpredictable and unique.
pub fn random_hex(words: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut out = String::with_capacity(16 * words);
    for _ in 0..words {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn is_cross_device(e: &std::io::Error) -> bool {
    // EXDEV (Unix) / ERROR_NOT_SAME_DEVICE (Windows).
    #[cfg(windows)]
    const CODE: i32 = 17;
    #[cfg(not(windows))]
    const CODE: i32 = 18;
    e.raw_os_error() == Some(CODE) || e.kind() == std::io::ErrorKind::CrossesDevices
}

/// Move `src` → `dst` without ever replacing `dst`. A same-volume move is one rename; across
/// volumes the file is copied to a temp name next to `dst`, fsynced, verified by sha1, renamed
/// into place, and only then is `src` removed (if that fails, the copy is removed again and the
/// move fails, so the file stays where it was). On Windows a file another program holds open
/// fails here (sharing violation) instead of being moved.
pub fn move_file(src: &Path, dst: &Path) -> Result<()> {
    if !is_absent(dst) {
        return Err(Error::Conflict(format!("{} already exists, so nothing was moved there.", dst.display())));
    }
    match fs::rename(src, dst) {
        Ok(()) => {
            sync_parent(dst);
            Ok(())
        }
        Err(e) if is_cross_device(&e) => copy_then_remove(src, dst),
        Err(e) => Err(Error::io(src, e)),
    }
}

fn copy_then_remove(src: &Path, dst: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(src).map_err(|e| Error::io(src, e))?;
    if !meta.is_file() {
        return Err(Error::Invalid(format!("{} is a link or folder and cannot be moved to another drive", src.display())));
    }
    let parent = dst.parent().ok_or_else(|| Error::Invalid(format!("{} has no parent folder", dst.display())))?;
    let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = parent.join(format!(".{name}.{}.part", random_hex(1)));
    let result = (|| {
        let want = sha1_file(src)?;
        {
            let mut from = fs::File::open(src).map_err(|e| Error::io(src, e))?;
            let mut to = fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| Error::io(&temp, e))?;
            std::io::copy(&mut from, &mut to).map_err(|e| Error::io(&temp, e))?;
            to.flush().map_err(|e| Error::io(&temp, e))?;
            to.sync_all().map_err(|e| Error::io(&temp, e))?;
        }
        let got = sha1_file(&temp)?;
        if got != want {
            return Err(Error::Corrupt { path: dst.display().to_string(), reason: "the copy does not match the original".into() });
        }
        if !is_absent(dst) {
            return Err(Error::Conflict(format!("{} already exists, so nothing was moved there.", dst.display())));
        }
        fs::rename(&temp, dst).map_err(|e| Error::io(dst, e))?;
        if let Err(e) = fs::remove_file(src) {
            // The original stays; take our copy back out so the file exists exactly once.
            let _ = fs::remove_file(dst);
            return Err(Error::io(src, e));
        }
        sync_parent(dst);
        Ok(())
    })();
    if !is_absent(&temp) {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Best effort: make a rename durable (Unix only; Windows has no directory handles here).
fn sync_parent(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(d) = fs::File::open(parent) {
            let _ = d.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Write `bytes` to `path` atomically: temp file in the same folder → fsync → rename over it.
/// Only used for the app's own files (manifests), never for user files.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| Error::Invalid(format!("{} has no parent folder", path.display())))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = parent.join(format!(".{name}.{}.tmp", random_hex(1)));
    let written = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| Error::io(&temp, e))?;
        f.write_all(bytes).map_err(|e| Error::io(&temp, e))?;
        f.sync_all().map_err(|e| Error::io(&temp, e))?;
        drop(f);
        let mut last = None;
        for attempt in 0..3 {
            match fs::rename(&temp, path) {
                Ok(()) => {
                    sync_parent(path);
                    return Ok(());
                }
                Err(e) => last = Some(e),
            }
            std::thread::sleep(std::time::Duration::from_millis(20 * (attempt + 1)));
        }
        Err(Error::io(path, last.unwrap_or_else(|| std::io::Error::other("rename failed"))))
    })();
    if written.is_err() && !is_absent(&temp) {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// `rel` lower-cased on case-insensitive filesystems (for "same file" comparisons).
pub fn fold(rel: &str) -> String {
    if crate::jar_id::CASE_INSENSITIVE_FS {
        rel.to_lowercase()
    } else {
        rel.to_string()
    }
}

/// The last `/` segment of a relative path.
pub fn file_name_of(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// `rel`, or `rel.1`, `rel.2`, … — the first that is absent under `base` (snapshot `created/`).
pub fn unique_rel(base: &Path, rel: &str) -> Result<String> {
    for n in 0..1000u32 {
        let cand = if n == 0 { rel.to_string() } else { format!("{rel}.{n}") };
        if is_absent(&PathGuard::join_relative(base, &cand)?) {
            return Ok(cand);
        }
    }
    Err(Error::Conflict(format!("Too many earlier copies of {rel} are in the backup folder.")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_never_replaces() {
        let t = tempfile::tempdir().expect("tmp");
        let a = t.path().join("a");
        let b = t.path().join("b");
        fs::write(&a, b"a").expect("w");
        fs::write(&b, b"b").expect("w");
        assert!(move_file(&a, &b).is_err());
        assert_eq!(fs::read(&b).expect("r"), b"b");
        assert_eq!(fs::read(&a).expect("r"), b"a");
        let c = t.path().join("c");
        move_file(&a, &c).expect("move");
        assert!(is_absent(&a));
        assert_eq!(fs::read(&c).expect("r"), b"a");
    }

    #[test]
    fn copy_fallback_moves_and_verifies() {
        let t = tempfile::tempdir().expect("tmp");
        let a = t.path().join("a.jar");
        fs::write(&a, b"payload").expect("w");
        let b = t.path().join("b.jar");
        copy_then_remove(&a, &b).expect("copy move");
        assert!(is_absent(&a));
        assert_eq!(fs::read(&b).expect("r"), b"payload");
        // Only the destination remains (no temp leftovers).
        assert_eq!(fs::read_dir(t.path()).expect("ls").count(), 1);
    }

    #[test]
    fn random_ids_differ() {
        let a = random_hex(2);
        let b = random_hex(2);
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
    }

    #[test]
    fn atomic_write_replaces_own_file() {
        let t = tempfile::tempdir().expect("tmp");
        let p = t.path().join("manifest.json");
        write_atomic(&p, b"1").expect("w1");
        write_atomic(&p, b"2").expect("w2");
        assert_eq!(fs::read(&p).expect("r"), b"2");
        assert_eq!(fs::read_dir(t.path()).expect("ls").count(), 1);
    }
}
