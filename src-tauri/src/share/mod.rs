//! Share a log on mclo.gs (user-initiated, CONTRACTS invariant 10: `api.mclo.gs`).
//!
//! The webview sends only an instance id and a log source id (`share_log`). Rust resolves the
//! source exactly like `read_log_digest` (only ids `list_log_sources` returns, every file through
//! the PathGuard) and opens it under the scope lock. It then reads at most the last
//! [`READ_CAP`] bytes outside the lock. Before upload it:
//! - replaces the home folder with `~` ([`scrub::HomeScrubber`], the report rules);
//! - removes login tokens and the computer's user name ([`scrub::CredentialRedactor`]: the java
//!   command line in hs_err files and launcher logs carries `--accessToken`, `--uuid`, `--xuid`
//!   and `--clientId`, and hs_err lists `USERNAME=`);
//! - keeps the **end** of the log within mclo.gs's limits ([`MAX_BYTES`], [`MAX_LINES`]).
//!   mclo.gs itself would cut the end, which is where crashes are.
//!
//! The log is posted to `POST https://api.mclo.gs/1/log` as JSON `{"content": …}` with the app's
//! User-Agent. No redirect is followed. The returned page URLs are built from the returned id
//! (`https://mclo.gs/<id>`, `https://api.mclo.gs/1/raw/<id>`), never taken from the answer, so
//! the opener scope `https://mclo.gs/*` always covers them.
//!
//! The delete token in the answer is kept in this process's memory only, keyed by the log id,
//! and is never sent to the webview. `delete_shared_log(id)` uses it:
//! `DELETE https://api.mclo.gs/1/log/<id>` with `Authorization: Bearer <token>`.
//!
//! API (read 2026-11-08, https://api.mclo.gs/ and github.com/aternosorg/mclogs):
//! - limits: `maxLength` 10 485 760 bytes and `maxLines` 25 000 (`GET /1/limits`);
//! - rate limit: 60 requests per minute per IP (429);
//! - success: `{"success": true, "id", "url", "raw", "token", …}` ("The token provided in this
//!   response can be used to delete this log later");
//! - failure: `{"success": false, "error": "…"}`;
//! - deletion: `DELETE /1/log/<id>` with the bearer token, answered with `{"success": true}`
//!   or `{"success": false, "error": "Invalid token."}`.

pub mod scrub;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Deserialize;

use crate::error::{AppError, ErrorKind};
use crate::model::SharedLog;
use scrub::{CredentialRedactor, HomeScrubber};

/// The production API origin.
pub const MCLOGS_API: &str = "https://api.mclo.gs";
/// mclo.gs `maxLength` (bytes of `content`).
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
/// mclo.gs `maxLines`.
pub const MAX_LINES: usize = 25_000;
/// Bytes read from the end of the file: the limit plus room for what scrubbing removes.
pub const READ_CAP: u64 = 12 * 1024 * 1024;
/// Time to connect (DNS, TCP, TLS).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Whole-request time for a small body; [`request_timeout`] adds time for larger uploads.
pub const BASE_TIMEOUT: Duration = Duration::from_secs(30);
/// Upper bound of [`request_timeout`].
pub const MAX_TIMEOUT: Duration = Duration::from_secs(300);
/// Answers are small JSON; anything longer is not read.
pub const MAX_ANSWER_BYTES: usize = 64 * 1024;
/// mclo.gs ids are short alphanumeric strings (`WnMMikq`).
const MAX_ID_LEN: usize = 64;
/// Delete tokens longer than this, or with other than printable ASCII, are not kept.
const MAX_TOKEN_LEN: usize = 512;

/// Whole-request timeout for a body of `body_len` bytes: `base` plus 1 s per 256 KiB, at most
/// [`MAX_TIMEOUT`] (never less than `base`).
pub fn request_timeout(base: Duration, body_len: usize) -> Duration {
    let extra = Duration::from_secs((body_len / (256 * 1024)) as u64);
    (base + extra).min(MAX_TIMEOUT.max(base))
}

/// The end of a file as read by [`read_tail`].
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Tail {
    pub bytes: Vec<u8>,
    /// Whole lines before `bytes` that were not read.
    pub skipped_lines: u64,
    /// `bytes` starts in the middle of a line (one line longer than [`READ_CAP`]).
    pub first_line_cut: bool,
}

/// The text that will be uploaded, and what was left out.
#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    pub content: String,
    pub total_lines: u32,
    /// Lines of the file in `content` (the note line excluded; a line whose start was cut counts).
    pub sent_lines: u32,
    pub truncated: bool,
}

/// Note placed first when the start of the log was left out: `left_out` whole lines, and, when
/// `line_cut`, also the start of the first line below the note.
pub fn cut_note(left_out: u64, line_cut: bool) -> String {
    const LIMITS: &str = "to fit mclo.gs's limits (10 MiB, 25,000 lines). The end of the log is complete.";
    let lines = if left_out == 1 { "The first line of this log".to_string() } else { format!("The first {left_out} lines of this log") };
    match (left_out, line_cut) {
        (0, _) => format!("[Modpack Doctor] The start of the line below was left out {LIMITS}"),
        (_, false) => format!("[Modpack Doctor] {lines} {} left out {LIMITS}", if left_out == 1 { "was" } else { "were" }),
        (_, true) => format!("[Modpack Doctor] {lines} and the start of the line below were left out {LIMITS}"),
    }
}

/// Reads the end of an open file: at most [`READ_CAP`] bytes, even if the file grows while it is
/// read. When the file is longer, the partial first line is dropped and the lines before it are
/// counted by streaming over the start (constant memory, done outside the scope lock). When the
/// whole tail is one line (no line break in it), its end is kept and marked as cut.
pub fn read_tail(f: &mut File) -> io::Result<Tail> {
    let len = f.metadata()?.len();
    let mut buf = Vec::with_capacity(len.min(READ_CAP) as usize);
    if len <= READ_CAP {
        f.take(READ_CAP).read_to_end(&mut buf)?;
        return Ok(Tail { bytes: buf, skipped_lines: 0, first_line_cut: false });
    }
    let start = len - READ_CAP;
    let mut newlines = 0u64;
    let mut ends_with_newline = false;
    let mut chunk = vec![0u8; 1024 * 1024];
    let mut prefix = (&mut *f).take(start);
    loop {
        let n = prefix.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        newlines += chunk[..n].iter().filter(|b| **b == b'\n').count() as u64;
        ends_with_newline = chunk[n - 1] == b'\n';
    }
    f.seek(SeekFrom::Start(start))?;
    f.take(READ_CAP).read_to_end(&mut buf)?;
    if ends_with_newline {
        return Ok(Tail { bytes: buf, skipped_lines: newlines, first_line_cut: false });
    }
    // The first bytes belong to a line that started before `start`.
    match buf.iter().position(|b| *b == b'\n') {
        Some(p) if p + 1 < buf.len() => {
            buf.drain(..=p);
            Ok(Tail { bytes: buf, skipped_lines: newlines + 1, first_line_cut: false })
        }
        // One line longer than READ_CAP (maybe with its line break): keep its end.
        _ => Ok(Tail { bytes: buf, skipped_lines: newlines, first_line_cut: true }),
    }
}

/// One whole line: UTF-8 when valid, else Windows-1252 (the digest's rule).
fn decode_line(line: &[u8]) -> String {
    match std::str::from_utf8(line) {
        Ok(s) => s.to_owned(),
        Err(_) => encoding_rs::WINDOWS_1252.decode_without_bom_handling(line).0.into_owned(),
    }
}

/// Decode (UTF-8, else Windows-1252 per line, like the digest), scrub the home folder, remove
/// credentials, and keep the end within the limits.
pub fn prepare(tail: &Tail, scrubber: &HomeScrubber, redactor: &CredentialRedactor, max_bytes: usize, max_lines: usize) -> Prepared {
    let text = match std::str::from_utf8(&tail.bytes) {
        Ok(s) => s.to_string(),
        Err(_) => tail.bytes.split(|b| *b == b'\n').map(decode_line).collect::<Vec<_>>().join("\n"),
    };
    let text = redactor.redact(&scrubber.scrub(&text));
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let skipped = tail.skipped_lines;
    let total = skipped + lines.len() as u64;
    let all_bytes: usize = lines.iter().map(|l| l.len() + 1).sum();
    let fits_whole = skipped == 0 && !tail.first_line_cut && lines.len() <= max_lines && all_bytes <= max_bytes;

    let mut kept = lines.len();
    let mut tail_of_line: Option<String> = None;
    if !fits_whole {
        // A note goes first: reserve its line and its longest possible length.
        let budget = max_bytes.saturating_sub(cut_note(total, true).len() + 1);
        let cap_lines = max_lines.saturating_sub(1);
        kept = 0;
        let mut used = 0usize;
        for l in lines.iter().rev() {
            if kept + 1 > cap_lines || used + l.len() + 1 > budget {
                break;
            }
            kept += 1;
            used += l.len() + 1;
        }
        if kept == 0 {
            // The last line alone is longer than the limit: keep its end.
            if let Some(last) = lines.last() {
                let mut from = last.len().saturating_sub(budget.saturating_sub(1));
                while !last.is_char_boundary(from) {
                    from += 1;
                }
                tail_of_line = Some(last[from..].to_string());
            }
        }
    }

    let mut content = String::with_capacity(max_bytes.min(all_bytes + 256));
    let sent = if let Some(t) = &tail_of_line {
        content.push_str(&cut_note(total - 1, true));
        content.push('\n');
        content.push_str(t);
        content.push('\n');
        1
    } else {
        if !fits_whole {
            let first_kept_is_cut = tail.first_line_cut && kept == lines.len();
            let left_out = total - kept as u64;
            content.push_str(&cut_note(left_out, first_kept_is_cut));
            content.push('\n');
        }
        for l in &lines[lines.len() - kept..] {
            content.push_str(l);
            content.push('\n');
        }
        kept as u64
    };
    Prepared {
        content,
        total_lines: u32::try_from(total).unwrap_or(u32::MAX),
        sent_lines: u32::try_from(sent).unwrap_or(u32::MAX),
        truncated: !fits_whole,
    }
}

/// Upload or delete failure, mapped to an `AppError` with a complete sentence.
#[derive(Debug, Clone, PartialEq)]
pub enum ShareError {
    /// No connection could be made (DNS failure, connection refused): nothing was sent.
    Offline,
    /// No complete answer in time: the request may have arrived.
    Timeout,
    /// The connection broke off after it was made: the request may have arrived.
    Interrupted,
    RateLimited { retry_after_s: u32 },
    TooLarge,
    /// Another 4xx, with mclo.gs's own error text.
    Refused { status: u16, message: String },
    Server { status: u16 },
    /// An answer that is not the documented JSON, or an id that is not plain.
    BadAnswer,
    Empty,
    /// `delete_shared_log` for a log this app run did not upload (no delete token).
    NoToken,
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
                "mclo.gs did not answer in time. The log may have been uploaded anyway, but no link is available; try again later.".to_string(),
                None,
            ),
            ShareError::Interrupted => (
                ErrorKind::Network,
                "The connection to mclo.gs broke off during the upload. The log may have been uploaded anyway, but no link is available; try again.".to_string(),
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
            ShareError::NoToken => (ErrorKind::NotFound, no_token_message(), None),
        };
        AppError { kind, message, path: None, retry_after_s }
    }
}

fn no_token_message() -> String {
    "Modpack Doctor can only delete logs it uploaded since it was started, and it has no delete key for this one. mclo.gs removes logs on its own after 90 days.".to_string()
}

/// A failed `delete_shared_log`, in deletion words (the upload sentences would be wrong here).
pub fn delete_error(e: ShareError) -> AppError {
    let (kind, message, retry_after_s) = match e {
        ShareError::Offline => (
            ErrorKind::Offline,
            "Could not reach mclo.gs: this computer seems to be offline, so the log is still online. Try again when connected.".to_string(),
            None,
        ),
        ShareError::Timeout | ShareError::Interrupted | ShareError::BadAnswer => (
            ErrorKind::Network,
            "mclo.gs did not confirm the deletion, so the log may still be online. Open the link to check, and try again if it is there.".to_string(),
            None,
        ),
        ShareError::RateLimited { retry_after_s } => (
            ErrorKind::RateLimited,
            format!("mclo.gs's rate limit was reached, so the log is still online. Try again in {retry_after_s} seconds."),
            Some(retry_after_s),
        ),
        ShareError::Refused { status, message } => (
            ErrorKind::Network,
            if message.is_empty() {
                format!("mclo.gs refused to delete the log (HTTP {status}), so it is still online.")
            } else {
                format!("mclo.gs refused to delete the log (HTTP {status}: {message}), so it is still online.")
            },
            None,
        ),
        ShareError::Server { status } => (
            ErrorKind::Network,
            format!("mclo.gs had a server error (HTTP {status}) while deleting the log, so it may still be online. Try again later."),
            None,
        ),
        ShareError::TooLarge | ShareError::Empty => (ErrorKind::Internal, "Internal error: the delete request was malformed. Please report this.".to_string(), None),
        ShareError::NoToken => (ErrorKind::NotFound, no_token_message(), None),
    };
    AppError { kind, message, path: None, retry_after_s }
}

#[derive(Deserialize)]
struct Answer {
    success: Option<bool>,
    id: Option<String>,
    error: Option<String>,
    token: Option<String>,
}

/// A successful upload: the page and raw URLs, and the delete token if mclo.gs sent a usable one.
#[derive(Debug, Clone, PartialEq)]
pub struct Uploaded {
    pub id: String,
    pub url: String,
    pub raw_url: String,
    pub token: Option<String>,
}

/// Delete tokens of the logs uploaded during this app run, by log id. Never persisted and never
/// sent to the webview.
static DELETE_TOKENS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn remember_token(id: &str, token: &str) {
    if let Ok(mut t) = DELETE_TOKENS.lock() {
        t.insert(id.to_string(), token.to_string());
    }
}

fn token_for(id: &str) -> Option<String> {
    DELETE_TOKENS.lock().ok().and_then(|t| t.get(id).cloned())
}

fn forget_token(id: &str) {
    if let Ok(mut t) = DELETE_TOKENS.lock() {
        t.remove(id);
    }
}

/// True when a delete token is kept for `id` (tests).
#[cfg(test)]
pub fn has_delete_token(id: &str) -> bool {
    token_for(id).is_some()
}

/// A mclo.gs API client. Production uses [`MCLOGS_API`]; tests point it at a mock server.
#[derive(Clone)]
pub struct McLogs {
    http: reqwest::Client,
    api_base: String,
    base_timeout: Duration,
}

/// A send error: connecting failed (nothing sent), the time ran out, or the connection broke.
fn send_error(e: &reqwest::Error) -> ShareError {
    if e.is_timeout() {
        ShareError::Timeout
    } else if e.is_connect() {
        ShareError::Offline
    } else {
        ShareError::Interrupted
    }
}

/// Reads at most [`MAX_ANSWER_BYTES`] of the answer body.
async fn read_answer(mut res: reqwest::Response) -> Result<Vec<u8>, ShareError> {
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| send_error(&e))? {
        let room = MAX_ANSWER_BYTES - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= MAX_ANSWER_BYTES {
            break;
        }
    }
    Ok(body)
}

impl McLogs {
    pub fn new() -> Result<Self, AppError> {
        Self::with_base(MCLOGS_API, BASE_TIMEOUT)
    }

    /// `base_timeout`: the whole-request time for a small body (see [`request_timeout`]).
    pub fn with_base(api_base: &str, base_timeout: Duration) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .user_agent(crate::USER_AGENT)
            .connect_timeout(base_timeout.min(CONNECT_TIMEOUT))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| AppError {
                kind: ErrorKind::Internal,
                message: format!("Internal error: the HTTP client could not start ({e}). Please report this."),
                path: None,
                retry_after_s: None,
            })?;
        Ok(Self { http, api_base: api_base.trim_end_matches('/').to_string(), base_timeout })
    }

    /// `POST /1/log`; on success the id, page and raw URLs of the new log, and its delete token.
    pub async fn upload(&self, content: &str) -> Result<Uploaded, ShareError> {
        if content.trim().is_empty() {
            return Err(ShareError::Empty);
        }
        let body = serde_json::json!({ "content": content });
        let res = self
            .http
            .post(format!("{}/1/log", self.api_base))
            .timeout(request_timeout(self.base_timeout, content.len()))
            .json(&body)
            .send()
            .await
            .map_err(|e| send_error(&e))?;
        let status = res.status().as_u16();
        let retry_after = retry_after(&res);
        let body = read_answer(res).await?;
        let answer: Option<Answer> = serde_json::from_slice(&body).ok();
        match status {
            200..=299 => {
                let a = answer.ok_or(ShareError::BadAnswer)?;
                let id = a.id.filter(|id| a.success == Some(true) && valid_id(id)).ok_or(ShareError::BadAnswer)?;
                let token = a.token.filter(|t| valid_token(t));
                Ok(Uploaded { url: format!("https://mclo.gs/{id}"), raw_url: format!("https://api.mclo.gs/1/raw/{id}"), id, token })
            }
            // Redirects are not followed (the page URLs are built from the id).
            300..=399 => Err(ShareError::BadAnswer),
            429 => Err(ShareError::RateLimited { retry_after_s: retry_after.unwrap_or(60).clamp(1, 3600) }),
            413 => Err(ShareError::TooLarge),
            400..=499 => Err(ShareError::Refused { status, message: clean_message(answer.and_then(|a| a.error).as_deref()) }),
            _ => Err(ShareError::Server { status }),
        }
    }

    /// `DELETE /1/log/<id>` with the delete token as bearer. A log mclo.gs no longer has (404)
    /// counts as deleted.
    pub async fn delete(&self, id: &str, token: &str) -> Result<(), ShareError> {
        if !valid_id(id) || !valid_token(token) {
            return Err(ShareError::NoToken);
        }
        let res = self
            .http
            .delete(format!("{}/1/log/{id}", self.api_base))
            .timeout(self.base_timeout)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| send_error(&e))?;
        let status = res.status().as_u16();
        let retry_after = retry_after(&res);
        let body = read_answer(res).await?;
        let answer: Option<Answer> = serde_json::from_slice(&body).ok();
        match status {
            200..=299 => match answer {
                Some(a) if a.success == Some(true) => Ok(()),
                Some(a) => Err(ShareError::Refused { status, message: clean_message(a.error.as_deref()) }),
                None => Err(ShareError::BadAnswer),
            },
            404 => Ok(()),
            300..=399 => Err(ShareError::BadAnswer),
            429 => Err(ShareError::RateLimited { retry_after_s: retry_after.unwrap_or(60).clamp(1, 3600) }),
            400..=499 => Err(ShareError::Refused { status, message: clean_message(answer.and_then(|a| a.error).as_deref()) }),
            _ => Err(ShareError::Server { status }),
        }
    }
}

fn retry_after(res: &reqwest::Response) -> Option<u32> {
    res.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u32>().ok())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_LEN && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn valid_token(t: &str) -> bool {
    !t.is_empty() && t.len() <= MAX_TOKEN_LEN && t.bytes().all(|b| b.is_ascii_graphic())
}

/// mclo.gs's error text, one short line without control characters, no trailing period.
fn clean_message(m: Option<&str>) -> String {
    let flat: String = m.unwrap_or("").chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = flat.chars().take(200).collect();
    cut.trim_end_matches('.').to_string()
}

/// The computer's user names to remove: the home folder's last part and the user name
/// environment variables of this process.
pub fn local_user_names(home: Option<&str>) -> Vec<String> {
    let mut names: Vec<String> = scrub::home_user_name(home).into_iter().collect();
    for var in ["USERNAME", "USER", "LOGNAME"] {
        if let Ok(v) = std::env::var(var) {
            names.push(v);
        }
    }
    names
}

/// Read, scrub, redact and cut one open file (already resolved through the PathGuard). Blocking.
pub fn prepare_open_file(file: &mut File, path: &Path, home: Option<&str>, user_names: &[String]) -> crate::error::Result<Prepared> {
    let tail = read_tail(file).map_err(|e| crate::error::Error::io(path, e))?;
    Ok(prepare(&tail, &HomeScrubber::new(home), &CredentialRedactor::new(user_names), MAX_BYTES, MAX_LINES))
}

/// [`prepare_open_file`] for a path. Blocking.
pub fn prepare_file(path: &Path, home: Option<&str>, user_names: &[String]) -> crate::error::Result<Prepared> {
    let mut f = File::open(path).map_err(|e| crate::error::Error::io(path, e))?;
    prepare_open_file(&mut f, path, home, user_names)
}

/// Upload prepared text and keep its delete token; the result the UI shows.
pub async fn upload_prepared(client: &McLogs, prepared: &Prepared) -> Result<SharedLog, AppError> {
    let up = client.upload(&prepared.content).await?;
    if let Some(token) = &up.token {
        remember_token(&up.id, token);
    }
    Ok(SharedLog { url: up.url, raw_url: up.raw_url, total_lines: prepared.total_lines, sent_lines: prepared.sent_lines, truncated: prepared.truncated })
}

/// Deletes a log this app run uploaded, with its kept token; the token is forgotten on success.
pub async fn delete_uploaded(client: &McLogs, id: &str) -> Result<(), AppError> {
    let token = token_for(id).ok_or_else(|| delete_error(ShareError::NoToken))?;
    client.delete(id, &token).await.map_err(delete_error)?;
    forget_token(id);
    Ok(())
}

/// [`prepare_file`] on a blocking thread, then [`upload_prepared`].
pub async fn share_file(client: &McLogs, path: &Path, home: Option<&str>, user_names: &[String]) -> Result<SharedLog, AppError> {
    let owned = path.to_path_buf();
    let home = home.map(str::to_string);
    let names = user_names.to_vec();
    let prepared = tokio::task::spawn_blocking(move || prepare_file(&owned, home.as_deref(), &names))
        .await
        .map_err(|e| AppError::from(crate::error::Error::Internal(format!("reading the log stopped ({e})"))))??;
    upload_prepared(client, &prepared).await
}
