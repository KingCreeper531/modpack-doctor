//! Helpers behind the log, watch-mode and running-game commands (all blocking; the commands
//! run them through `blocking`).

use std::path::PathBuf;
use std::sync::Arc;

use crate::error::{Error, Result};
use crate::logs::sources::{self, CwdHints};
use crate::logs::watch::{sanitize_anchors, CrashSink};
use crate::model::{DigestOptions, GameStatus, Launcher, LogDigest, LogSource, WatchAnchor};
use crate::process;
use crate::state::{AppState, RegisteredInstance};

use super::instances::remove_manual_blocking;

/// Files that mark a vanilla launcher's `.minecraft` (`discovery::vanilla`).
const VANILLA_PROFILE_FILES: &[&str] = &["launcher_profiles.json", "launcher_profiles_microsoft_store.json"];

/// Where this instance's JVM may have written hs_err files outside its game dir
/// (`logs::sources` module docs): the working dirs watch mode recorded for its processes, and
/// shared launcher working dirs whose files are attributed by `--gameDir`:
/// - for a vanilla instance, the launcher's `.minecraft` when that is itself a discovered vanilla
///   instance (and so a PathGuard root);
/// - for a CurseForge instance, the PathGuard's read-only hs_err dirs (CurseForge's `Install`
///   folders, active only while a CurseForge instance is discovered).
pub fn cwd_hints(st: &AppState, inst: &RegisteredInstance) -> CwdHints {
    let pids = st.watchers.recorded_cwds(&inst.instance.id);
    let launcher_dirs = match inst.instance.launcher {
        Launcher::Vanilla => {
            let instances = st.registry.read().map(|r| r.instances()).unwrap_or_default();
            instances
                .into_iter()
                .filter(|i| i.launcher == Launcher::Vanilla)
                .map(|i| PathBuf::from(i.game_dir))
                .filter(|d| !process::same_dir(d, &inst.game_dir))
                .filter(|d| VANILLA_PROFILE_FILES.iter().any(|f| d.join(f).is_file()))
                .collect()
        }
        Launcher::Curseforge => st.guard.hs_err_dirs(),
        _ => Vec::new(),
    };
    CwdHints { pids, launcher_dirs }
}

/// `list_log_sources`: the instance's log files the PathGuard allows, newest first, including
/// `@cwd/hs_err_pid<pid>.log` files from its JVM working dir.
pub fn list_sources_blocking(st: &AppState, instance_id: &str) -> Result<Vec<LogSource>> {
    let inst = st.instance(instance_id)?;
    if inst.instance.launcher == Launcher::Mrpack {
        return Ok(Vec::new());
    }
    sources::list_log_sources_with(&st.guard, &inst.game_dir, &cwd_hints(st, &inst))
}

/// `read_log_digest`: only ids `list_log_sources` currently returns are accepted.
pub fn read_digest_blocking(
    st: &AppState,
    instance_id: &str,
    source_id: &str,
    anchors: &[String],
    options: Option<DigestOptions>,
) -> Result<LogDigest> {
    let inst = st.instance(instance_id)?;
    if inst.instance.launcher == Launcher::Mrpack {
        return Err(Error::Invalid("a .mrpack file has no logs to read".into()));
    }
    let hints = cwd_hints(st, &inst);
    sources::read_source_digest_with(&st.guard, &inst.game_dir, &hints, source_id, anchors, options)
}

/// `set_watch(id, true, anchors)`: start (or re-arm with new anchors) and persist the id in
/// `Settings.watched`. If persisting fails the watcher is stopped again.
///
/// Holds the scope lock for reading (like scans), so discovery cannot swap the registry and the
/// PathGuard roots halfway through. It takes it with `blocking_read`, so it must run on a
/// blocking thread (`commands::blocking`), and the caller must **not** hold the scope lock
/// already (a queued writer would then deadlock the two reads).
pub fn enable_watch(st: &AppState, instance_id: &str, anchors: Vec<WatchAnchor>, sink: Arc<dyn CrashSink>) -> Result<()> {
    let _scope = st.scope_lock.blocking_read();
    let inst = st.instance(instance_id)?;
    if inst.instance.launcher == Launcher::Mrpack {
        return Err(Error::Invalid(format!("\"{}\" is a .mrpack file, so there is no game to watch", inst.instance.name)));
    }
    let anchors = sanitize_anchors(anchors)?;
    st.guard.check_existing(&inst.game_dir)?;
    st.watchers.start(instance_id, &inst.game_dir, st.guard.clone(), anchors, st.processes.0.clone(), sink)?;
    let persisted = st.settings.update(|s| {
        if !s.watched.iter().any(|w| w == instance_id) {
            s.watched.push(instance_id.to_string());
        }
        Ok(())
    });
    if let Err(e) = persisted {
        st.watchers.stop(instance_id);
        return Err(e);
    }
    Ok(())
}

/// `set_watch(id, false, _)`: stop the watcher (if any) and drop the id from `Settings.watched`.
/// Works for ids that are no longer discovered, so stale entries can always be cleared. Takes
/// the scope lock for reading like [`enable_watch`] (same caller rules).
pub fn disable_watch(st: &AppState, instance_id: &str) -> Result<()> {
    let _scope = st.scope_lock.blocking_read();
    st.watchers.stop(instance_id);
    st.settings.update(|s| {
        s.watched.retain(|w| w != instance_id);
        Ok(())
    })?;
    Ok(())
}

/// Forget per-instance state of a removed instance: its watcher, `watched` entry and override.
/// Called with the scope lock already held for writing (removal), so it does not take it.
pub fn forget_instance(st: &AppState, instance_id: &str) -> Result<()> {
    st.watchers.stop(instance_id);
    st.settings.update(|s| {
        s.watched.retain(|w| w != instance_id);
        s.overrides.remove(instance_id);
        Ok(())
    })?;
    Ok(())
}

/// `remove_manual_instance`: the M3 removal, then [`forget_instance`].
pub fn remove_manual_and_forget(st: &AppState, instance_id: &str) -> Result<()> {
    remove_manual_blocking(st, instance_id)?;
    forget_instance(st, instance_id)
}

/// `game_running`: Java processes using the game dir, plus (Windows) a locked mod jar.
pub fn game_status_blocking(st: &AppState, instance_id: &str) -> Result<GameStatus> {
    let inst = st.instance(instance_id)?;
    if inst.instance.launcher == Launcher::Mrpack {
        return Ok(GameStatus { running: false, pids: Vec::new(), reason: None });
    }
    Ok(process::game_status(&inst.game_dir, &*st.processes, &st.guard))
}

#[cfg(test)]
mod tests;
