//! Launcher discovery (Modrinth App, Prism/MultiMC, CurseForge, vanilla, manual). Owner: M2 agent B.
//!
//! [`discover`] probes every known location for the given [`Env`] (never the real home in
//! tests), reads launcher metadata strictly read-only, de-duplicates instances by
//! [`instance_id`] (launcher entries win over manual folders) and returns, besides the
//! report, every path the caller must register with `PathGuard` (CONTRACTS invariant 2).
//! Sources and gotchas: docs/research/launchers.md.

mod common;
mod curseforge;
mod env;
mod manual;
mod modrinth;
mod prism;
mod side;
mod vanilla;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use sha1::{Digest, Sha1};

use crate::model::{DiscoveryReport, Launcher, ProbeResult, Settings};

use common::{canonical, is_dir, location_key, resolve, Outcome};

pub use env::{Env, Os, ENV_VARS};
pub use manual::locate_game_dir;
pub use modrinth::DbOptions;

/// User-configured inputs (from `Settings.manual_folders` / `Settings.launcher_roots`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DiscoveryInput {
    pub manual_folders: Vec<PathBuf>,
    /// Extra launcher data roots: portable Prism/MultiMC, custom CurseForge/Modrinth folder,
    /// an alternative `.minecraft`.
    pub launcher_roots: Vec<(Launcher, PathBuf)>,
}

impl From<&Settings> for DiscoveryInput {
    fn from(s: &Settings) -> Self {
        DiscoveryInput {
            manual_folders: s.manual_folders.iter().map(PathBuf::from).collect(),
            launcher_roots: s.launcher_roots.iter().map(|r| (r.launcher, PathBuf::from(&r.path))).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Discovered {
    pub report: DiscoveryReport,
    /// Canonical, existing, de-duplicated paths to register with `PathGuard`: each
    /// instance root, its game dir, and the canonical targets of `mods/`, `logs/` and
    /// `crash-reports/` when those are symlinks/junctions (one level only).
    pub roots: Vec<PathBuf>,
}

/// Instance id (CONTRACTS invariant 5): first 16 hex chars of SHA-1 over the canonical game
/// dir path, lowercased on Windows and macOS. For a game dir that does not exist yet (an
/// instance never launched) the nearest existing ancestor is canonicalised and the missing
/// components appended, so the id stays the same after first launch even when a parent is a
/// junction or symlink.
pub fn instance_id(game_dir: &Path, os: Os) -> String {
    let path = resolve(game_dir);
    let mut s = path.to_string_lossy().into_owned();
    if os.case_insensitive() {
        s = s.to_lowercase();
    }
    let digest = Sha1::digest(s.as_bytes());
    let mut hex = hex::encode(digest);
    hex.truncate(16);
    hex
}

/// Discover all instances with the default database options.
///
/// **Blocking.** This does synchronous filesystem and SQLite I/O. When a Modrinth `app.db`
/// is locked it waits up to the 2 s busy timeout per attempt, for 4 attempts with short
/// pauses — about 8.5 s worst case per busy database. Async callers (Tauri commands) must run
/// it via `tokio::task::spawn_blocking` (or `tauri::async_runtime::spawn_blocking`).
pub fn discover(env: &Env, input: &DiscoveryInput) -> Discovered {
    discover_with(env, input, &DbOptions::default())
}

/// [`discover`] with explicit database options. Equally blocking.
pub fn discover_with(env: &Env, input: &DiscoveryInput, db: &DbOptions) -> Discovered {
    let mut probes = Probes::new(env);

    for dir in modrinth::candidates(env) {
        probes.run(Launcher::Modrinth, &dir, || modrinth::probe(env, &dir, db));
    }
    for (launcher, dir) in prism::candidates(env) {
        probes.run(launcher, &dir, || prism::probe(env, launcher, &dir, false));
    }
    for root in curseforge::candidates(env) {
        probes.run(Launcher::Curseforge, &root, || curseforge::probe(env, &root));
    }
    for root in vanilla::candidates(env) {
        probes.run(Launcher::Vanilla, &root, || vanilla::probe(env, &root));
    }
    for (launcher, root) in &input.launcher_roots {
        let (launcher, root) = (*launcher, root.as_path());
        probes.run(launcher, root, || match launcher {
            Launcher::Modrinth => modrinth::probe_user_root(env, root, db),
            Launcher::Prism | Launcher::Multimc => prism::probe(env, launcher, root, true),
            Launcher::Curseforge => curseforge::probe_user_root(env, root),
            Launcher::Vanilla => vanilla::probe(env, root),
            Launcher::Manual => manual::probe(env, root),
            Launcher::Mrpack => Outcome::new(
                launcher,
                root,
                ProbeResult::Error { message: "A .mrpack file is not a launcher folder; open it with \"Open file\".".into() },
            ),
        });
    }
    for folder in &input.manual_folders {
        probes.run(Launcher::Manual, folder, || manual::probe(env, folder));
    }
    probes.merge()
}

/// Every path `PathGuard` must accept for one instance (see [`Discovered::roots`]).
pub fn guard_roots(root: &Path, game_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    push_guard_roots(root, game_dir, &mut out, &mut seen);
    out
}

fn push_guard_roots(root: &Path, game_dir: &Path, out: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
    let mut push = |p: PathBuf| {
        if is_dir(&p) && seen.insert(p.clone()) {
            out.push(p);
        }
    };
    for p in [root, game_dir] {
        if let Some(c) = canonical(p) {
            push(c);
        }
    }
    let canon_game = canonical(game_dir);
    for sub in ["mods", "logs", "crash-reports"] {
        let p = game_dir.join(sub);
        let Ok(meta) = fs::symlink_metadata(&p) else { continue };
        let Some(target) = canonical(&p) else { continue };
        // Junctions count as symlinks in std; the canonical comparison is a fallback for
        // other reparse points that resolve elsewhere.
        let expected = canon_game.as_ref().map(|g| g.join(sub));
        let moved = expected.is_some_and(|e| !same_path(&e, &target));
        if meta.file_type().is_symlink() || moved {
            push(target);
        }
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

fn launcher_label(l: Launcher) -> &'static str {
    match l {
        Launcher::Modrinth => "Modrinth App",
        Launcher::Prism => "Prism Launcher",
        Launcher::Multimc => "MultiMC",
        Launcher::Curseforge => "CurseForge",
        Launcher::Vanilla => "Minecraft Launcher",
        Launcher::Manual => "manually added",
        Launcher::Mrpack => ".mrpack",
    }
}

/// Collects outcomes, skipping a location already probed for the same launcher.
struct Probes<'a> {
    env: &'a Env,
    seen: HashSet<(Launcher, String)>,
    outcomes: Vec<Outcome>,
}

impl<'a> Probes<'a> {
    fn new(env: &'a Env) -> Self {
        Probes { env, seen: HashSet::new(), outcomes: Vec::new() }
    }

    fn run(&mut self, launcher: Launcher, path: &Path, f: impl FnOnce() -> Outcome) {
        // A relative candidate means the base folder is unknown (e.g. no home dir): skip it
        // rather than probing the working directory.
        if path.as_os_str().is_empty() || (!path.is_absolute() && !matches!(launcher, Launcher::Manual)) {
            return;
        }
        if !self.seen.insert((launcher, location_key(path, self.env.os))) {
            return;
        }
        self.outcomes.push(f());
    }

    fn merge(self) -> Discovered {
        let mut instances = Vec::new();
        let mut by_id: HashMap<String, usize> = HashMap::new();
        let mut probes = Vec::new();
        let mut roots = Vec::new();
        let mut seen_roots = HashSet::new();
        for outcome in self.outcomes {
            let mut probe = outcome.probe;
            // Count distinct instances (an aliased/linked folder is one instance).
            if let ProbeResult::Found { count } = &mut probe.result {
                let distinct: HashSet<&str> = outcome.instances.iter().map(|f| f.instance.id.as_str()).collect();
                *count = u32::try_from(distinct.len()).unwrap_or(u32::MAX);
            }
            for found in outcome.instances {
                if let Some(&i) = by_id.get(&found.instance.id) {
                    let existing: &crate::model::Instance = &instances[i];
                    if probe.launcher == Launcher::Manual && existing.launcher != Launcher::Manual {
                        probe.notes.push(format!(
                            "same folder as the {} instance \"{}\" — listed once",
                            launcher_label(existing.launcher),
                            existing.name
                        ));
                    }
                    continue;
                }
                by_id.insert(found.instance.id.clone(), instances.len());
                push_guard_roots(&found.root, &found.game_dir, &mut roots, &mut seen_roots);
                instances.push(found.instance);
            }
            probes.push(probe);
        }
        Discovered { report: DiscoveryReport { instances, probes }, roots }
    }
}
