//! Disk cache: one small JSON file per key, `<root>/<namespace>/<stem>.json`.
//!
//! The stem is a readable prefix of the key plus 16 hex chars of SHA-1 over the exact key, so
//! keys that differ only by case (base62 ids) never collide on case-insensitive filesystems and
//! no key can escape its directory. Each file stores its key and fetch time; a file that fails to
//! parse, belongs to another key or comes from a newer schema is treated as absent (and later
//! overwritten). Writes go to a unique temp file in the same directory, then rename. All cache I/O
//! is best effort: a failing disk never fails a lookup.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

// 2: `MrVersion.date_published` (M5): older entries lack it and are refetched.
const SCHEMA: u32 = 2;
/// Entries "fetched" further than this in the future (clock moved back) count as expired.
const MAX_CLOCK_SKEW_MS: u64 = 24 * 3600 * 1000;

#[derive(Serialize, Deserialize)]
struct Entry<T> {
    v: u32,
    key: String,
    fetched_at_ms: u64,
    /// `None` = negative entry ("Modrinth does not know this").
    value: Option<T>,
}

/// A cache hit. `value: None` is a negative entry.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Cached<T> {
    pub value: Option<T>,
    pub fresh: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Ttl {
    pub positive_ms: u64,
    pub negative_ms: u64,
}

impl Ttl {
    pub const fn hours(positive: u64, negative: u64) -> Self {
        Ttl { positive_ms: positive * 3600 * 1000, negative_ms: negative * 3600 * 1000 }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct DiskCache {
    root: PathBuf,
}

static NONCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn stem(key: &str) -> String {
    let readable: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect::<String>()
        .to_ascii_lowercase();
    let digest = hex::encode(Sha1::digest(key.as_bytes()));
    format!("{readable}-{}", &digest[..16])
}

impl DiskCache {
    pub fn new(root: PathBuf) -> Self {
        DiskCache { root }
    }

    /// `namespace` may contain `/` for nested folders (e.g. `updates/<filters>`); callers only
    /// pass constant names or hex digests.
    pub fn path(&self, namespace: &str, key: &str) -> PathBuf {
        let mut p = self.root.clone();
        for part in namespace.split('/') {
            p.push(part);
        }
        p.push(format!("{}.json", stem(key)));
        p
    }

    pub async fn get<T: DeserializeOwned>(&self, namespace: &str, key: &str, ttl: Ttl, now_ms: u64) -> Option<Cached<T>> {
        let bytes = tokio::fs::read(self.path(namespace, key)).await.ok()?;
        let entry: Entry<T> = serde_json::from_slice(&bytes).ok()?;
        if entry.v != SCHEMA || entry.key != key {
            return None;
        }
        let ttl_ms = if entry.value.is_some() { ttl.positive_ms } else { ttl.negative_ms };
        let fresh = entry.fetched_at_ms <= now_ms.saturating_add(MAX_CLOCK_SKEW_MS)
            && now_ms.saturating_sub(entry.fetched_at_ms) < ttl_ms;
        Some(Cached { value: entry.value, fresh })
    }

    pub async fn put<T: Serialize>(&self, namespace: &str, key: &str, value: Option<&T>, now_ms: u64) {
        let path = self.path(namespace, key);
        let entry = Entry { v: SCHEMA, key: key.to_string(), fetched_at_ms: now_ms, value };
        let Ok(bytes) = serde_json::to_vec(&entry) else { return };
        let _ = write_atomic(&path, &bytes).await;
    }
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| std::io::Error::other("cache path has no parent"))?;
    tokio::fs::create_dir_all(dir).await?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("entry");
    let nonce = NONCE.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{name}.{}.{nonce}.tmp", std::process::id()));
    tokio::fs::write(&tmp, bytes).await?;
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_are_safe_and_case_distinct() {
        assert_ne!(stem("AANobbMI"), stem("aanobbmi"));
        let s = stem("../../etc/passwd");
        assert!(!s.contains('/') && !s.contains('.'));
    }

    #[tokio::test]
    async fn roundtrip_ttl_and_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let c = DiskCache::new(dir.path().to_path_buf());
        let ttl = Ttl { positive_ms: 1000, negative_ms: 100 };
        c.put("ns", "k", Some(&5u32), 10_000).await;
        c.put::<u32>("ns", "neg", None, 10_000).await;
        assert_eq!(c.get::<u32>("ns", "k", ttl, 10_500).await, Some(Cached { value: Some(5), fresh: true }));
        assert_eq!(c.get::<u32>("ns", "k", ttl, 11_000).await, Some(Cached { value: Some(5), fresh: false }));
        assert_eq!(c.get::<u32>("ns", "neg", ttl, 10_050).await, Some(Cached { value: None, fresh: true }));
        assert_eq!(c.get::<u32>("ns", "neg", ttl, 10_100).await, Some(Cached { value: None, fresh: false }));
        assert_eq!(c.get::<u32>("ns", "missing", ttl, 0).await, None);
        std::fs::write(c.path("ns", "k"), b"{not json").unwrap();
        assert_eq!(c.get::<u32>("ns", "k", ttl, 10_500).await, None);
        c.put("ns", "k", Some(&6u32), 10_000).await;
        assert_eq!(c.get::<u32>("ns", "k", ttl, 10_500).await.and_then(|h| h.value), Some(6));
        // No temp files left behind.
        let leftovers = std::fs::read_dir(dir.path().join("ns")).unwrap().filter(|e| {
            e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp")
        });
        assert_eq!(leftovers.count(), 0);
    }
}
