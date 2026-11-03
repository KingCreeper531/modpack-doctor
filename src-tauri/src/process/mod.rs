//! Shared Java-process detection (watch mode in M4, running-game guard in M6). Owner: M4 agent K.
//!
//! A [`ProcessSource`] lists the Java processes on the machine ([`SysinfoSource`] in the app, a
//! fake in tests). [`match_processes`] decides which of them run a given instance:
//!
//! - A process that names its game dir on the command line (`--gameDir <dir>`,
//!   `--gameDir=<dir>`, or `-Dminecraft.applet.TargetDirectory=<dir>`; relative values are
//!   resolved against the process's working dir) matches only when that dir is the instance's
//!   game dir. Its working dir is then ignored, because the vanilla launcher starts every
//!   profile in `.minecraft` while pointing `--gameDir` at the profile's own folder.
//! - A process without such an argument (Prism and MultiMC pass the game dir over stdin to their
//!   launch wrapper) matches when its working dir is the game dir, or the instance folder that
//!   holds a `.minecraft` / `minecraft` game dir.
//!
//! Each match carries the process's working dir ([`ProcMatch::cwd`]), because the JVM writes
//! `hs_err_pid<pid>.log` there, which for the vanilla launcher (and launchers built on it) is not
//! the game dir. Watch mode records it per pid (`logs::watch::CwdLog`).
//!
//! Paths are compared canonically (symlinks resolved when the path exists, lexically otherwise),
//! with `/` and `\` treated alike, case-insensitively on Windows and macOS.
//!
//! [`game_status`] adds, on Windows only, a second signal: one jar in `mods/` that cannot be
//! opened exclusively (the running game holds every mod jar open).

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::guard::PathGuard;
use crate::model::GameStatus;

/// One running Java process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: u32,
    /// Executable name as the OS reports it (`javaw.exe`, `java`).
    pub name: String,
    /// Command line, `cmd[0]` being the executable. Empty when the OS did not let us read it.
    pub cmd: Vec<String>,
    /// Working directory, when readable.
    pub cwd: Option<PathBuf>,
}

/// Lists the Java processes on this machine. Implementations must be cheap enough to call
/// about once per second per watched instance.
pub trait ProcessSource: Send + Sync {
    fn java_processes(&self) -> Vec<ProcInfo>;
}

/// The process source shared by watch mode and the running-game guard (`AppState.processes`).
#[derive(Clone)]
pub struct Processes(pub Arc<dyn ProcessSource>);

impl Default for Processes {
    fn default() -> Self {
        Self(Arc::new(SysinfoSource::new()))
    }
}

impl std::fmt::Debug for Processes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Processes")
    }
}

impl std::ops::Deref for Processes {
    type Target = dyn ProcessSource;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

/// True for `java`, `javaw`, `java.exe`, `javaw.exe` and other `java*` executables.
pub fn is_java_name(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with("java")
}

// ── sysinfo ──────────────────────────────────────────────────────────────────

/// How long a process listing is reused, so several watchers polling at once share one refresh.
const CACHE_TTL: Duration = Duration::from_millis(500);

/// Process listing through `sysinfo`. A refresh reads only process names for every process,
/// then command line, working dir and executable for the Java ones (and only once per process).
pub struct SysinfoSource {
    inner: Mutex<SysInner>,
}

struct SysInner {
    sys: System,
    cached: Option<(Instant, Vec<ProcInfo>)>,
}

impl SysinfoSource {
    pub fn new() -> Self {
        Self { inner: Mutex::new(SysInner { sys: System::new(), cached: None }) }
    }
}

impl Default for SysinfoSource {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessSource for SysinfoSource {
    fn java_processes(&self) -> Vec<ProcInfo> {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, list)) = &inner.cached {
            if at.elapsed() < CACHE_TTL {
                return list.clone();
            }
        }
        let sys = &mut inner.sys;
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        let java: Vec<Pid> = sys
            .processes()
            .iter()
            .filter(|(_, p)| is_java_name(&p.name().to_string_lossy()))
            .map(|(pid, _)| *pid)
            .collect();
        if !java.is_empty() {
            let detail = ProcessRefreshKind::nothing()
                .with_cmd(UpdateKind::OnlyIfNotSet)
                .with_cwd(UpdateKind::OnlyIfNotSet)
                .with_exe(UpdateKind::OnlyIfNotSet);
            sys.refresh_processes_specifics(ProcessesToUpdate::Some(&java), false, detail);
        }
        let mut list: Vec<ProcInfo> = java
            .iter()
            .filter_map(|pid| sys.process(*pid))
            .map(|p| ProcInfo {
                pid: p.pid().as_u32(),
                name: p.name().to_string_lossy().into_owned(),
                cmd: p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect(),
                cwd: p.cwd().map(Path::to_path_buf),
            })
            .collect();
        list.sort_by_key(|p| p.pid);
        inner.cached = Some((Instant::now(), list.clone()));
        list
    }
}

// ── Matching ─────────────────────────────────────────────────────────────────

/// A Java process running an instance, with a human-readable reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcMatch {
    pub pid: u32,
    pub reason: String,
    /// The process's working dir, when readable. This is where the JVM writes
    /// `hs_err_pid<pid>.log`, and it is not always the game dir (see the module docs).
    pub cwd: Option<PathBuf>,
}

/// Pids of the Java processes running the instance whose game dir is `game_dir`.
pub fn instance_processes(game_dir: &Path, source: &dyn ProcessSource) -> Vec<u32> {
    instance_matches(game_dir, source).into_iter().map(|m| m.pid).collect()
}

/// Like [`instance_processes`], with the reason for each match.
pub fn instance_matches(game_dir: &Path, source: &dyn ProcessSource) -> Vec<ProcMatch> {
    match_processes(game_dir, &source.java_processes(), fold_case())
}

/// Case-insensitive path comparison on Windows and macOS.
pub fn fold_case() -> bool {
    crate::discovery::Os::current().case_insensitive()
}

/// The processes in `procs` that run the instance with game dir `game_dir` (rules in the
/// module docs). `fold_case` compares paths case-insensitively.
pub fn match_processes(game_dir: &Path, procs: &[ProcInfo], fold_case: bool) -> Vec<ProcMatch> {
    let target = path_key(game_dir, fold_case);
    // Prism/MultiMC wrappers may run in the instance folder above `.minecraft`/`minecraft`.
    let wrapper_dir = match game_dir.file_name().and_then(|n| n.to_str()) {
        Some(".minecraft" | "minecraft") => game_dir.parent().map(|p| path_key(p, fold_case)),
        _ => None,
    };
    let mut out = Vec::new();
    for p in procs {
        if let Some((flag, dir)) = game_dir_arg(&p.cmd) {
            let resolved = match (Path::new(&dir).is_absolute(), &p.cwd) {
                (false, Some(cwd)) => cwd.join(&dir),
                _ => PathBuf::from(&dir),
            };
            if path_key(&resolved, fold_case) == target {
                out.push(ProcMatch {
                    pid: p.pid,
                    reason: format!("{} (pid {}) was started with {flag} {}", p.name, p.pid, resolved.display()),
                    cwd: p.cwd.clone(),
                });
            }
            continue;
        }
        let Some(cwd) = &p.cwd else { continue };
        let key = path_key(cwd, fold_case);
        if key == target || wrapper_dir.as_ref() == Some(&key) {
            out.push(ProcMatch {
                pid: p.pid,
                reason: format!("{} (pid {}) is running in {}", p.name, p.pid, cwd.display()),
                cwd: Some(cwd.clone()),
            });
        }
    }
    out
}

/// The game dir named on a command line: (flag as written, value).
fn game_dir_arg(cmd: &[String]) -> Option<(&'static str, String)> {
    const APPLET: &str = "-Dminecraft.applet.TargetDirectory=";
    let mut found = None;
    let mut it = cmd.iter().skip(1);
    while let Some(arg) = it.next() {
        if arg == "--gameDir" {
            if let Some(v) = it.next() {
                return Some(("--gameDir", v.clone()));
            }
        } else if let Some(v) = arg.strip_prefix("--gameDir=") {
            return Some(("--gameDir", v.to_string()));
        } else if let Some(v) = arg.strip_prefix(APPLET) {
            // `--gameDir` wins if both are present; keep looking.
            found = Some(("-Dminecraft.applet.TargetDirectory", v.to_string()));
        }
    }
    found.filter(|(_, v)| !v.is_empty())
}

/// Whether `a` and `b` name the same directory (compared like process paths: canonical when
/// they exist, `/` and `\` alike, case-insensitively on Windows and macOS).
pub fn same_dir(a: &Path, b: &Path) -> bool {
    let fold = fold_case();
    path_key(a, fold) == path_key(b, fold)
}

/// Comparable form of a path: canonical if it exists, else lexically normalised; `/`
/// separators, no trailing separator, lowercased when `fold_case`.
fn path_key(p: &Path, fold_case: bool) -> String {
    let resolved = dunce::canonicalize(p).unwrap_or_else(|_| lexical(p));
    let mut s = resolved.to_string_lossy().replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if fold_case {
        s.to_lowercase()
    } else {
        s
    }
}

/// `.` and `..` resolved without touching the filesystem.
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// ── Running-game status ──────────────────────────────────────────────────────

/// Whether the instance with game dir `game_dir` is running: a matching Java process, or (on
/// Windows) a locked mod jar. Blocking; cheap (one process listing, at most one file open).
pub fn game_status(game_dir: &Path, source: &dyn ProcessSource, guard: &PathGuard) -> GameStatus {
    let matches = instance_matches(game_dir, source);
    let pids: Vec<u32> = matches.iter().map(|m| m.pid).collect();
    let mut reasons: Vec<String> = matches.into_iter().map(|m| m.reason).collect();
    if let Some(locked) = locked_mod_jar(game_dir, guard) {
        reasons.push(locked);
    }
    GameStatus { running: !reasons.is_empty(), pids, reason: (!reasons.is_empty()).then(|| reasons.join("; ")) }
}

/// Windows: `Some(reason)` when the first `mods/*.jar` (by name) cannot be opened exclusively
/// because another program has it open. Always `None` elsewhere.
#[cfg(windows)]
pub fn locked_mod_jar(game_dir: &Path, guard: &PathGuard) -> Option<String> {
    use std::os::windows::fs::OpenOptionsExt;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;

    let mods = game_dir.join("mods");
    let mut jars: Vec<String> = std::fs::read_dir(&mods)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.to_ascii_lowercase().ends_with(".jar"))
        .collect();
    jars.sort();
    let name = jars.into_iter().next()?;
    let path = guard.check_existing(&mods.join(&name)).ok()?;
    match std::fs::OpenOptions::new().read(true).share_mode(0).open(&path) {
        Err(e) if matches!(e.raw_os_error(), Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)) => {
            Some(format!("mods/{name} is in use by another program"))
        }
        _ => None,
    }
}

#[cfg(not(windows))]
pub fn locked_mod_jar(_game_dir: &Path, _guard: &PathGuard) -> Option<String> {
    None
}

// ── Test double ──────────────────────────────────────────────────────────────

/// A process list set by the test.
#[cfg(test)]
#[derive(Debug, Default)]
pub struct FakeProcesses {
    pub procs: Mutex<Vec<ProcInfo>>,
}

#[cfg(test)]
impl FakeProcesses {
    pub fn set(&self, procs: Vec<ProcInfo>) {
        *self.procs.lock().expect("fake processes") = procs;
    }
}

#[cfg(test)]
impl ProcessSource for FakeProcesses {
    fn java_processes(&self) -> Vec<ProcInfo> {
        self.procs.lock().expect("fake processes").clone()
    }
}

#[cfg(test)]
mod tests;
