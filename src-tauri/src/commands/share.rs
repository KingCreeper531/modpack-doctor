//! `share_log`: upload one known log source of one known instance to mclo.gs (user-initiated,
//! after a confirmation in the UI). The webview passes only ids; Rust resolves the file like
//! `read_log_digest` (only ids `list_log_sources` returns, through the PathGuard), reads, scrubs
//! the home folder, removes login tokens and the user name, and cuts it to mclo.gs's limits
//! (`crate::share`). `delete_shared_log` deletes a log this app run uploaded, with the delete
//! token Rust kept (the webview never sees it).

use std::fs::File;
use std::path::PathBuf;

use tauri::State;

use super::instances::blocking;
use super::logs::cwd_hints;
use crate::error::{AppError, Error, Result};
use crate::logs::sources;
use crate::model::{Launcher, SharedLog};
use crate::share::{self, McLogs, Prepared};
use crate::state::AppState;

/// The PathGuard-checked file behind `source_id`, if `list_log_sources` lists it for this instance.
pub fn resolve_share_path(st: &AppState, instance_id: &str, source_id: &str) -> Result<PathBuf> {
    let inst = st.instance(instance_id)?;
    if inst.instance.launcher == Launcher::Mrpack {
        return Err(Error::Invalid("a .mrpack file has no logs to share".into()));
    }
    let hints = cwd_hints(st, &inst);
    let (_, path) = sources::resolve_source(&st.guard, &inst.game_dir, &hints, source_id)?;
    Ok(path)
}

/// Resolve and open the log (blocking; under the scope lock in `share_log`).
pub fn open_share_file(st: &AppState, instance_id: &str, source_id: &str) -> Result<(File, PathBuf)> {
    let path = resolve_share_path(st, instance_id, source_id)?;
    let file = File::open(&path).map_err(|e| Error::io(&path, e))?;
    Ok((file, path))
}

/// Resolve, open and read (scrubbed, redacted, cut) the log; blocking.
pub fn prepare_share_blocking(st: &AppState, instance_id: &str, source_id: &str, home: Option<&str>, user_names: &[String]) -> Result<Prepared> {
    let (mut file, path) = open_share_file(st, instance_id, source_id)?;
    share::prepare_open_file(&mut file, &path, home, user_names)
}

/// Uploads the log source to mclo.gs and returns its links. The file is resolved and opened
/// while the scope lock is held; reading it (possibly a long file) and the upload run after the
/// lock is released.
#[tauri::command]
#[specta::specta]
pub async fn share_log(state: State<'_, AppState>, instance_id: String, source_id: String) -> Result<SharedLog, AppError> {
    let st = AppState::clone(&state);
    let home = dirs::home_dir().map(|p| p.to_string_lossy().into_owned());
    let (mut file, path) = {
        let _scope = st.scope_lock.clone().read_owned().await;
        blocking(move || open_share_file(&st, &instance_id, &source_id)).await?
    };
    let names = share::local_user_names(home.as_deref());
    let prepared = blocking(move || share::prepare_open_file(&mut file, &path, home.as_deref(), &names)).await?;
    let client = McLogs::new()?;
    share::upload_prepared(&client, &prepared).await
}

/// Deletes a log this app run uploaded to mclo.gs (`id` from its `https://mclo.gs/<id>` link),
/// with the delete token Rust kept from the upload. `notFound` when there is none.
#[tauri::command]
#[specta::specta]
pub async fn delete_shared_log(id: String) -> Result<(), AppError> {
    let client = McLogs::new()?;
    share::delete_uploaded(&client, &id).await
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;
    use crate::discovery::{self, Discovered, Os};
    use crate::model::{DiscoveryReport, Instance, MetadataSource, Side};

    fn instance(dir: &Path) -> Instance {
        Instance {
            id: discovery::instance_id(dir, Os::current()),
            name: "Pack".into(),
            launcher: Launcher::Prism,
            root: dir.display().to_string(),
            game_dir: dir.display().to_string(),
            mc_version: None,
            loader: None,
            side: Side::Client,
            metadata_source: MetadataSource::Inferred,
            mod_count: 0,
        }
    }

    #[test]
    fn only_listed_sources_of_a_known_instance_are_shared() {
        let t = tempfile::tempdir().expect("tempdir");
        let base = dunce::canonicalize(t.path()).expect("canon");
        let dir = base.join("Pack");
        fs::create_dir_all(dir.join("logs")).expect("mkdir");
        fs::write(dir.join("logs/latest.log"), "[main/INFO]: hi\n").expect("log");
        fs::write(dir.join("options.txt"), "secret\n").expect("other");
        fs::write(base.join("outside.log"), "outside\n").expect("outside");
        let st = AppState::default();
        let inst = instance(&dir);
        let roots = discovery::guard_roots(Path::new(&inst.root), Path::new(&inst.game_dir));
        st.apply_discovery(Discovered { report: DiscoveryReport { instances: vec![inst.clone()], probes: Vec::new() }, roots })
            .expect("apply");

        let p = prepare_share_blocking(&st, &inst.id, "logs/latest.log", None, &[]).expect("latest");
        assert_eq!(p.content, "[main/INFO]: hi\n");

        for id in ["options.txt", "logs/other.log"] {
            assert!(matches!(resolve_share_path(&st, &inst.id, id), Err(Error::NotFound { .. })), "{id}");
        }
        for id in ["../outside.log", "C:/Windows/win.ini", "/etc/passwd", "@cwd/../x"] {
            assert!(matches!(resolve_share_path(&st, &inst.id, id), Err(Error::OutsideScope { .. })), "{id}");
        }
        assert!(resolve_share_path(&st, "no-such-instance", "logs/latest.log").is_err());
    }

    /// A listed log that is a symlink to a file outside every PathGuard root is never read.
    #[test]
    fn a_log_symlinked_outside_the_roots_is_refused() {
        let t = tempfile::tempdir().expect("tempdir");
        let base = dunce::canonicalize(t.path()).expect("canon");
        let dir = base.join("Pack");
        fs::create_dir_all(dir.join("logs")).expect("mkdir");
        let outside = base.join("secret.txt");
        fs::write(&outside, "--accessToken secret\n").expect("outside");
        let link = dir.join("logs/latest.log");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&outside, &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&outside, &link);
        if let Err(e) = made {
            // Creating symlinks needs Developer Mode or admin rights on Windows.
            eprintln!("skipped: cannot create a symlink here ({e})");
            return;
        }
        let st = AppState::default();
        let inst = instance(&dir);
        let roots = discovery::guard_roots(Path::new(&inst.root), Path::new(&inst.game_dir));
        st.apply_discovery(Discovered { report: DiscoveryReport { instances: vec![inst.clone()], probes: Vec::new() }, roots })
            .expect("apply");
        let err = prepare_share_blocking(&st, &inst.id, "logs/latest.log", None, &[]).expect_err("outside the roots");
        assert!(matches!(err, Error::OutsideScope { .. } | Error::NotFound { .. }), "{err:?}");
    }
}
