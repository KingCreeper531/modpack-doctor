//! Verified downloads and project icons, both CDN-only.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
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

        let mut file = tokio::fs::File::create(&temp).await.map_err(|e| Error::io(&temp, e))?;
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
        if !validate::is_base62_id(project_id) {
            return Err(Error::Invalid(format!("\"{project_id}\" is not a Modrinth project id")));
        }
        let url = self.inner.cdn.parse(icon_url).ok_or_else(|| {
            Error::Invalid(format!("refusing to fetch an icon from {icon_url}: only https://{}/ is allowed", self.inner.cdn.host))
        })?;
        let existing = existing_icon(icon_dir, project_id).await;
        if let Some((p, modified)) = &existing {
            let young = modified
                .and_then(|m| SystemTime::now().duration_since(m).ok())
                .is_some_and(|age| age < ICON_MAX_AGE);
            if young || !self.inner.online {
                return Ok(Some(p.clone()));
            }
        }
        if !self.inner.online {
            return Ok(None);
        }
        let fallback = existing.map(|(p, _)| p);

        let client = self.inner.http.clone();
        let build = move || client.get(url.clone()).timeout(Duration::from_secs(30));
        let resp = match http::send(&build, None, None, &self.inner.policy, None).await {
            Ok((r, _)) => r,
            Err(_) if fallback.is_some() => return Ok(fallback),
            Err(ReqError::NotFound) => return Ok(None),
            Err(e) => return Err(e.into_error("the project icon")),
        };
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let Some(ext) = icon_ext(&content_type) else { return Ok(fallback) };
        let bytes = match http::read_capped(resp, MAX_ICON).await {
            Ok(b) => b,
            Err(_) => return Ok(fallback),
        };
        if !magic_matches(ext, &bytes) {
            return Ok(fallback);
        }
        tokio::fs::create_dir_all(icon_dir).await.map_err(|e| Error::io(icon_dir, e))?;
        let dest = icon_dir.join(format!("{project_id}.{ext}"));
        let temp = icon_dir.join(format!(".{project_id}.{ext}.part"));
        if let Err(e) = tokio::fs::write(&temp, &bytes).await {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(Error::io(&temp, e));
        }
        if let Err(e) = tokio::fs::rename(&temp, &dest).await {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(Error::io(&dest, e));
        }
        for other in ICON_EXTS.iter().filter(|e| **e != ext) {
            let _ = tokio::fs::remove_file(icon_dir.join(format!("{project_id}.{other}"))).await;
        }
        Ok(Some(dest))
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
