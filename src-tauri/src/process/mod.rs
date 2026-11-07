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
//! [`game_status`] adds, on Windows only and only when no process matched, a secondary signal:
//! another process holding the first jar in `mods/` open (the running game holds every mod jar
//! open), found by a probe that can never disturb the game ([`locked_mod_jar`]).

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
/// Windows, only when no process matched) a mod jar another process holds open. Blocking;
/// cheap (one process listing, at most one attribute-only file open).
pub fn game_status(game_dir: &Path, source: &dyn ProcessSource, guard: &PathGuard) -> GameStatus {
    let matches = instance_matches(game_dir, source);
    let pids: Vec<u32> = matches.iter().map(|m| m.pid).collect();
    let mut reasons: Vec<String> = matches.into_iter().map(|m| m.reason).collect();
    // Secondary signal for a game whose command line / working dir could not be read.
    if reasons.is_empty() {
        if let Some(locked) = locked_mod_jar(game_dir, guard) {
            reasons.push(locked);
        }
    }
    GameStatus { running: !reasons.is_empty(), pids, reason: (!reasons.is_empty()).then(|| reasons.join("; ")) }
}

/// Windows: `Some(reason)` when another process has the first `mods/*.jar` (by name) open.
/// Always `None` elsewhere.
///
/// The probe can never disturb the game: it opens the jar for `FILE_READ_ATTRIBUTES` only with
/// full sharing (an access that takes no part in share-mode checks, so it neither fails against
/// nor blocks any other open, not even an exclusive one) and asks the kernel which processes
/// hold the file (`NtQueryInformationFile`, `FileProcessIdsUsingFileInformation`). Our own
/// process is ignored. A probe that requests `DELETE` (or read/write) access instead would make
/// a JVM opening the jar at that moment fail: `ZipFile` opens jars through `RandomAccessFile`
/// with `FILE_SHARE_READ | FILE_SHARE_WRITE` only (OpenJDK `io_util_md.c`), so it refuses any
/// existing handle with delete access (verified in `process::tests`).
#[cfg(windows)]
pub fn locked_mod_jar(game_dir: &Path, guard: &PathGuard) -> Option<String> {
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
    let others = win_probe::other_holders(&path)?;
    if others.is_empty() {
        return None;
    }
    let list: Vec<String> = others.iter().map(u32::to_string).collect();
    let noun = if others.len() == 1 { "pid" } else { "pids" };
    Some(format!("mods/{name} is open in another program ({noun} {})", list.join(", ")))
}

#[cfg(not(windows))]
pub fn locked_mod_jar(_game_dir: &Path, _guard: &PathGuard) -> Option<String> {
    None
}

/// The non-disruptive "who holds this file" probe behind [`locked_mod_jar`].
#[cfg(windows)]
pub(crate) mod win_probe {
    use std::ffi::c_void;
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;

    /// The only access requested. It is not subject to share-mode checks.
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    /// `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`.
    const FILE_SHARE_ALL: u32 = 0x1 | 0x2 | 0x4;
    /// `FILE_INFORMATION_CLASS::FileProcessIdsUsingFileInformation`.
    const FILE_PROCESS_IDS_USING_FILE_INFORMATION: u32 = 47;
    /// Process ids read at most (a jar held by more processes than this is reported partially).
    const MAX_IDS: usize = 256;

    #[repr(C)]
    struct IoStatusBlock {
        /// `union { NTSTATUS Status; PVOID Pointer; }`
        status: usize,
        information: usize,
    }

    /// `FILE_PROCESS_IDS_USING_FILE_INFORMATION` with room for [`MAX_IDS`] ids.
    #[repr(C)]
    struct ProcessIds {
        count: u32,
        ids: [usize; MAX_IDS],
    }

    #[link(name = "ntdll", kind = "raw-dylib")]
    extern "system" {
        fn NtQueryInformationFile(
            file: *mut c_void,
            io_status: *mut IoStatusBlock,
            info: *mut c_void,
            length: u32,
            class: u32,
        ) -> i32;
    }

    /// Open `path` for attributes only, with full sharing: never fails because of, and never
    /// causes, a sharing violation.
    pub fn open_probe(path: &Path) -> io::Result<File> {
        OpenOptions::new().access_mode(FILE_READ_ATTRIBUTES).share_mode(FILE_SHARE_ALL).open(path)
    }

    /// Ids of the processes that have the file open (this one included, through `file`).
    /// `None` when the file system cannot say (the query failed).
    pub fn holders(file: &File) -> Option<Vec<u32>> {
        let mut io_status = IoStatusBlock { status: 0, information: 0 };
        let mut info = ProcessIds { count: 0, ids: [0; MAX_IDS] };
        let length = u32::try_from(std::mem::size_of::<ProcessIds>()).ok()?;
        // SAFETY: `file` is an open handle for the duration of the call; `io_status` and `info`
        // are live, writable, correctly laid out (`repr(C)`) and `length` is `info`'s size.
        let status = unsafe {
            NtQueryInformationFile(
                file.as_raw_handle(),
                &mut io_status,
                (&mut info as *mut ProcessIds).cast(),
                length,
                FILE_PROCESS_IDS_USING_FILE_INFORMATION,
            )
        };
        // NT_SUCCESS / informational only; warnings (e.g. a truncated list) and errors are not
        // trusted.
        if status < 0 {
            return None;
        }
        let n = usize::try_from(info.count).unwrap_or(MAX_IDS).min(MAX_IDS);
        Some(info.ids[..n].iter().filter_map(|&p| u32::try_from(p).ok()).collect())
    }

    /// Processes other than this one that have `path` open; `None` if that cannot be determined.
    pub fn other_holders(path: &Path) -> Option<Vec<u32>> {
        let file = open_probe(path).ok()?;
        let me = std::process::id();
        let mut others: Vec<u32> = holders(&file)?.into_iter().filter(|p| *p != me).collect();
        others.sort_unstable();
        others.dedup();
        Some(others)
    }
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
