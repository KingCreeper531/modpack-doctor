//! Share a log on mclo.gs (user-initiated, CONTRACTS invariant 10 proposal: `api.mclo.gs`).
//!
//! The webview sends only an instance id and a log source id (`share_log`). Rust resolves the
//! source exactly like `read_log_digest` (only ids `list_log_sources` returns, every file through
//! the PathGuard), reads at most the last [`READ_CAP`] bytes, replaces the home folder with `~`
//! ([`scrub::HomeScrubber`], the report rules), keeps the **end** of the log within mclo.gs's
//! limits ([`MAX_BYTES`], [`MAX_LINES`]; mclo.gs itself would cut the end, where crashes are) and
//! posts it to `POST https://api.mclo.gs/1/log` as JSON `{"content": …}` with the app's
//! User-Agent. No redirect is followed. The returned page URLs are built from the returned id
//! (`https://mclo.gs/<id>`, `https://api.mclo.gs/1/raw/<id>`), never taken from the answer, so the
//! opener scope `https://mclo.gs/*` always covers them.
//!
//! API (read 2026-11-07, https://api.mclo.gs/ and github.com/aternosorg/mclogs): limits
//! `maxLength` 10 485 760 bytes and `maxLines` 25 000 (`GET /1/limits`); 60 requests per minute
//! per IP (429); success `{"success": true, "id", "url", "raw", …}`; failure
//! `{"success": false, "error": "…"}`.

pub mod scrub;

#[cfg(test)]
mod tests;

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::error::{AppError, ErrorKind};
use crate::model::SharedLog;
use scrub::HomeScrubber;

/// The production API origin.
pub const MCLOGS_API: &str = "https://api.mclo.gs";
/// mclo.gs `maxLength` (bytes of `content`).
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
/// mclo.gs `maxLines`.
pub const MAX_LINES: usize = 25_000;
/// Bytes read from the end of the file: the limit plus room for what scrubbing removes.
pub const READ_CAP: u64 = 12 * 1024 * 1024;
/// Whole request, connect included.
pub const TIMEOUT: Duration = Duration::from_secs(30);
/// mclo.gs ids are short alphanumeric strings (`WnMMikq`).
const MAX_ID_LEN: usize = 64;

/// The text that will be uploaded, and what was left out.
#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    pub content: String,
    pub total_lines: u32,
    /// Lines of the file in `content` (the note line excluded).
    pub sent_lines: u32,
    pub truncated: bool,
}

/// Note placed first when the start of the log was left out.
pub fn cut_note(left_out: u64) -> String {
    format!(
        "[Modpack Doctor] The first {left_out} lines of this log were left out to fit mclo.gs's limits (10 MiB, 25,000 lines). The end of the log is complete."
    )
}

/// Reads the end of `path` (at most [`READ_CAP`] bytes) and returns `(bytes, lines skipped)`:
/// when the file is longer, the partial first line is dropped and the skipped lines are counted
/// by streaming over the start (constant memory).
pub fn read_tail(path: &Path) -> io::Result<(Vec<u8>, u64)> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    if len <= READ_CAP {
        let mut buf = Vec::with_capacity(len as usize);
        f.read_to_end(&mut buf)?;
        return Ok((buf, 0));
    }
    let start = len - READ_CAP;
    let mut skipped_newlines = 0u64;
    let mut chunk = vec![0u8; 1024 * 1024];
    let mut left = start;
    while left > 0 {
        let want = left.min(chunk.len() as u64) as usize;
        let n = f.read(&mut chunk[..want])?;
        if n == 0 {
            break;
        }
        skipped_newlines += chunk[..n].iter().filter(|b| **b == b'\n').count() as u64;
        left -= n as u64;
    }
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(READ_CAP as usize);
    f.read_to_end(&mut buf)?;
    // Drop the partial first line (it belongs to the skipped part).
    let cut = buf.iter().position(|b| *b == b'\n').map_or(buf.len(), |p| p + 1);
    buf.drain(..cut);
    Ok((buf, skipped_newlines + 1))
}

/// One whole line: UTF-8 when valid, else Windows-1252 (the digest's rule).
fn decode_line(line: &[u8]) -> String {
    match std::str::from_utf8(line) {
        Ok(s) => s.to_owned(),
        Err(_) => encoding_rs::WINDOWS_1252.decode_without_bom_handling(line).0.into_owned(),
    }
}

/// Decode (UTF-8, else Windows-1252 per line, like the digest), scrub the home folder, and keep
/// the end within the limits. `skipped` lines were already left out by [`read_tail`].
pub fn prepare(bytes: &[u8], skipped: u64, scrubber: &HomeScrubber, max_bytes: usize, max_lines: usize) -> Prepared {
    let text = match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.split(|b| *b == b'\n').map(decode_line).collect::<Vec<_>>().join("\n"),
    };
    let text = scrubber.scrub(&text);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let read_lines = lines.len() as u64;
    let total = skipped + read_lines;
    // Keep lines from the end while they fit (one line and its bytes reserved for the note).
    let note_reserve = cut_note(total).len() + 1;
    let mut kept = 0usize;
    let mut bytes_used = 0usize;
    for l in lines.iter().rev() {
        let need = l.len() + 1;
        let cap_lines = if skipped > 0 || kept + 1 < lines.len() { max_lines.saturating_sub(1) } else { max_lines };
        if kept + 1 > cap_lines || bytes_used + need + note_reserve > max_bytes {
            break;
        }
        kept += 1;
        bytes_used += need;
    }
    // A single line longer than the limit: keep its end.
    let mut tail_of_line: Option<String> = None;
    if kept == 0 {
        if let Some(last) = lines.last() {
            let budget = max_bytes.saturating_sub(note_reserve + 1);
            let mut from = last.len().saturating_sub(budget);
            while !last.is_char_boundary(from) {
                from += 1;
            }
            tail_of_line = Some(last[from..].to_string());
        }
    }
    let left_out = total - kept as u64;
    let truncated = left_out > 0;
    let mut content = String::with_capacity(bytes_used + note_reserve + 1);
    if truncated {
        content.push_str(&cut_note(left_out));
        content.push('\n');
    }
    if let Some(t) = &tail_of_line {
        content.push_str(t);
        content.push('\n');
    } else {
        for l in &lines[lines.len() - kept..] {
            content.push_str(l);
            content.push('\n');
        }
    }
    let sent = if tail_of_line.is_some() { 1 } else { kept as u64 };
    Prepared {
        content,
        total_lines: u32::try_from(total).unwrap_or(u32::MAX),
        sent_lines: u32::try_from(sent).unwrap_or(u32::MAX),
        truncated,
    }
}

/// Upload failure, mapped to an `AppError` with a complete sentence.
#[derive(Debug, Clone, PartialEq)]
pub enum ShareError {
    /// No connection, DNS failure, connection refused.
    Offline,
    Timeout,
    RateLimited { retry_after_s: u32 },
    TooLarge,
    /// Another 4xx, with mclo.gs's own error text.
    Refused { status: u16, message: String },
    Server { status: u16 },
    /// An answer that is not the documented JSON, or an id that is not plain.
    BadAnswer,
    Empty,
}

impl From<ShareError> for AppError {
    fn from(e: ShareError) -> Self {
        let (kind, message, retry_after_s) = match e {
            ShareError::Offline => (
                ErrorKind::Offline,
                "Could not reach mclo.gs: this computer seems to be offline. Check the connection and try again; nothing was uploaded.".to_string(),
                None,
            ),
            ShareError::Timeout => (
                ErrorKind::Network,
                format!("mclo.gs did not answer within {} seconds. Try again later.", TIMEOUT.as_secs()),
                None,
            ),
            ShareError::RateLimited { retry_after_s } => (
                ErrorKind::RateLimited,
                format!("mclo.gs's rate limit was reached. Try again in {retry_after_s} seconds."),
                Some(retry_after_s),
            ),
            ShareError::TooLarge => (
                ErrorKind::Invalid,
                "mclo.gs refused the log as too large (HTTP 413). Nothing was uploaded.".to_string(),
                None,
            ),
            ShareError::Refused { status, message } => (
                ErrorKind::Network,
                if message.is_empty() {
                    format!("mclo.gs refused the upload (HTTP {status}). Nothing was uploaded.")
                } else {
                    format!("mclo.gs refused the upload (HTTP {status}: {message}). Nothing was uploaded.")
                },
                None,
            ),
            ShareError::Server { status } => (
                ErrorKind::Network,
                format!("mclo.gs had a server error (HTTP {status}). Try again later."),
                None,
            ),
            ShareError::BadAnswer => (
                ErrorKind::Network,
                "mclo.gs sent an answer Modpack Doctor could not read, so no link is available. Try again later.".to_string(),
                None,
            ),
            ShareError::Empty => (ErrorKind::Invalid, "The log file is empty, so there is nothing to share.".to_string(), None),
        };
        AppError { kind, message, path: None, retry_after_s }
    }
}

#[derive(Deserialize)]
struct Answer {
    success: Option<bool>,
    id: Option<String>,
    error: Option<String>,
}

/// A mclo.gs API client. Production uses [`MCLOGS_API`]; tests point it at a mock server.
#[derive(Clone)]
pub struct McLogs {
    http: reqwest::Client,
    api_base: String,
}

impl McLogs {
    pub fn new() -> Result<Self, AppError> {
        Self::with_base(MCLOGS_API, TIMEOUT)
    }

    pub fn with_base(api_base: &str, timeout: Duration) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .user_agent(crate::USER_AGENT)
            .timeout(timeout)
            .connect_timeout(timeout.min(Duration::from_secs(10)))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| AppError {
                kind: ErrorKind::Internal,
                message: format!("Internal error: the HTTP client could not start ({e}). Please report this."),
                path: None,
                retry_after_s: None,
            })?;
        Ok(Self { http, api_base: api_base.trim_end_matches('/').to_string() })
    }

    /// `POST /1/log`; on success the page and raw URLs of the new log.
    pub async fn upload(&self, content: &str) -> Result<(String, String), ShareError> {
        if content.trim().is_empty() {
            return Err(ShareError::Empty);
        }
        let res = self
            .http
            .post(format!("{}/1/log", self.api_base))
            .json(&serde_json::json!({ "content": content }))
            .send()
            .await
            .map_err(|e| if e.is_timeout() { ShareError::Timeout } else if e.is_connect() || e.is_request() { ShareError::Offline } else { ShareError::BadAnswer })?;
        let status = res.status().as_u16();
        let retry_after = res
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u32>().ok());
        let body = res.bytes().await.map_err(|e| if e.is_timeout() { ShareError::Timeout } else { ShareError::BadAnswer })?;
        let answer: Option<Answer> = serde_json::from_slice(&body[..body.len().min(64 * 1024)]).ok();
        match status {
            200..=299 => {
                let a = answer.ok_or(ShareError::BadAnswer)?;
                let id = a.id.filter(|id| a.success == Some(true) && valid_id(id)).ok_or(ShareError::BadAnswer)?;
                Ok((format!("https://mclo.gs/{id}"), format!("https://api.mclo.gs/1/raw/{id}")))
            }
            // Redirects are not followed (the page URLs are built from the id).
            300..=399 => Err(ShareError::BadAnswer),
            429 => Err(ShareError::RateLimited { retry_after_s: retry_after.unwrap_or(60).clamp(1, 3600) }),
            413 => Err(ShareError::TooLarge),
            400..=499 => Err(ShareError::Refused { status, message: clean_message(answer.and_then(|a| a.error).as_deref()) }),
            _ => Err(ShareError::Server { status }),
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_LEN && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// mclo.gs's error text, one short line without control characters, no trailing period.
fn clean_message(m: Option<&str>) -> String {
    let flat: String = m.unwrap_or("").chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = flat.chars().take(200).collect();
    cut.trim_end_matches('.').to_string()
}

/// Read, scrub and cut one file (already resolved through the PathGuard). Blocking.
pub fn prepare_file(path: &Path, home: Option<&str>) -> crate::error::Result<Prepared> {
    let (bytes, skipped) = read_tail(path).map_err(|e| crate::error::Error::io(path, e))?;
    Ok(prepare(&bytes, skipped, &HomeScrubber::new(home), MAX_BYTES, MAX_LINES))
}

/// Upload prepared text; the result the UI shows.
pub async fn upload_prepared(client: &McLogs, prepared: &Prepared) -> Result<SharedLog, AppError> {
    let (url, raw_url) = client.upload(&prepared.content).await?;
    Ok(SharedLog { url, raw_url, total_lines: prepared.total_lines, sent_lines: prepared.sent_lines, truncated: prepared.truncated })
}

/// [`prepare_file`] on a blocking thread, then [`upload_prepared`].
pub async fn share_file(client: &McLogs, path: &Path, home: Option<&str>) -> Result<SharedLog, AppError> {
    let owned = path.to_path_buf();
    let home = home.map(str::to_string);
    let prepared = tokio::task::spawn_blocking(move || prepare_file(&owned, home.as_deref()))
        .await
        .map_err(|e| AppError::from(crate::error::Error::Internal(format!("reading the log stopped ({e})"))))??;
    upload_prepared(client, &prepared).await
}
