//! `save_report` (M7, CONTRACTS.md invariant 16): the native save dialog with a sanitized default
//! name, the format's extension enforced, contents capped, written as temp file + rename in the
//! folder the user chose. That file is the one write outside PathGuard roots, allowed because
//! the user picked it in a native dialog; nothing else is written there.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::model::ReportFormat;

use super::instances::blocking;
use super::Cmd;

/// Largest report written (bytes of UTF-8).
pub const MAX_REPORT_BYTES: usize = 16 * 1024 * 1024;
/// Longest default file name offered, extension included (characters).
pub const MAX_NAME_CHARS: usize = 120;
/// Used when nothing usable is left of the requested name.
const FALLBACK_STEM: &str = "modpack-doctor-report";

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "CONIN$", "CONOUT$",
];

/// The file extension of a format, without the dot.
pub fn extension(format: ReportFormat) -> &'static str {
    match format {
        ReportFormat::Markdown => "md",
        ReportFormat::Json => "json",
    }
}

/// The default file name offered in the save dialog: path separators and characters Windows
/// forbids become `-`, control characters are dropped, leading/trailing dots and spaces are
/// trimmed, a Windows reserved name (`CON`, `nul.txt`, …) gets a `report-` prefix, the result is
/// at most [`MAX_NAME_CHARS`] characters and always ends in the format's extension.
pub fn default_file_name(requested: &str, format: ReportFormat) -> String {
    let ext = extension(format);
    let mapped: String = requested
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*') { '-' } else { c })
        .collect();
    let trim = |s: &str| s.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    let mut stem = trim(&mapped);
    // Don't double the extension the caller may already have added.
    let dotted = format!(".{ext}");
    if stem.len() > dotted.len() && stem.is_char_boundary(stem.len() - dotted.len()) {
        let cut = stem.len() - dotted.len();
        if stem[cut..].eq_ignore_ascii_case(&dotted) {
            stem = trim(&stem[..cut]);
        }
    }
    let first = stem.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    if RESERVED.contains(&first.as_str()) {
        stem = format!("report-{stem}");
    }
    let max_stem = MAX_NAME_CHARS - dotted.chars().count();
    if stem.chars().count() > max_stem {
        stem = trim(&stem.chars().take(max_stem).collect::<String>());
    }
    if stem.is_empty() {
        stem = FALLBACK_STEM.to_string();
    }
    let name = format!("{stem}{dotted}");
    // Belt and braces: the name must be one component PathGuard would accept.
    if name.contains(['/', '\\']) || PathGuard::join_relative(Path::new(""), &name).is_err() {
        return format!("{FALLBACK_STEM}{dotted}");
    }
    name
}

/// `path` with the format's extension: kept when it already has it (any case), else appended
/// (`notes.txt` → `notes.txt.md`).
pub fn enforce_extension(path: PathBuf, format: ReportFormat) -> PathBuf {
    let ext = extension(format);
    if path.extension().is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case(ext)) {
        return path;
    }
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".{ext}"));
    path.with_file_name(name)
}

/// Write `contents` to `dest`: a new temp file in the same folder, fsync, then rename onto
/// `dest`. An existing `dest` is replaced only when `may_replace` (the user confirmed it in the
/// save dialog); a folder never is. The temp file is removed on any failure.
pub fn write_report(dest: &Path, contents: &[u8], may_replace: bool) -> Result<PathBuf> {
    if contents.len() > MAX_REPORT_BYTES {
        return Err(Error::Invalid(format!("the report is larger than {} MiB", MAX_REPORT_BYTES / (1024 * 1024))));
    }
    let shown = dest.display().to_string();
    let dir = match dest.parent() {
        Some(d) if !d.as_os_str().is_empty() && dest.file_name().is_some() => d,
        _ => return Err(Error::Invalid(format!("{shown} is not a file path"))),
    };
    match fs::symlink_metadata(dest) {
        Ok(m) if m.is_dir() => return Err(Error::Invalid(format!("{shown} is a folder; choose a file name"))),
        Ok(_) if !may_replace => {
            return Err(Error::Conflict(format!("{shown} already exists. Save the report again and choose another name.")))
        }
        _ => {}
    }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut temp = None;
    for attempt in 0..16u32 {
        let candidate = dir.join(format!(".modpack-doctor-report-{nonce:x}-{attempt}.tmp"));
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(f) => {
                temp = Some((candidate, f));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(Error::io(dir, e)),
        }
    }
    let Some((temp_path, mut file)) = temp else {
        return Err(Error::Internal(format!("no free temporary file name in {}", dir.display())));
    };
    let written = file.write_all(contents).and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = written.and_then(|()| fs::rename(&temp_path, dest)) {
        let _ = fs::remove_file(&temp_path);
        return Err(Error::io(dest, e));
    }
    Ok(dest.to_path_buf())
}

/// Native save dialog, async-safe (callback + oneshot). None = cancelled.
async fn pick_save_path<R: Runtime>(app: &AppHandle<R>, name: &str, format: ReportFormat) -> Result<Option<PathBuf>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let label = match format {
        ReportFormat::Markdown => "Markdown",
        ReportFormat::Json => "JSON",
    };
    let mut dialog = app.dialog().file().set_title("Save report").set_file_name(name).add_filter(label, &[extension(format)]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx.await.map_err(|_| Error::Internal("the save dialog closed unexpectedly".into()))?;
    match picked {
        None => Ok(None),
        Some(p) => p
            .into_path()
            .map(Some)
            .map_err(|e| Error::Invalid(format!("the chosen location is not a local file ({e})"))),
    }
}

/// Rust opens the save dialog; returns the saved path, or None if cancelled.
#[tauri::command]
#[specta::specta]
pub async fn save_report(
    app: AppHandle,
    default_name: String,
    format: ReportFormat,
    contents: String,
) -> Cmd<Option<String>> {
    if contents.len() > MAX_REPORT_BYTES {
        let msg = format!("the report is larger than {} MiB, so it was not saved", MAX_REPORT_BYTES / (1024 * 1024));
        return Err(Error::Invalid(msg).into());
    }
    let name = default_file_name(&default_name, format);
    let Some(picked) = pick_save_path(&app, &name, format).await? else {
        return Ok(None);
    };
    // The dialog confirmed replacing `picked` itself; a name we had to extend was not confirmed.
    let dest = enforce_extension(picked.clone(), format);
    let may_replace = dest == picked;
    let saved = blocking(move || write_report(&dest, contents.as_bytes(), may_replace)).await?;
    Ok(Some(saved.display().to_string()))
}

#[cfg(test)]
mod tests;
