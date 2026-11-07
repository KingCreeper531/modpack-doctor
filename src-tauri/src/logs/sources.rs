//! The log files of an instance (`list_log_sources`) and the digest behind `read_log_digest`.
//!
//! Sources relative to the game dir: `crash-reports/crash-*.txt` (vanilla `-client` /
//! `-server`, `-fml.txt`, `-quilt_loader.txt`), `logs/latest.log`, `logs/debug.log` and
//! `hs_err_pid*.log`. Their ids are those relative paths with `/` separators.
//!
//! **hs_err files outside the game dir.** The JVM writes `hs_err_pid<pid>.log` into its
//! *working dir*, which is not always the game dir: the vanilla launcher starts every profile in
//! `.minecraft` and points `--gameDir` at the profile's folder. Such files get the id
//! `@cwd/hs_err_pid<pid>.log` ([`CWD_PREFIX`]). A relative game-dir id never starts with `@`, so
//! the two forms cannot collide. An `@cwd/` id is valid only in exactly that form (decimal pid,
//! no leading zero, nothing else), and names a file directly in one of the instance's known
//! working dirs ([`CwdHints`]):
//! - a working dir recorded by watch mode for a Java process of this instance, and then only the
//!   file for that process's pid;
//! - a shared launcher working dir, and then only files whose `Command Line:` summary names
//!   this game dir with `--gameDir` (files naming no known instance are listed for none):
//!   for vanilla instances the launcher's `.minecraft` (when it is itself a discovered
//!   instance), for CurseForge instances the shared `Install` folder (a PathGuard hs_err dir,
//!   not a root: only `hs_err_pid<pid>.log` files directly in it are readable).
//!
//! Every file (in the game dir or not) must pass `PathGuard::check_existing` (symlinks
//! followed: inside a root, or an hs_err file directly in an hs_err dir), so a working dir
//! outside every root is never listed and a symlink escaping the roots is refused.
//!
//! The list is newest first (ties by id); entries that cannot be read (stat fails, not a
//! regular file, non-UTF-8 or unsafe names) are skipped.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::logs::digest::{clamp_options, default_options, read_digest};
use crate::model::{DigestOptions, LogDigest, LogKind, LogSource};
use crate::process;

pub const CRASH_DIR: &str = "crash-reports";
pub const LOGS_DIR: &str = "logs";
pub const LATEST_LOG: &str = "logs/latest.log";
pub const DEBUG_LOG: &str = "logs/debug.log";
/// Id prefix of an hs_err file in the JVM's working dir outside the game dir.
pub const CWD_PREFIX: &str = "@cwd/";
/// Bytes of an hs_err file searched for its `Command Line:` summary line.
const HS_ERR_HEAD_BYTES: u64 = 256 * 1024;

/// `crash-*.txt`: what vanilla, Forge/NeoForge (`-fml`) and Quilt (`-quilt_loader`) write into
/// `crash-reports/`. Other `.txt` files there are not crash reports.
pub fn is_crash_report_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("crash-") && lower.ends_with(".txt")
}

/// `hs_err_pid<pid>.log` in the game dir.
pub fn is_hs_err_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("hs_err_pid") && lower.ends_with(".log")
}

/// The pid of a file named exactly `hs_err_pid<pid>.log` (as HotSpot writes it: decimal, no
/// leading zero).
pub fn hs_err_pid(name: &str) -> Option<u32> {
    let digits = name.strip_prefix("hs_err_pid")?.strip_suffix(".log")?;
    let canonical = !digits.is_empty()
        && digits.len() <= 10
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'));
    if canonical {
        digits.parse().ok()
    } else {
        None
    }
}

/// The id of `hs_err_pid<pid>.log` in a working dir outside the game dir.
pub fn cwd_hs_err_id(pid: u32) -> String {
    format!("{CWD_PREFIX}hs_err_pid{pid}.log")
}

/// The pid named by a well-formed `@cwd/hs_err_pid<pid>.log` id; `None` for anything else.
pub fn parse_cwd_id(id: &str) -> Option<u32> {
    hs_err_pid(id.strip_prefix(CWD_PREFIX)?)
}

/// Working dirs outside the game dir where this instance's JVM may have written hs_err files
/// (see the module docs).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CwdHints {
    /// (pid, working dir) of Java processes of this instance, as watch mode saw them.
    pub pids: Vec<(u32, PathBuf)>,
    /// Launcher working dirs shared by several instances (vanilla `.minecraft`, CurseForge
    /// `Install`); their hs_err files are attributed by `--gameDir`.
    pub launcher_dirs: Vec<PathBuf>,
}

impl CwdHints {
    pub fn is_empty(&self) -> bool {
        self.pids.is_empty() && self.launcher_dirs.is_empty()
    }
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

/// Stat the file at `path` as the source `id`; `None` if it is missing or not a regular file.
pub fn source_at(path: &Path, id: &str, kind: LogKind) -> Option<LogSource> {
    let meta = fs::metadata(path).ok()?;
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

/// Stat one source; `None` if it is missing, not a file, or its id is not a safe relative path.
pub fn source_for(game_dir: &Path, id: &str, kind: LogKind) -> Option<LogSource> {
    let path = PathGuard::join_relative(game_dir, id).ok()?;
    source_at(&path, id, kind)
}

/// Every log source in `game_dir`, newest first (ties by id). Not guarded; see
/// [`list_log_sources_guarded`].
pub fn list_log_sources(game_dir: &Path) -> Vec<LogSource> {
    let mut out: Vec<LogSource> = game_dir_sources(game_dir).into_iter().map(|(s, _)| s).collect();
    sort_sources(&mut out);
    out
}

fn sort_sources(list: &mut [LogSource]) {
    list.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.id.cmp(&b.id)));
}

/// (source, path) for every source in the game dir.
fn game_dir_sources(game_dir: &Path) -> Vec<(LogSource, PathBuf)> {
    let mut ids: Vec<(String, LogKind)> = crash_file_ids(game_dir).into_iter().collect();
    ids.push((LATEST_LOG.to_string(), LogKind::LatestLog));
    ids.push((DEBUG_LOG.to_string(), LogKind::DebugLog));
    ids.into_iter()
        .filter_map(|(id, kind)| {
            let path = PathGuard::join_relative(game_dir, &id).ok()?;
            Some((source_at(&path, &id, kind)?, path))
        })
        .collect()
}

/// (source, path) for the `@cwd/` hs_err files that `hints` allow and the guard accepts.
/// A dir that is the game dir itself is skipped (its files have plain ids). On an id clash
/// the newest file wins.
fn cwd_sources(guard: &PathGuard, game_dir: &Path, hints: &CwdHints) -> Vec<(LogSource, PathBuf)> {
    let mut by_id: HashMap<String, (LogSource, PathBuf)> = HashMap::new();
    let mut add = |pid: u32, dir: &Path, needs_command_line: bool| {
        let path = dir.join(format!("hs_err_pid{pid}.log"));
        let Ok(resolved) = guard.check_existing(&path) else { return };
        if needs_command_line && !hs_err_names_game_dir(&resolved, dir, game_dir) {
            return;
        }
        let id = cwd_hs_err_id(pid);
        let Some(src) = source_at(&resolved, &id, LogKind::HsErr) else { return };
        match by_id.get(&id) {
            Some((old, _)) if old.modified_ms >= src.modified_ms => {}
            _ => {
                by_id.insert(id, (src, resolved));
            }
        }
    };
    for (pid, dir) in &hints.pids {
        if !process::same_dir(dir, game_dir) {
            add(*pid, dir, false);
        }
    }
    for dir in &hints.launcher_dirs {
        if process::same_dir(dir, game_dir) {
            continue;
        }
        for name in file_names(dir) {
            if let Some(pid) = hs_err_pid(&name) {
                add(pid, dir, true);
            }
        }
    }
    by_id.into_values().collect()
}

/// Whether the hs_err file at `path` comes from a JVM started with `--gameDir <game_dir>`
/// (its `Command Line:` summary line; a relative value is resolved against `cwd`).
fn hs_err_names_game_dir(path: &Path, cwd: &Path, game_dir: &Path) -> bool {
    let Ok(f) = File::open(path) else { return false };
    let mut head = Vec::new();
    if f.take(HS_ERR_HEAD_BYTES).read_to_end(&mut head).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&head);
    text.lines()
        .filter_map(|l| l.strip_prefix("Command Line:"))
        .filter_map(command_line_game_dir)
        .any(|dir| {
            let p = PathBuf::from(dir);
            let p = if p.is_absolute() { p } else { cwd.join(p) };
            process::same_dir(&p, game_dir)
        })
}

/// The `--gameDir` value of an hs_err command line. HotSpot prints the arguments unquoted and
/// space-separated, so the value runs to the next ` --` (paths may contain spaces).
fn command_line_game_dir(cmd: &str) -> Option<&str> {
    const FLAG: &str = "--gameDir ";
    let start = cmd.find(FLAG)? + FLAG.len();
    let rest = &cmd[start..];
    let end = rest.find(" --").unwrap_or(rest.len());
    let value = rest[..end].trim().trim_matches('"');
    (!value.is_empty()).then_some(value)
}

/// (source, path) of every source the guard allows, game dir and `@cwd/` ones.
fn guarded_sources(guard: &PathGuard, game_dir: &Path, hints: &CwdHints) -> Result<Vec<(LogSource, PathBuf)>> {
    guard.check_existing(game_dir)?;
    let mut out: Vec<(LogSource, PathBuf)> =
        game_dir_sources(game_dir).into_iter().filter(|(_, p)| guard.check_existing(p).is_ok()).collect();
    out.extend(cwd_sources(guard, game_dir, hints));
    out.sort_by(|(a, _), (b, _)| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

/// [`list_log_sources`] limited to files the PathGuard allows (the game dir itself must be in
/// scope; a symlinked `crash-reports/` or `logs/` resolves into its registered target root).
pub fn list_log_sources_guarded(guard: &PathGuard, game_dir: &Path) -> Result<Vec<LogSource>> {
    list_log_sources_with(guard, game_dir, &CwdHints::default())
}

/// [`list_log_sources_guarded`] plus the `@cwd/` hs_err files that `hints` allow.
pub fn list_log_sources_with(guard: &PathGuard, game_dir: &Path, hints: &CwdHints) -> Result<Vec<LogSource>> {
    Ok(guarded_sources(guard, game_dir, hints)?.into_iter().map(|(s, _)| s).collect())
}

/// `read_log_digest` without `@cwd/` hints.
pub fn read_source_digest(
    guard: &PathGuard,
    game_dir: &Path,
    source_id: &str,
    anchors: &[String],
    options: Option<DigestOptions>,
) -> Result<LogDigest> {
    read_source_digest_with(guard, game_dir, &CwdHints::default(), source_id, anchors, options)
}

/// `read_log_digest`: accepts only an id that [`list_log_sources_with`] currently returns,
/// resolves it through the PathGuard, and streams a digest with clamped options.
pub fn read_source_digest_with(
    guard: &PathGuard,
    game_dir: &Path,
    hints: &CwdHints,
    source_id: &str,
    anchors: &[String],
    options: Option<DigestOptions>,
) -> Result<LogDigest> {
    // Escaping, malformed or forged ids fail here with OutsideScope before anything is listed.
    if source_id.starts_with('@') {
        if parse_cwd_id(source_id).is_none() {
            return Err(Error::OutsideScope { path: source_id.to_string() });
        }
    } else {
        PathGuard::join_relative(game_dir, source_id)?;
    }
    let (source, path) = guarded_sources(guard, game_dir, hints)?
        .into_iter()
        .find(|(s, _)| s.id == source_id)
        .ok_or_else(|| Error::NotFound {
            path: format!("the log file \"{source_id}\" in this instance (refresh the list of logs and try again)"),
        })?;
    let path = guard.check_existing(&path)?;
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
        // Not crash reports, although they are .txt files in crash-reports/.
        write_at(&game.join("crash-reports/readme.txt"), "ignored\n", 1);
        write_at(&game.join("crash-reports/server-notes.txt"), "ignored\n", 1);
        write_at(&game.join("logs/latest.log"), "[main/INFO]: hi\nIncompatible mods found!\n", 10);
        write_at(&game.join("logs/debug.log"), "debug\n", 20);
        write_at(&game.join("logs/2026-11-01-1.log.gz"), "gz", 5);
        write_at(&game.join("hs_err_pid1234.log"), "# A fatal error\n", 100);
        write_at(&game.join("options.txt"), "x", 0);
        fs::create_dir_all(game.join("crash-reports/crash-dir.txt")).expect("dir named .txt");
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
    fn crash_report_names() {
        for ok in [
            "crash-2024-01-01_12.00.00-client.txt",
            "crash-2024-01-01_12.00.00-server.txt",
            "crash-2024-01-01_12.00.00-fml.txt",
            "crash-2024-01-01_12.00.00.1234-quilt_loader.txt",
        ] {
            assert!(is_crash_report_name(ok), "{ok}");
        }
        for bad in ["readme.txt", "notes.txt", "crash.txt", "crash-x.log", "my-crash-1.txt"] {
            assert!(!is_crash_report_name(bad), "{bad}");
        }
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
        for unknown in [
            "options.txt",
            "crash-reports/notes.md",
            "crash-reports/readme.txt",
            "logs/2026-11-01-1.log.gz",
            "logs/nope.log",
        ] {
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

    // ── hs_err files in the JVM's working dir ────────────────────────────────

    fn hs_err_body(game_dir: &Path) -> String {
        format!(
            "#\n# A fatal error has been detected by the Java Runtime Environment:\n#\n\
             ---------------  S U M M A R Y ------------\n\n\
             Command Line: -Xmx4G -Djava.library.path=x net.minecraft.client.main.Main --username Steve \
             --version 1.20.1 --gameDir {} --assetsDir y\n\n",
            game_dir.display()
        )
    }

    /// `.minecraft` (the launcher's working dir, itself a guard root) and a profile game dir.
    fn vanilla() -> (tempfile::TempDir, PathBuf, PathBuf, PathGuard) {
        let t = tempfile::tempdir().expect("tempdir");
        let base = dunce::canonicalize(t.path()).expect("canon");
        let mc = base.join(".minecraft");
        let game = base.join("Profiles").join("My Pack");
        let other = base.join("Profiles").join("My Pack 2");
        write_at(&game.join("logs/latest.log"), "x\n", 50);
        fs::create_dir_all(&other).expect("other");
        write_at(&mc.join("launcher_profiles.json"), "{}", 50);
        write_at(&mc.join("hs_err_pid77.log"), &hs_err_body(&game), 5);
        write_at(&mc.join("hs_err_pid78.log"), &hs_err_body(&other), 4);
        write_at(&mc.join("hs_err_pid79.log"), "# no command line\n", 3);
        let guard = PathGuard::new();
        guard.add_root(&mc).expect("root mc");
        guard.add_root(&game).expect("root game");
        (t, mc, game, guard)
    }

    #[test]
    fn cwd_ids_are_strict() {
        assert_eq!(parse_cwd_id("@cwd/hs_err_pid123.log"), Some(123));
        assert_eq!(cwd_hs_err_id(123), "@cwd/hs_err_pid123.log");
        for bad in [
            "@cwd/hs_err_pid.log",
            "@cwd/hs_err_pid0123.log",
            "@cwd/hs_err_pid12a.log",
            "@cwd/hs_err_pid99999999999.log",
            "@cwd/HS_ERR_PID1.LOG",
            "@cwd/../hs_err_pid1.log",
            "@cwd/sub/hs_err_pid1.log",
            "@cwd/hs_err_pid1.log/..",
            "@cwd//hs_err_pid1.log",
            "@cwdhs_err_pid1.log",
            "@CWD/hs_err_pid1.log",
            "@other/hs_err_pid1.log",
            "hs_err_pid1.log",
        ] {
            assert_eq!(parse_cwd_id(bad), None, "{bad}");
        }
    }

    #[test]
    fn launcher_dir_hs_err_is_listed_only_for_its_game_dir() {
        let (_t, mc, game, guard) = vanilla();
        let hints = CwdHints { pids: Vec::new(), launcher_dirs: vec![mc.clone()] };
        let list = list_log_sources_with(&guard, &game, &hints).expect("list");
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["@cwd/hs_err_pid77.log", "logs/latest.log"]);
        assert_eq!(list[0].kind, LogKind::HsErr);
        let d = read_source_digest_with(&guard, &game, &hints, "@cwd/hs_err_pid77.log", &[], None).expect("digest");
        assert_eq!(d.source.id, "@cwd/hs_err_pid77.log");
        assert!(d.total_lines > 3);
        // Another profile's crash, a file without a command line, and the plain-id form are not
        // this instance's.
        for unlisted in ["@cwd/hs_err_pid78.log", "@cwd/hs_err_pid79.log", "@cwd/hs_err_pid5.log"] {
            let err = read_source_digest_with(&guard, &game, &hints, unlisted, &[], None).expect_err(unlisted);
            assert!(matches!(err, Error::NotFound { .. }), "{unlisted}: {err}");
        }
        assert!(read_source_digest_with(&guard, &game, &hints, "hs_err_pid77.log", &[], None).is_err());
        // Without hints nothing outside the game dir is listed or readable.
        assert!(list_log_sources_guarded(&guard, &game).expect("list").iter().all(|s| !s.id.starts_with('@')));
        assert!(read_source_digest(&guard, &game, "@cwd/hs_err_pid77.log", &[], None).is_err());
    }

    #[test]
    fn recorded_pid_hs_err_is_listed_without_a_command_line_check() {
        let (_t, mc, game, guard) = vanilla();
        let hints = CwdHints { pids: vec![(79, mc.clone())], launcher_dirs: Vec::new() };
        let list = list_log_sources_with(&guard, &game, &hints).expect("list");
        assert!(list.iter().any(|s| s.id == "@cwd/hs_err_pid79.log"));
        assert!(!list.iter().any(|s| s.id == "@cwd/hs_err_pid77.log"), "only the recorded pid");
        assert!(read_source_digest_with(&guard, &game, &hints, "@cwd/hs_err_pid79.log", &[], None).is_ok());
    }

    #[test]
    fn forged_cwd_ids_are_outside_scope() {
        let (_t, mc, game, guard) = vanilla();
        let hints = CwdHints { pids: vec![(77, mc.clone())], launcher_dirs: vec![mc] };
        for bad in ["@cwd/../hs_err_pid77.log", "@cwd/hs_err_pid077.log", "@cwd/launcher_profiles.json", "@x", "@"] {
            let err = read_source_digest_with(&guard, &game, &hints, bad, &[], None).expect_err(bad);
            assert!(matches!(err, Error::OutsideScope { .. }), "{bad}: {err}");
        }
    }

    #[test]
    fn working_dir_outside_every_root_is_not_listed() {
        let (_t, mc, game, _guard) = vanilla();
        let guard = PathGuard::new();
        guard.add_root(&game).expect("game only");
        let hints = CwdHints { pids: vec![(77, mc.clone())], launcher_dirs: vec![mc] };
        let list = list_log_sources_with(&guard, &game, &hints).expect("list");
        assert!(list.iter().all(|s| !s.id.starts_with('@')), "{list:?}");
        let err = read_source_digest_with(&guard, &game, &hints, "@cwd/hs_err_pid77.log", &[], None).expect_err("outside");
        assert!(matches!(err, Error::NotFound { .. }), "{err}");
    }

    #[test]
    fn hs_err_symlink_escaping_the_roots_is_refused() {
        let (t, mc, game, guard) = vanilla();
        let outside = dunce::canonicalize(t.path()).expect("canon").join("elsewhere");
        write_at(&outside.join("secret.log"), &hs_err_body(&game), 1);
        let link = mc.join("hs_err_pid90.log");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(outside.join("secret.log"), &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(outside.join("secret.log"), &link);
        if made.is_err() {
            eprintln!("skipped: creating symlinks needs a privilege here");
            return;
        }
        let hints = CwdHints { pids: vec![(90, mc.clone())], launcher_dirs: vec![mc] };
        let list = list_log_sources_with(&guard, &game, &hints).expect("list");
        assert!(!list.iter().any(|s| s.id == "@cwd/hs_err_pid90.log"), "{list:?}");
    }

    /// CurseForge: `Install` is an hs_err dir (not a root), each instance folder a root.
    fn curseforge() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf, PathGuard) {
        let t = tempfile::tempdir().expect("tempdir");
        let base = dunce::canonicalize(t.path()).expect("canon").join("curseforge").join("minecraft");
        let install = base.join("Install");
        let a = base.join("Instances").join("Pack A");
        let b = base.join("Instances").join("Pack B");
        write_at(&a.join("logs/latest.log"), "x\n", 50);
        write_at(&b.join("logs/latest.log"), "x\n", 50);
        write_at(&install.join("launcher_log.txt"), &hs_err_body(&a), 1);
        write_at(&install.join("hs_err_pid500.log"), &hs_err_body(&a), 5);
        write_at(&install.join("hs_err_pid501.log"), &hs_err_body(&base.join("Instances").join("Gone")), 4);
        write_at(&install.join("hs_err_pid502.log.bak"), &hs_err_body(&a), 3);
        write_at(&install.join("sub/hs_err_pid503.log"), &hs_err_body(&a), 3);
        let guard = PathGuard::new();
        guard.add_root(&a).expect("root a");
        guard.add_root(&b).expect("root b");
        guard.set_hs_err_dirs(std::slice::from_ref(&install));
        (t, install, a, b, guard)
    }

    #[test]
    fn curseforge_install_hs_err_is_attributed_by_game_dir() {
        let (_t, install, a, b, guard) = curseforge();
        let hints = CwdHints { pids: Vec::new(), launcher_dirs: vec![install.clone()] };
        let ids = |game: &Path| -> Vec<String> {
            list_log_sources_with(&guard, game, &hints).expect("list").into_iter().map(|s| s.id).collect()
        };
        assert_eq!(ids(&a), vec!["@cwd/hs_err_pid500.log", "logs/latest.log"]);
        assert_eq!(ids(&b), vec!["logs/latest.log"], "names Pack A, not Pack B");
        let d = read_source_digest_with(&guard, &a, &hints, "@cwd/hs_err_pid500.log", &[], None).expect("digest");
        assert!(d.total_lines > 3);
        // Naming no known instance, a .bak copy, or in a subfolder: listed for nobody.
        for unlisted in ["@cwd/hs_err_pid501.log", "@cwd/hs_err_pid502.log", "@cwd/hs_err_pid503.log"] {
            let err = read_source_digest_with(&guard, &a, &hints, unlisted, &[], None).expect_err(unlisted);
            assert!(matches!(err, Error::NotFound { .. }), "{unlisted}: {err}");
        }
        // Without the rule nothing in Install is readable, even with the hint.
        guard.set_hs_err_dirs(&[]);
        assert_eq!(ids(&a), vec!["logs/latest.log"]);
    }

    #[test]
    fn game_dir_as_working_dir_keeps_plain_ids() {
        let (_t, game, guard) = fixture();
        let hints = CwdHints { pids: vec![(1234, game.clone())], launcher_dirs: vec![game.clone()] };
        let list = list_log_sources_with(&guard, &game, &hints).expect("list");
        assert!(list.iter().any(|s| s.id == "hs_err_pid1234.log"));
        assert!(list.iter().all(|s| !s.id.starts_with('@')));
    }

    #[test]
    fn command_line_game_dir_handles_spaces() {
        assert_eq!(command_line_game_dir("x --gameDir C:\\My Pack --assetsDir y"), Some("C:\\My Pack"));
        assert_eq!(command_line_game_dir("x --gameDir /home/a/My Pack 2"), Some("/home/a/My Pack 2"));
        assert_eq!(command_line_game_dir("x --gameDir \"/a b\" --x"), Some("/a b"));
        assert_eq!(command_line_game_dir("x --version 1"), None);
    }
}
