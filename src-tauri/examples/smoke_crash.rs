//! Dev tool: for every discovered instance, scan mods/ and digest its real logs READ-ONLY
//! (newest crash reports, logs/latest.log, hs_err_pid*.log), writing one `<instance id>.json`
//! ({ instance, scan, logs: [{ digest, reachedGame }] }) for the crash smoke test
//! (`CRASH_SMOKE_DIR=<dir> npx vitest run src/core/__tests__/real-crash-smoke.test.ts`).
//!
//!   cargo run --release --example smoke_crash -- <out dir>
//!
//! Digests use the maximum (clamped) budget and no anchors, so small logs are captured whole
//! and the analyzer sees the same structural blocks the app would. `reachedGame` records
//! whether the log shows the game reaching the title screen: an error-level crash finding on
//! such a log is a false positive. Nothing is written anywhere but `<out dir>`.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use modpack_doctor_lib::discovery::{discover, DiscoveryInput, Env};
use modpack_doctor_lib::guard::PathGuard;
use modpack_doctor_lib::logs::digest::{clamp_options, read_digest};
use modpack_doctor_lib::model::{DigestOptions, Launcher, LogKind, LogSource, Settings};
use modpack_doctor_lib::scan::scan_mods_dir;

/// Markers that only appear once the client reached the title screen or a world.
const REACHED: &[&str] = &["Sound engine started", "Created: 1024x", "Created: 2048x", "Loaded 0 advancements", "Stopping!"];

fn main() {
    let Some(out) = std::env::args().nth(1).map(PathBuf::from) else {
        eprintln!("usage: smoke_crash <out dir>");
        std::process::exit(2);
    };
    if let Err(e) = std::fs::create_dir_all(&out) {
        eprintln!("cannot create {}: {e}", out.display());
        std::process::exit(1);
    }
    let found = discover(&Env::current(), &DiscoveryInput::from(&Settings::default()));
    let guard = PathGuard::new();
    for root in &found.roots {
        let _ = guard.add_root(root);
    }
    let opts = clamp_options(&DigestOptions { head: u32::MAX, tail: u32::MAX, context: 0, max_lines: u32::MAX, max_line_chars: u32::MAX });

    for inst in &found.report.instances {
        if inst.launcher == Launcher::Mrpack {
            continue;
        }
        let game = Path::new(&inst.game_dir);
        let sources = sources(game);
        if sources.is_empty() {
            continue;
        }
        let scan = scan_mods_dir(game, &inst.id, &guard, |_| {}, |_| {}).ok();
        let mut logs = Vec::new();
        for (path, source) in sources {
            match read_digest(&path, source, &[], &opts) {
                Ok(digest) => {
                    let reached = digest.chunks.iter().flat_map(|c| c.lines.iter()).any(|l| REACHED.iter().any(|m| l.contains(m)));
                    logs.push(serde_json::json!({ "digest": digest, "reachedGame": reached }));
                }
                Err(e) => eprintln!("{}: {e}", path.display()),
            }
        }
        println!("{:<44} {} logs", inst.name, logs.len());
        let json = serde_json::json!({ "instance": inst, "scan": scan, "logs": logs });
        let _ = std::fs::write(out.join(format!("{}.json", inst.id)), json.to_string());
    }
}

/// Newest 3 crash reports, latest.log, newest hs_err file.
fn sources(game: &Path) -> Vec<(PathBuf, LogSource)> {
    let mut crashes = files(&game.join("crash-reports"), |n| n.ends_with(".txt"));
    crashes.sort_by(|a, b| b.1.cmp(&a.1));
    let mut hs = files(game, |n| n.starts_with("hs_err_pid") && n.ends_with(".log"));
    hs.sort_by(|a, b| b.1.cmp(&a.1));
    let mut out = Vec::new();
    for (p, m, s) in crashes.into_iter().take(3) {
        out.push(source(game, p, m, s, LogKind::CrashReport));
    }
    let latest = game.join("logs").join("latest.log");
    if let Ok(meta) = std::fs::metadata(&latest) {
        out.push(source(game, latest, mtime(&meta), meta.len(), LogKind::LatestLog));
    }
    for (p, m, s) in hs.into_iter().take(1) {
        out.push(source(game, p, m, s, LogKind::HsErr));
    }
    out
}

fn files(dir: &Path, keep: impl Fn(&str) -> bool) -> Vec<(PathBuf, u64, u64)> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_name().to_str().is_some_and(&keep))
                .filter_map(|e| e.metadata().ok().filter(|m| m.is_file()).map(|m| (e.path(), mtime(&m), m.len())))
                .collect()
        })
        .unwrap_or_default()
}

fn mtime(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

fn source(game: &Path, path: PathBuf, modified_ms: u64, size: u64, kind: LogKind) -> (PathBuf, LogSource) {
    let id = path.strip_prefix(game).map_or_else(|_| path.display().to_string(), |r| r.to_string_lossy().replace('\\', "/"));
    (path, LogSource { id, kind, modified_ms, size })
}
