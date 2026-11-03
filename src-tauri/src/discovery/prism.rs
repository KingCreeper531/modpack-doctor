//! Prism Launcher and MultiMC (same instance format). launchers.md §2.

use std::path::{Path, PathBuf};

use crate::model::{Launcher, LoaderInfo, LoaderKind, ProbeResult, Side};

use super::common::{
    build, dir_state, display, is_dir, is_file, json_get, json_str, list_subdirs, name_of, DirState, Found, Ini, Meta,
    NewInstance, Outcome,
};
use super::env::{Env, Os};

/// Auto-detected data dirs, per launcher.
pub(crate) fn candidates(env: &Env) -> Vec<(Launcher, PathBuf)> {
    let mut v = Vec::new();
    let prism = Launcher::Prism;
    let mmc = Launcher::Multimc;
    if let Some(p) = env.var_path("PRISMLAUNCHER_DATA_DIR") {
        v.push((prism, p));
    }
    v.push((prism, env.data_dir().join("PrismLauncher")));
    let home = &env.home;
    match env.os {
        Os::Windows => {
            v.push((prism, home.join("scoop").join("persist").join("prismlauncher")));
            for p in [home.join("MultiMC"), home.join("Desktop").join("MultiMC"), home.join("Downloads").join("MultiMC")] {
                v.push((mmc, p));
            }
            if let Some(drive) = env.vars.get("SystemDrive") {
                v.push((mmc, PathBuf::from(format!("{}\\", drive.trim_end_matches(['\\', '/']))).join("MultiMC")));
            }
            for key in ["ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(p) = env.var_path(key) {
                    v.push((mmc, p.join("MultiMC")));
                }
            }
        }
        Os::MacOs => {
            if let Some(apps) = &env.applications {
                v.push((mmc, apps.join("MultiMC.app").join("Data")));
            }
            v.push((mmc, home.join("Applications").join("MultiMC.app").join("Data")));
        }
        Os::Linux => {
            v.push((prism, env.data_dir().join("prismlauncher")));
            v.push((
                prism,
                home.join(".var").join("app").join("org.prismlauncher.PrismLauncher").join("data").join("PrismLauncher"),
            ));
            v.push((prism, home.join("snap").join("prismlauncher").join("common")));
            v.push((mmc, home.join("MultiMC")));
            v.push((mmc, env.data_dir().join("multimc")));
            v.push((mmc, env.data_dir().join("MultiMC")));
        }
    }
    if env.os != Os::Linux {
        v.push((mmc, env.data_dir().join("MultiMC")));
    }
    v
}

fn cfg_names(launcher: Launcher) -> &'static [&'static str] {
    match launcher {
        Launcher::Multimc => &["multimc.cfg"],
        _ => &["prismlauncher.cfg", "polymc.cfg", "multimc.cfg"],
    }
}

/// Probe a data dir. `user_root` = chosen by the user (portable install): `UserData/` is
/// honoured and a folder that directly contains instances is accepted as the instance dir.
pub(crate) fn probe(env: &Env, launcher: Launcher, dir: &Path, user_root: bool) -> Outcome {
    if let Some(o) = Outcome::from_dir_state(launcher, dir) {
        return o;
    }
    let mut out = Outcome::new(launcher, dir, ProbeResult::NotInstalled);
    let mut data_dir = dir.to_path_buf();
    if user_root && is_dir(&dir.join("UserData")) {
        data_dir = dir.join("UserData");
        out.note(format!("portable install — using {}", display(&data_dir)));
    }

    let cfg = cfg_names(launcher).iter().map(|n| data_dir.join(n)).find(|p| is_file(p));
    let instance_dir = match &cfg {
        Some(cfg_path) => {
            let configured = match Ini::read(cfg_path) {
                Ok(ini) => ini.get_non_empty("InstanceDir"),
                Err(e) => {
                    out.note(format!("could not read {} ({e}) — assuming the default instance folder", display(cfg_path)));
                    None
                }
            };
            match configured {
                Some(v) => {
                    let p = PathBuf::from(&v);
                    if p.is_absolute() {
                        p
                    } else {
                        data_dir.join(p)
                    }
                }
                None => data_dir.join("instances"),
            }
        }
        None if is_dir(&data_dir.join("instances")) => data_dir.join("instances"),
        None if user_root && contains_instances(&data_dir) => data_dir.clone(),
        None => {
            if user_root {
                out.note(format!("no {} or instances folder here", cfg_names(launcher).join(" / ")));
                return out.finish();
            }
            return out; // NotInstalled: the folder exists but is not a launcher data dir.
        }
    };

    match dir_state(&instance_dir) {
        DirState::Dir => {}
        DirState::Denied => {
            out.probe.result = ProbeResult::PermissionDenied;
            out.note(format!("instance folder {}", display(&instance_dir)));
            return out;
        }
        DirState::Missing | DirState::NotDir => {
            out.note(format!("instance folder {} does not exist", display(&instance_dir)));
            return out.finish();
        }
        DirState::Failed(m) => {
            out.probe.result = ProbeResult::Error { message: m };
            return out;
        }
    }
    if instance_dir != data_dir.join("instances") && instance_dir != data_dir {
        out.note(format!("instances are in {}", display(&instance_dir)));
    }

    let subdirs = match list_subdirs(&instance_dir) {
        Ok(s) => s,
        Err(e) => {
            let notes = std::mem::take(&mut out.probe.notes);
            let mut o = Outcome::from_io(launcher, dir, &e);
            o.probe.notes = notes;
            return o;
        }
    };
    for (name, path) in subdirs {
        if !is_file(&path.join("instance.cfg")) {
            continue;
        }
        let (found, note) = read_instance(env.os, launcher, &path, &name_of(&name));
        if let Some(n) = note {
            out.note(n);
        }
        out.instances.push(found);
    }
    out.finish()
}

fn contains_instances(dir: &Path) -> bool {
    list_subdirs(dir).map(|s| s.iter().any(|(_, p)| is_file(&p.join("instance.cfg")))).unwrap_or(false)
}

/// `<inst>/.minecraft` only if it exists and `<inst>/minecraft` does not.
pub(crate) fn game_dir(inst: &Path) -> PathBuf {
    let plain = inst.join("minecraft");
    let dot = inst.join(".minecraft");
    if is_dir(&dot) && !is_dir(&plain) {
        dot
    } else {
        plain
    }
}

/// Read one instance folder (must contain `instance.cfg`).
pub(crate) fn read_instance(os: Os, launcher: Launcher, inst: &Path, folder: &str) -> (Found, Option<String>) {
    let name = Ini::read(&inst.join("instance.cfg"))
        .ok()
        .and_then(|ini| ini.get_non_empty("name"))
        .unwrap_or_else(|| folder.to_string());
    let (meta, note) = match read_pack(&inst.join("mmc-pack.json")) {
        Ok(Some(meta)) => (meta, None),
        Ok(None) => (Meta::inferred(), Some(format!("{name}: no mmc-pack.json — using jar metadata"))),
        Err(m) => (Meta::inferred(), Some(format!("{name}: {m} — using jar metadata"))),
    };
    let gd = game_dir(inst);
    (build(os, NewInstance { launcher, name, root: inst, game_dir: &gd, meta, side: Side::Client }), note)
}

/// Parse `mmc-pack.json`. `Ok(None)` when the file is absent.
pub(crate) fn read_pack(path: &Path) -> Result<Option<Meta>, String> {
    let Some(v) = super::common::read_json(path)? else { return Ok(None) };
    let Some(components) = json_get(&v, "components").and_then(|c| c.as_array()) else {
        return Err("mmc-pack.json has no components list".into());
    };
    let mut mc = None;
    let mut loader = None;
    for c in components {
        if json_get(c, "disabled").and_then(|d| d.as_bool()).unwrap_or(false) {
            continue;
        }
        let Some(uid) = json_str(c, "uid") else { continue };
        let version = json_str(c, "version").or_else(|| json_str(c, "cachedVersion"));
        let kind = match uid.as_str() {
            "net.minecraft" => {
                if mc.is_none() {
                    mc = version;
                }
                continue;
            }
            "net.minecraftforge" => LoaderKind::Forge,
            "net.neoforged" => LoaderKind::Neoforge,
            "net.fabricmc.fabric-loader" => LoaderKind::Fabric,
            "org.quiltmc.quilt-loader" => LoaderKind::Quilt,
            "com.mumfrey.liteloader" => LoaderKind::Unknown,
            _ => continue,
        };
        // A real loader beats LiteLoader if both are listed.
        let replace = match &loader {
            None => true,
            Some(LoaderInfo { kind: LoaderKind::Unknown, .. }) => kind != LoaderKind::Unknown,
            Some(_) => false,
        };
        if replace {
            loader = Some(LoaderInfo { kind, version });
        }
    }
    Ok(Some(Meta::launcher(mc, loader)))
}
