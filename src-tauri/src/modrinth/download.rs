//! Verified downloads and project icons, both CDN-only.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha512};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use super::http::{self, ReqError};
use super::{validate, ModrinthClient};
use crate::error::{Error, Result};
use crate::model::ProjectLookup;

/// Hard cap on any download (`Tuning::max_download`). No mod jar is anywhere near this.
pub(crate) const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;
/// Allowed difference between the API's `size` and the bytes actually served.
const SIZE_SLACK: u64 = 64 * 1024;
const MAX_ICON: usize = 1024 * 1024;
const ICON_EXTS: [&str; 4] = ["png", "jpg", "webp", "gif"];
/// Icons are re-fetched (when online) after this long.
const ICON_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
const ICON_CONCURRENCY: usize = 4;
/// Per-request timeout of one icon fetch (`Tuning::icon_timeout`).
pub(crate) const ICON_TIMEOUT: Duration = Duration::from_secs(30);

/// Makes every icon temp file name unique, so concurrent fetches of one icon never share one.
static ICON_NONCE: AtomicU64 = AtomicU64::new(0);

/// One icon fetch, with a connection-level failure kept visible for `fetch_icons`.
struct IconFetch {
    result: Result<Option<PathBuf>>,
    /// The CDN could not be reached at all (timeout, refused connection, DNS).
    unreachable: bool,
}

impl IconFetch {
    fn done(result: Result<Option<PathBuf>>) -> Self {
        IconFetch { result, unreachable: false }
    }
}

fn icon_ext(content_type: &str) -> Option<&'static str> {
    let mime = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match mime.as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// The bytes must really be what the content type claims (never an SVG/HTML in disguise).
fn magic_matches(ext: &str, b: &[u8]) -> bool {
    match ext {
        "png" => b.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" => b.starts_with(&[0xFF, 0xD8, 0xFF]),
        "gif" => b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a"),
        "webp" => b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP",
        _ => false,
    }
}

async fn existing_icon(dir: &Path, project_id: &str) -> Option<(PathBuf, Option<SystemTime>)> {
    for ext in ICON_EXTS {
        let p = dir.join(format!("{project_id}.{ext}"));
        if let Ok(meta) = tokio::fs::metadata(&p).await {
            if meta.is_file() {
                return Some((p, meta.modified().ok()));
            }
        }
    }
    None
}

impl ModrinthClient {
    /// Download `url` (must be `https://<cdn_host>/…`) into `<dest_dir>/.<file_name>.part`,
    /// verifying size and SHA-512 while streaming, then fsync. Returns the temp path; the caller
    /// renames it into place. On any failure the temp file is removed.
    ///
    /// `expected_size`: `Some(n)` (the API's `MrFile.size`) allows at most `n` + 64 KiB;
    /// `None` (size unknown) enforces only the 512 MiB hard cap. The SHA-512 check is what
    /// actually proves the content either way.
    pub async fn download_verified(
        &self,
        url: &str,
        expected_sha512: &str,
        expected_size: Option<u64>,
        dest_dir: &Path,
        file_name: &str,
    ) -> Result<PathBuf> {
        validate::file_name(file_name)?;
        let expected = validate::sha512(expected_sha512)?;
        let cap = self.inner.max_download;
        if expected_size.is_some_and(|n| n > cap) {
            return Err(Error::Invalid(format!("{file_name} is larger than the {} MB download limit", cap >> 20)));
        }
        let parsed = self.inner.cdn.parse(url).ok_or_else(|| {
            Error::Invalid(format!(
                "refusing to download {file_name} from {url}: only https://{}/ URLs returned by the Modrinth API are allowed",
                self.inner.cdn.host
            ))
        })?;
        if !self.inner.online {
            return Err(Error::Offline);
        }
        let limit = expected_size.map_or(cap, |n| n.saturating_add(SIZE_SLACK).min(cap));
        let temp = dest_dir.join(format!(".{file_name}.part"));

        let client = self.inner.http.clone();
        let build = move || client.get(parsed.clone());
        let (mut resp, _) = http::send(&build, None, None, &self.inner.policy, None)
            .await
            .map_err(|e| e.into_error(&format!("the download of {file_name}")))?;
        let too_big = || Error::Corrupt {
            path: file_name.to_string(),
            reason: match expected_size {
                Some(n) => format!("the server sent more than the {n} bytes Modrinth reported"),
                None => format!("the server sent more than the {} MB download limit", cap >> 20),
            },
        };
        if resp.content_length().is_some_and(|n| n > limit) {
            return Err(too_big());
        }

        // `create_new`: never truncate or reuse a file that is already there (it is not ours).
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .await
            .map_err(|e| Error::io(&temp, e))?;
        let mut hasher = Sha512::new();
        let mut received: u64 = 0;
        let streamed: Result<()> = async {
            while let Some(chunk) = resp
                .chunk()
                .await
                .map_err(|_| Error::Network(format!("the download of {file_name} was interrupted")))?
            {
                received += chunk.len() as u64;
                if received > limit {
                    return Err(too_big());
                }
                hasher.update(&chunk);
                file.write_all(&chunk).await.map_err(|e| Error::io(&temp, e))?;
            }
            file.flush().await.map_err(|e| Error::io(&temp, e))?;
            file.sync_all().await.map_err(|e| Error::io(&temp, e))?;
            Ok(())
        }
        .await;
        drop(file);
        if let Err(e) = streamed {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(e);
        }
        let actual = hex::encode(hasher.finalize());
        if actual != expected {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(Error::HashMismatch { path: file_name.to_string(), expected, actual });
        }
        Ok(temp)
    }

    /// Cache a project icon as `<icon_dir>/<project_id>.<png|jpg|webp|gif>` and return its path.
    /// `Ok(None)` when the icon is unusable (SVG or other type, wrong bytes, over 1 MB) or when
    /// offline with nothing cached. An existing icon younger than 7 days is reused as is.
    pub async fn fetch_icon(&self, project_id: &str, icon_url: &str, icon_dir: &Path) -> Result<Option<PathBuf>> {
        self.fetch_icon_classified(project_id, icon_url, icon_dir, None).await.result
    }

    /// `fetch_icon`, reporting whether the CDN was unreachable. `abort` (set by another fetch of
    /// the same pass) makes the request give up before it is sent.
    async fn fetch_icon_classified(
        &self,
        project_id: &str,
        icon_url: &str,
        icon_dir: &Path,
        abort: Option<&AtomicBool>,
    ) -> IconFetch {
        if !validate::is_base62_id(project_id) {
            return IconFetch::done(Err(Error::Invalid(format!("\"{project_id}\" is not a Modrinth project id"))));
        }
        let Some(url) = self.inner.cdn.parse(icon_url) else {
            return IconFetch::done(Err(Error::Invalid(format!(
                "refusing to fetch an icon from {icon_url}: only https://{}/ is allowed",
                self.inner.cdn.host
            ))));
        };
        let existing = existing_icon(icon_dir, project_id).await;
        if let Some((p, modified)) = &existing {
            let young = modified
                .and_then(|m| SystemTime::now().duration_since(m).ok())
                .is_some_and(|age| age < ICON_MAX_AGE);
            if young || !self.inner.online {
                return IconFetch::done(Ok(Some(p.clone())));
            }
        }
        if !self.inner.online {
            return IconFetch::done(Ok(None));
        }
        let fallback = existing.map(|(p, _)| p);

        let client = self.inner.http.clone();
        let timeout = self.inner.icon_timeout;
        let build = move || client.get(url.clone()).timeout(timeout);
        // Icons are best effort: no retries, so a hanging CDN stops the pass after one timeout
        // instead of the API's long timeout schedule (minutes per icon).
        let policy = http::RetryPolicy { max_retries: 0, max_connect_retries: 0, ..self.inner.policy.clone() };
        let resp = match http::send(&build, None, None, &policy, abort).await {
            Ok((r, _)) => r,
            Err(e) => {
                let unreachable = matches!(e, ReqError::Connect(_));
                let result = match (fallback, e) {
                    (Some(p), _) => Ok(Some(p)),
                    (None, ReqError::NotFound) => Ok(None),
                    (None, e) => Err(e.into_error("the project icon")),
                };
                return IconFetch { result, unreachable };
            }
        };
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        // The label only has to claim a raster image; the bytes decide the format, because the CDN
        // serves some WebP icons as `image/png`. Anything that is not PNG/JPEG/WebP/GIF by its
        // magic bytes (an SVG or HTML in disguise) is refused.
        if icon_ext(&content_type).is_none() {
            return IconFetch::done(Ok(fallback));
        }
        let bytes = match http::read_capped(resp, MAX_ICON).await {
            Ok(b) => b,
            Err(_) => return IconFetch::done(Ok(fallback)),
        };
        let Some(ext) = ICON_EXTS.into_iter().find(|e| magic_matches(e, &bytes)) else {
            return IconFetch::done(Ok(fallback));
        };
        IconFetch::done(store_icon(icon_dir, project_id, ext, &bytes).await.map(Some))
    }

    /// The `modrinth_icons` second pass. Looks `project_ids` (base62 ids; anything else is
    /// ignored) up through the project cache, fetches missing or stale icons (at most
    /// `ICON_CONCURRENCY` at a time) and returns project id → absolute path for every requested
    /// icon now on disk, fresh or not. Nothing is fetched when this client is offline or the
    /// project lookup came back offline or failed; after the first connection-level failure the
    /// remaining fetches are skipped. Never fails: an icon problem just leaves a project out.
    pub async fn fetch_icons(&self, project_ids: &[String], icon_dir: &Path) -> BTreeMap<String, String> {
        self.fetch_icons_while(project_ids, icon_dir, Arc::new(|| true)).await
    }

    /// `fetch_icons`, checking `keep_going` before each icon: once it returns false (Modrinth was
    /// switched off in settings) no further icon is requested. `modrinth_icons` passes the live
    /// setting, so "off" means no network even for a pass that is already running.
    pub async fn fetch_icons_while(
        &self,
        project_ids: &[String],
        icon_dir: &Path,
        keep_going: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> BTreeMap<String, String> {
        let ids = super::dedup_keep_order(project_ids.iter().filter(|id| validate::is_base62_id(id)).cloned().collect());
        if self.inner.online && !ids.is_empty() {
            if let Ok((lookup, urls)) = self.projects_with_icon_urls(&ids, false).await {
                if !lookup.offline {
                    let todo: Vec<(String, String)> = lookup
                        .found
                        .iter()
                        .filter(|(key, p)| **key == p.id)
                        .filter_map(|(_, p)| urls.get(&p.id).map(|u| (p.id.clone(), u.clone())))
                        .collect();
                    self.fetch_icon_set(todo, icon_dir, keep_going).await;
                }
            }
        }
        let mut out = BTreeMap::new();
        for id in ids {
            if let Some((p, _)) = existing_icon(icon_dir, &id).await {
                out.insert(id, p.to_string_lossy().into_owned());
            }
        }
        out
    }

    /// Fetch `(project id, icon URL)` pairs with bounded concurrency; the first connection-level
    /// failure stops every fetch that has not started yet.
    async fn fetch_icon_set(&self, todo: Vec<(String, String)>, icon_dir: &Path, keep_going: Arc<dyn Fn() -> bool + Send + Sync>) {
        let sem = Arc::new(Semaphore::new(ICON_CONCURRENCY));
        let abort = Arc::new(AtomicBool::new(false));
        let mut set = JoinSet::new();
        for (id, url) in todo {
            let (me, dir, sem, abort) = (self.clone(), icon_dir.to_path_buf(), Arc::clone(&sem), Arc::clone(&abort));
            let keep_going = Arc::clone(&keep_going);
            set.spawn(async move {
                let Ok(_permit) = sem.acquire_owned().await else { return };
                if !keep_going() {
                    abort.store(true, Ordering::SeqCst);
                }
                if abort.load(Ordering::SeqCst) {
                    return;
                }
                let f = me.fetch_icon_classified(&id, &url, &dir, Some(&abort)).await;
                // Set while the permit is still held, so no queued fetch starts after a failure.
                if f.unreachable {
                    abort.store(true, Ordering::SeqCst);
                }
            });
        }
        while set.join_next().await.is_some() {}
    }

    /// Fill `icon_path` of every found project that has an icon URL with the icon already on
    /// disk (any age). Never sends a request; `modrinth_projects` uses this.
    pub async fn attach_cached_icons(&self, lookup: &mut ProjectLookup, icon_urls: &BTreeMap<String, String>, icon_dir: &Path) {
        for p in lookup.found.values_mut() {
            if !icon_urls.contains_key(&p.id) || !validate::is_base62_id(&p.id) {
                continue;
            }
            if let Some((path, _)) = existing_icon(icon_dir, &p.id).await {
                p.icon_path = Some(path.to_string_lossy().into_owned());
            }
        }
    }

    /// Fill `icon_path` of every found project that has an icon URL (from
    /// `projects_with_icon_urls`). Icon failures are ignored: the project just has no icon.
    pub async fn attach_icons(&self, lookup: &mut ProjectLookup, icon_urls: &BTreeMap<String, String>, icon_dir: &Path) {
        let sem = Arc::new(Semaphore::new(ICON_CONCURRENCY));
        let mut set = JoinSet::new();
        let ids: std::collections::BTreeSet<String> = lookup.found.values().map(|p| p.id.clone()).collect();
        for id in ids {
            let Some(url) = icon_urls.get(&id).cloned() else { continue };
            let (me, dir, sem) = (self.clone(), icon_dir.to_path_buf(), Arc::clone(&sem));
            set.spawn(async move {
                let _permit = sem.acquire_owned().await.ok()?;
                let path = me.fetch_icon(&id, &url, &dir).await.ok()??;
                Some((id, path))
            });
        }
        let mut paths = BTreeMap::new();
        while let Some(joined) = set.join_next().await {
            if let Ok(Some((id, path))) = joined {
                paths.insert(id, path.to_string_lossy().into_owned());
            }
        }
        for p in lookup.found.values_mut() {
            if let Some(path) = paths.get(&p.id) {
                p.icon_path = Some(path.clone());
            }
        }
    }
}

/// Write the icon through a temp file unique to this writer, then rename it into place.
async fn store_icon(icon_dir: &Path, project_id: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf> {
    tokio::fs::create_dir_all(icon_dir).await.map_err(|e| Error::io(icon_dir, e))?;
    let dest = icon_dir.join(format!("{project_id}.{ext}"));
    let nonce = ICON_NONCE.fetch_add(1, Ordering::Relaxed);
    let temp = icon_dir.join(format!(".{project_id}.{ext}.{}.{nonce}.part", std::process::id()));
    if let Err(e) = tokio::fs::write(&temp, bytes).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(Error::io(&temp, e));
    }
    if let Err(e) = tokio::fs::rename(&temp, &dest).await {
        let _ = tokio::fs::remove_file(&temp).await;
        // On Windows a concurrent fetch replacing the same icon (or a reader holding it open) can
        // make the replace fail; an icon is in place either way.
        if e.kind() == std::io::ErrorKind::PermissionDenied && tokio::fs::metadata(&dest).await.is_ok_and(|m| m.is_file()) {
            return Ok(dest);
        }
        return Err(Error::io(&dest, e));
    }
    for other in ICON_EXTS.iter().filter(|e| **e != ext) {
        let _ = tokio::fs::remove_file(icon_dir.join(format!("{project_id}.{other}"))).await;
    }
    Ok(dest)
}
