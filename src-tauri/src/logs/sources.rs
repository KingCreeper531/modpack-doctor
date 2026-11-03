//! The log files of an instance (`list_log_sources`) and the digest behind `read_log_digest`.
//!
//! Sources, all relative to the game dir: `crash-reports/*.txt` (vanilla, `-fml.txt`,
//! `-quilt_loader.txt`), `logs/latest.log`, `logs/debug.log` and `hs_err_pid*.log`. Ids are
//! those relative paths with `/` separators. The list is newest first (ties by id); entries
//! that cannot be read (stat fails, not a regular file, non-UTF-8 or unsafe names) are skipped.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::logs::digest::{clamp_options, default_options, read_digest};
use crate::model::{DigestOptions, LogDigest, LogKind, LogSource};

pub const CRASH_DIR: &str = "crash-reports";
pub const LOGS_DIR: &str = "logs";
pub const LATEST_LOG: &str = "logs/latest.log";
pub const DEBUG_LOG: &str = "logs/debug.log";

/// `crash-*.txt` and any other `.txt` in `crash-reports/`.
pub fn is_crash_report_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".txt")
}

/// `hs_err_pid<pid>.log` in the game dir.
pub fn is_hs_err_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("hs_err_pid") && lower.ends_with(".log")
}

/// Ids (and kinds) of the crash files currently present: crash reports and hs_err logs.
/// Directory listing only (no stat of each file beyond its type), for watch mode's diffing.
pub fn crash_file_ids(game_dir: &Path) -> BTreeMap<String, LogKind> {
    let mut out = BTreeMap::new();
    for name in file_names(&game_dir.join(CRASH_DIR)) {
        if is_crash_report_name(&name) {
            out.insert(format!("{CRASH_DIR}/{name}"), LogKind::CrashReport);
        }
    }
    for name in file_names(game_dir) {
        if is_hs_err_name(&name) {
            out.insert(name, LogKind::HsErr);
        }
    }
    out
}

/// UTF-8 names of the regular files (symlinks followed) in `dir`; empty if unreadable.
fn file_names(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    rd.flatten()
        .filter(|e| match e.file_type() {
            Ok(t) if t.is_file() => true,
            Ok(t) if t.is_symlink() => e.path().is_file(),
            _ => false,
        })
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
}

/// Stat one source; `None` if it is missing, not a file, or its id is not a safe relative path.
pub fn source_for(game_dir: &Path, id: &str, kind: LogKind) -> Option<LogSource> {
    let path = PathGuard::join_relative(game_dir, id).ok()?;
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    Some(LogSource { id: id.to_string(), kind, modified_ms, size: meta.len() })
}

/// Every log source in `game_dir`, newest first (ties by id).
pub fn list_log_sources(game_dir: &Path) -> Vec<LogSource> {
    let mut ids: Vec<(String, LogKind)> = crash_file_ids(game_dir).into_iter().collect();
    ids.push((LATEST_LOG.to_string(), LogKind::LatestLog));
    ids.push((DEBUG_LOG.to_string(), LogKind::DebugLog));
    let mut out: Vec<LogSource> = ids.into_iter().filter_map(|(id, kind)| source_for(game_dir, &id, kind)).collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.id.cmp(&b.id)));
    out
}

/// [`list_log_sources`] limited to files the PathGuard allows (the game dir itself must be in
/// scope; a symlinked `crash-reports/` or `logs/` resolves into its registered target root).
pub fn list_log_sources_guarded(guard: &PathGuard, game_dir: &Path) -> Result<Vec<LogSource>> {
    guard.check_existing(game_dir)?;
    Ok(list_log_sources(game_dir)
        .into_iter()
        .filter(|s| PathGuard::join_relative(game_dir, &s.id).and_then(|p| guard.check_existing(&p)).is_ok())
        .collect())
}

/// `read_log_digest`: accepts only an id that [`list_log_sources_guarded`] currently returns,
/// resolves it through the PathGuard, and streams a digest with clamped options.
pub fn read_source_digest(
    guard: &PathGuard,
    game_dir: &Path,
    source_id: &str,
    anchors: &[String],
    options: Option<DigestOptions>,
) -> Result<LogDigest> {
    // Escaping or malformed ids fail here with OutsideScope before anything is listed.
    let joined = PathGuard::join_relative(game_dir, source_id)?;
    let source = list_log_sources_guarded(guard, game_dir)?
        .into_iter()
        .find(|s| s.id == source_id)
        .ok_or_else(|| Error::NotFound {
            path: format!("the log file \"{source_id}\" in this instance (refresh the list of logs and try again)"),
        })?;
    let path = guard.check_existing(&joined)?;
    let opts = clamp_options(&options.unwrap_or_else(default_options));
    read_digest(&path, source, anchors, &opts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn write_at(path: &Path, body: &str, secs_ago: u64) {
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(path, body).expect("write");
        let t = SystemTime::now() - Duration::from_secs(secs_ago);
        fs::File::options().write(true).open(path).expect("open").set_modified(t).expect("mtime");
    }

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, PathGuard) {
        let t = tempfile::tempdir().expect("tempdir");
        let game = dunce::canonicalize(t.path()).expect("canon").join("Pack");
        write_at(&game.join("crash-reports/crash-2026-11-01_10.00.00-client.txt"), "---- Minecraft Crash Report ----\n", 300);
        write_at(&game.join("crash-reports/crash-2026-11-02_10.00.00-fml.txt"), "fml\n", 200);
        write_at(&game.join("crash-reports/notes.md"), "ignored\n", 1);
        write_at(&game.join("logs/latest.log"), "[main/INFO]: hi\nIncompatible mods found!\n", 10);
        write_at(&game.join("logs/debug.log"), "debug\n", 20);
        write_at(&game.join("logs/2026-11-01-1.log.gz"), "gz", 5);
        write_at(&game.join("hs_err_pid1234.log"), "# A fatal error\n", 100);
        write_at(&game.join("options.txt"), "x", 0);
        fs::create_dir_all(game.join("crash-reports/sub.txt")).expect("dir named .txt");
        let guard = PathGuard::new();
        guard.add_root(&game).expect("root");
        (t, game, guard)
    }

    #[test]
    fn lists_sources_newest_first_with_relative_ids() {
        let (_t, game, guard) = fixture();
        let list = list_log_sources_guarded(&guard, &game).expect("list");
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "logs/latest.log",
                "logs/debug.log",
                "hs_err_pid1234.log",
                "crash-reports/crash-2026-11-02_10.00.00-fml.txt",
                "crash-reports/crash-2026-11-01_10.00.00-client.txt",
            ]
        );
        let kinds: Vec<LogKind> = list.iter().map(|s| s.kind).collect();
        assert_eq!(
            kinds,
            vec![LogKind::LatestLog, LogKind::DebugLog, LogKind::HsErr, LogKind::CrashReport, LogKind::CrashReport]
        );
        assert!(list.iter().all(|s| s.size > 0 && s.modified_ms > 0));
    }

    #[test]
    fn missing_folders_give_an_empty_list() {
        let t = tempfile::tempdir().expect("tempdir");
        let guard = PathGuard::new();
        guard.add_root(t.path()).expect("root");
        assert!(list_log_sources_guarded(&guard, t.path()).expect("list").is_empty());
    }

    #[test]
    fn game_dir_outside_scope_is_rejected() {
        let (_t, game, _guard) = fixture();
        let empty = PathGuard::new();
        assert!(matches!(list_log_sources_guarded(&empty, &game), Err(Error::OutsideScope { .. })));
    }

    #[test]
    fn digest_of_a_listed_source() {
        let (_t, game, guard) = fixture();
        let d = read_source_digest(&guard, &game, "logs/latest.log", &["Incompatible mods found!".into()], None)
            .expect("digest");
        assert_eq!(d.source.id, "logs/latest.log");
        assert_eq!(d.total_lines, 2);
    }

    #[test]
    fn unknown_and_escaping_ids_are_rejected() {
        let (t, game, guard) = fixture();
        fs::write(t.path().join("secret.txt"), "s").expect("write");
        for bad in ["../secret.txt", "/etc/passwd", "C:/Windows/win.ini", "crash-reports/../../secret.txt", ""] {
            let err = read_source_digest(&guard, &game, bad, &[], None).expect_err(bad);
            assert!(matches!(err, Error::OutsideScope { .. }), "{bad}: {err}");
        }
        for unknown in ["options.txt", "crash-reports/notes.md", "logs/2026-11-01-1.log.gz", "logs/nope.log"] {
            let err = read_source_digest(&guard, &game, unknown, &[], None).expect_err(unknown);
            assert!(matches!(err, Error::NotFound { .. }), "{unknown}: {err}");
            assert!(err.to_string().contains("refresh the list of logs"), "{err}");
        }
        // Windows separators are not the id format.
        assert!(read_source_digest(&guard, &game, "logs\\latest.log", &[], None).is_err());
    }

    #[test]
    fn options_are_clamped() {
        let (_t, game, guard) = fixture();
        let huge = DigestOptions { head: u32::MAX, tail: u32::MAX, context: u32::MAX, max_lines: u32::MAX, max_line_chars: u32::MAX };
        assert!(read_source_digest(&guard, &game, "logs/debug.log", &[], Some(huge)).is_ok());
    }
}
