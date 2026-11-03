//! Helpers behind the instance commands: native folder picker, discovery runs, and the pure
//! settings edits for manual folders and launcher roots.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::discovery::{self, DiscoveryInput, Env, Os};
use crate::error::{Error, Result};
use crate::model::{DiscoveryReport, Instance, Launcher, LauncherRoot, Settings};
use crate::settings::path_key;
use crate::state::{poisoned, AppState};

/// Run blocking work off the async runtime threads.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| Error::Internal(format!("a background task failed: {e}")))?
}

/// Native folder picker, async-safe (callback + oneshot; never `blocking_*`). None = cancelled.
pub async fn pick_folder<R: Runtime>(app: &AppHandle<R>, title: &str) -> Result<Option<PathBuf>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = rx.await.map_err(|_| Error::Internal("the folder picker closed unexpectedly".into()))?;
    match picked {
        None => Ok(None),
        Some(p) => p
            .into_path()
            .map(Some)
            .map_err(|e| Error::Invalid(format!("the selected folder is not a local folder ({e})"))),
    }
}

/// Canonical form of a picked folder (symlinks resolved, `\\?\` stripped). Must be a folder.
pub fn canonical_dir(p: &Path) -> Result<PathBuf> {
    let canon = dunce::canonicalize(p).map_err(|e| Error::io(p, e))?;
    if !canon.is_dir() {
        return Err(Error::Invalid(format!("{} is not a folder", canon.display())));
    }
    Ok(canon)
}

fn is_dir(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

/// The game dir discovery uses for a manually added folder (mirrors
/// `discovery::manual::locate_game_dir`, which is crate-private to discovery): the folder
/// itself if it has `mods/`, else its `minecraft/` / `.minecraft/` (Prism layout), else itself.
pub fn manual_game_dir(folder: &Path) -> PathBuf {
    if is_dir(&folder.join("mods")) {
        return folder.to_path_buf();
    }
    let plain = folder.join("minecraft");
    let dot = folder.join(".minecraft");
    if is_dir(&plain) || is_dir(&dot) {
        return if is_dir(&dot) && !is_dir(&plain) { dot } else { plain };
    }
    folder.to_path_buf()
}

/// Instance id discovery gives a manually added folder.
pub fn manual_folder_id(folder: &Path) -> String {
    discovery::instance_id(&manual_game_dir(folder), Os::current())
}

/// Add `folder` to `manual_folders` unless an equal entry exists. True if added.
pub fn add_manual_folder(s: &mut Settings, folder: &str) -> bool {
    let key = path_key(folder);
    if s.manual_folders.iter().any(|f| path_key(f) == key) {
        return false;
    }
    s.manual_folders.push(folder.to_string());
    true
}

/// Add a launcher root unless the same launcher + folder is stored. True if added.
pub fn add_launcher_root(s: &mut Settings, launcher: Launcher, path: &str) -> bool {
    let key = path_key(path);
    if s.launcher_roots.iter().any(|r| r.launcher == launcher && path_key(&r.path) == key) {
        return false;
    }
    s.launcher_roots.push(LauncherRoot { launcher, path: path.to_string() });
    true
}

/// Remove the stored scope entry whose path equals `path` exactly: launcher roots first, then
/// (so a manual folder that no longer exists, which has no instance to remove, can still be
/// dropped from its probe row) manual folders. True if something was removed.
pub fn remove_stored_path(s: &mut Settings, path: &str) -> bool {
    let before = (s.launcher_roots.len(), s.manual_folders.len());
    s.launcher_roots.retain(|r| r.path != path);
    if s.launcher_roots.len() == before.0 {
        s.manual_folders.retain(|f| f != path);
    }
    (s.launcher_roots.len(), s.manual_folders.len()) != before
}

/// Remove every manual folder that produced instance `inst` (by root, or by the id its game
/// dir hashes to). Returns how many entries were removed.
pub fn remove_manual_folders_for(s: &mut Settings, inst: &Instance, id_of: impl Fn(&Path) -> String) -> usize {
    let root_key = path_key(&inst.root);
    let before = s.manual_folders.len();
    s.manual_folders.retain(|f| path_key(f) != root_key && id_of(Path::new(f)) != inst.id);
    before - s.manual_folders.len()
}

/// Discover with the current settings and apply the result (registry + PathGuard). Blocking.
pub fn discover_blocking(st: &AppState) -> Result<DiscoveryReport> {
    let input = DiscoveryInput::from(&st.settings.get());
    let discovered = discovery::discover(&Env::current(), &input);
    st.apply_discovery(discovered)
}

/// Remove a Manual instance: settings, registry, and the PathGuard roots only it needed.
/// Blocking. Fails for unknown ids and for instances that came from a launcher.
pub fn remove_manual_blocking(st: &AppState, id: &str) -> Result<()> {
    let reg = st.instance(id)?;
    if reg.instance.launcher != Launcher::Manual {
        return Err(Error::Invalid(format!(
            "\"{}\" was found in a launcher folder; only folders you added yourself can be removed",
            reg.instance.name
        )));
    }
    st.settings.update(|s| Ok(remove_manual_folders_for(s, &reg.instance, manual_folder_id)))?;
    let pinned = st.pinned();
    let mut registry = st.registry.write().map_err(|_| poisoned("instance registry"))?;
    if let Some((_, orphaned)) = registry.remove(id) {
        for root in orphaned.iter().filter(|r| !pinned.contains(r)) {
            st.guard.remove_root(root);
        }
    }
    Ok(())
}
