//! Folders the user added by hand: an instance root or a game dir.

use std::path::{Path, PathBuf};

use crate::model::{Launcher, ProbeResult};

use super::common::{absolute, build, dir_state, is_dir, is_file, DirState, Ini, Meta, NewInstance, Outcome};
use super::env::Env;
use super::{curseforge, prism, side};

/// The game dir for a folder that may be an instance root or a game dir itself.
pub(crate) fn locate_game_dir(folder: &Path) -> PathBuf {
    if is_dir(&folder.join("mods")) {
        return folder.to_path_buf();
    }
    if is_dir(&folder.join("minecraft")) || is_dir(&folder.join(".minecraft")) {
        return prism::game_dir(folder);
    }
    folder.to_path_buf()
}

pub(crate) fn probe(env: &Env, folder: &Path) -> Outcome {
    let launcher = Launcher::Manual;
    let folder = absolute(folder);
    match dir_state(&folder) {
        DirState::Dir => {}
        DirState::Missing => {
            return Outcome::new(
                launcher,
                &folder,
                ProbeResult::Error { message: "This folder no longer exists. Remove it or add it again.".into() },
            )
        }
        _ => return Outcome::from_dir_state(launcher, &folder).unwrap_or_else(|| Outcome::not_installed(launcher, &folder)),
    }
    let mut out = Outcome::new(launcher, &folder, ProbeResult::NotInstalled);
    let game_dir = locate_game_dir(&folder);
    let folder_name = folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| super::common::display(&folder));

    // Reuse launcher metadata when the folder is recognisably a Prism/MultiMC or CurseForge instance.
    let (name, meta) = if is_file(&folder.join("instance.cfg")) {
        let name = Ini::read(&folder.join("instance.cfg"))
            .ok()
            .and_then(|i| i.get_non_empty("name"))
            .unwrap_or_else(|| folder_name.clone());
        let meta = match prism::read_pack(&folder.join("mmc-pack.json")) {
            Ok(Some(m)) => m,
            Ok(None) => Meta::inferred(),
            Err(m) => {
                out.note(format!("{m} — using jar metadata"));
                Meta::inferred()
            }
        };
        (name, meta)
    } else if is_file(&game_dir.join("minecraftinstance.json")) {
        let (name, meta, note) = curseforge::read_meta(&game_dir, &folder_name);
        if let Some(n) = note {
            out.note(n);
        }
        (name, meta)
    } else {
        (folder_name, Meta::inferred())
    };

    if !is_dir(&game_dir.join("mods")) {
        out.note("no mods folder found");
    }
    let side = side::detect_side(&game_dir);
    out.instances.push(build(env.os, NewInstance { launcher, name, root: &folder, game_dir: &game_dir, meta, side }));
    out.finish()
}
