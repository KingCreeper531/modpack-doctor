//! Helpers behind the log, watch-mode and running-game commands (all blocking; the commands
//! run them through `blocking`).

use std::sync::Arc;

use crate::error::{Error, Result};
use crate::logs::sources;
use crate::logs::watch::{sanitize_anchors, CrashSink};
use crate::model::{DigestOptions, GameStatus, Launcher, LogDigest, LogSource, WatchAnchor};
use crate::process;
use crate::state::AppState;

use super::instances::remove_manual_blocking;

/// `list_log_sources`: the instance's log files the PathGuard allows, newest first.
pub fn list_sources_blocking(st: &AppState, instance_id: &str) -> Result<Vec<LogSource>> {
    let inst = st.instance(instance_id)?;
    if inst.instance.launcher == Launcher::Mrpack {
        return Ok(Vec::new());
    }
    sources::list_log_sources_guarded(&st.guard, &inst.game_dir)
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
    sources::read_source_digest(&st.guard, &inst.game_dir, source_id, anchors, options)
}

/// `set_watch(id, true, anchors)`: start (or re-arm with new anchors) and persist the id in
/// `Settings.watched`. If persisting fails the watcher is stopped again.
pub fn enable_watch(st: &AppState, instance_id: &str, anchors: Vec<WatchAnchor>, sink: Arc<dyn CrashSink>) -> Result<()> {
    let inst = st.instance(instance_id)?;
    if inst.instance.launcher == Launcher::Mrpack {
        return Err(Error::Invalid(format!("\"{}\" is a .mrpack file, so there is no game to watch", inst.instance.name)));
    }
    let anchors = sanitize_anchors(anchors)?;
    st.guard.check_existing(&inst.game_dir)?;
    st.watchers.start(instance_id, &inst.game_dir, anchors, st.processes.0.clone(), sink)?;
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
/// Works for ids that are no longer discovered, so stale entries can always be cleared.
pub fn disable_watch(st: &AppState, instance_id: &str) -> Result<()> {
    st.watchers.stop(instance_id);
    st.settings.update(|s| {
        s.watched.retain(|w| w != instance_id);
        Ok(())
    })?;
    Ok(())
}

/// Forget per-instance state of a removed instance: its watcher, `watched` entry and override.
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
