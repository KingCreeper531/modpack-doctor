//! CurseForge app (closed source; community-derived format). launchers.md §3.

use std::path::{Path, PathBuf};

use crate::model::{Instance, Launcher, LoaderInfo, LoaderKind, ProbeResult, Side};

use super::common::{
    build, is_dir, is_file, json_get, json_str, list_subdirs, name_of, read_json, split_loader_mc, Found, Meta,
    NewInstance, Outcome,
};
use super::env::{Env, Os};

/// `minecraft` roots (`<root>/Instances` holds the instances) on every OS.
pub(crate) fn candidates(env: &Env) -> Vec<PathBuf> {
    vec![
        env.home.join("curseforge").join("minecraft"),
        env.documents_dir().join("curseforge").join("minecraft"),
    ]
}

/// `Instances` (or `instances`, distinct on Linux) under a minecraft root.
fn instances_dir(root: &Path) -> Option<PathBuf> {
    ["Instances", "instances"].iter().map(|n| root.join(n)).find(|p| is_dir(p))
}

/// Auto-detected root: NotInstalled unless `<root>/Instances` exists.
pub(crate) fn probe(env: &Env, root: &Path) -> Outcome {
    match instances_dir(root) {
        Some(dir) => probe_instances(env, &dir),
        None => Outcome::from_dir_state(Launcher::Curseforge, &root.join("Instances"))
            .unwrap_or_else(|| Outcome::not_installed(Launcher::Curseforge, &root.join("Instances"))),
    }
}

/// A user-chosen folder: the `curseforge` dir, the `minecraft` root, or `Instances` itself.
pub(crate) fn probe_user_root(env: &Env, root: &Path) -> Outcome {
    if let Some(dir) = instances_dir(root).or_else(|| instances_dir(&root.join("minecraft"))) {
        return probe_instances(env, &dir);
    }
    probe_instances(env, root)
}

fn probe_instances(env: &Env, dir: &Path) -> Outcome {
    let launcher = Launcher::Curseforge;
    if let Some(o) = Outcome::from_dir_state(launcher, dir) {
        return o;
    }
    let subdirs = match list_subdirs(dir) {
        Ok(s) => s,
        Err(e) => return Outcome::from_io(launcher, dir, &e),
    };
    let mut out = Outcome::new(launcher, dir, ProbeResult::NotInstalled);
    for (name, path) in subdirs {
        let has_json = is_file(&path.join("minecraftinstance.json"));
        if !has_json && !is_dir(&path.join("mods")) {
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

/// The shared `Install` folder (`<minecraft root>/Install`, next to `Instances`) of a CurseForge
/// instance whose root is `<minecraft root>/Instances/<name>`; `None` if the instance is not laid
/// out like that or the folder does not exist. CurseForge runs the vanilla launcher with this
/// folder as its `--workDir` (launchers.md §3, "JVM working directory").
pub(crate) fn install_dir(instance_root: &Path) -> Option<PathBuf> {
    let instances = instance_root.parent()?;
    let is_instances = instances.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case("instances"));
    if !is_instances {
        return None;
    }
    let root = instances.parent()?;
    ["Install", "install"].iter().map(|n| root.join(n)).find(|p| is_dir(p))
}

/// The folders whose `hs_err_pid<pid>.log` files PathGuard may read without making them roots
/// (CONTRACTS invariant 11, CurseForge hs_err): the `Install` folder of every discovered
/// CurseForge instance, de-duplicated. Empty when no CurseForge instance is discovered.
pub fn hs_err_dirs(instances: &[Instance]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for inst in instances.iter().filter(|i| i.launcher == Launcher::Curseforge) {
        if let Some(dir) = install_dir(Path::new(&inst.root)) {
            let dir = dunce::canonicalize(&dir).unwrap_or(dir);
            if !out.contains(&dir) {
                out.push(dir);
            }
        }
    }
    out
}

/// Read one CurseForge instance folder (it is the game dir).
pub(crate) fn read_instance(os: Os, launcher: Launcher, dir: &Path, folder: &str) -> (Found, Option<String>) {
    let (name, meta, note) = read_meta(dir, folder);
    (build(os, NewInstance { launcher, name, root: dir, game_dir: dir, meta, side: Side::Client }), note)
}

/// Name, metadata and an optional probe note from `<dir>/minecraftinstance.json`.
pub(crate) fn read_meta(dir: &Path, folder: &str) -> (String, Meta, Option<String>) {
    match read_json(&dir.join("minecraftinstance.json")) {
        Ok(Some(v)) => (json_str(&v, "name").unwrap_or_else(|| folder.to_string()), parse_meta(&v), None),
        Ok(None) => (folder.to_string(), Meta::inferred(), None),
        Err(m) => (folder.to_string(), Meta::inferred(), Some(format!("{folder}: {m} — using jar metadata"))),
    }
}

fn parse_meta(v: &serde_json::Value) -> Meta {
    let base = json_get(v, "baseModLoader").filter(|b| b.is_object());
    let mut mc = json_str(v, "gameVersion");
    let mut loader = None;
    if let Some(b) = base {
        let known_mc = mc.clone().or_else(|| json_str(b, "minecraftVersion"));
        let from_name = json_str(b, "name").and_then(|n| parse_loader_name(&n, known_mc.as_deref()));
        if let Some((info, name_mc)) = from_name {
            loader = Some(info);
            if mc.is_none() {
                mc = name_mc;
            }
        } else {
            // Fallback: CurseForge ModLoaderType enum + forgeVersion (holds every loader's version).
            let version = json_str(b, "forgeVersion");
            let kind = match json_get(b, "type").and_then(|t| t.as_i64()) {
                Some(1) => Some(LoaderKind::Forge),
                Some(4) => Some(LoaderKind::Fabric),
                Some(5) => Some(LoaderKind::Quilt),
                Some(6) => Some(LoaderKind::Neoforge),
                Some(0) | None => None,
                Some(_) => Some(LoaderKind::Unknown),
            };
            loader = kind.map(|kind| LoaderInfo { kind, version });
        }
        if mc.is_none() {
            mc = json_str(b, "minecraftVersion");
        }
    }
    if mc.is_none() && loader.is_none() && base.is_none() && json_get(v, "gameVersion").is_none() {
        return Meta::inferred();
    }
    Meta::launcher(mc, loader)
}

/// `forge-47.3.0`, `neoforge-21.1.256`, `fabric-0.15.11-1.20.1`, `quilt-0.26.4-1.20.1`.
/// Returns the loader and, for Fabric/Quilt, the MC version embedded in the name. Both
/// halves may contain hyphens (`fabric-0.16.0-beta.1-1.20.5-pre1`); `known_mc` (the
/// instance's `gameVersion`) is matched as a suffix first.
pub(crate) fn parse_loader_name(name: &str, known_mc: Option<&str>) -> Option<(LoaderInfo, Option<String>)> {
    let (prefix, rest) = name.trim().split_once('-')?;
    let kind = match prefix.to_ascii_lowercase().as_str() {
        "forge" => LoaderKind::Forge,
        "neoforge" => LoaderKind::Neoforge,
        "fabric" => LoaderKind::Fabric,
        "quilt" => LoaderKind::Quilt,
        _ => return None,
    };
    if rest.is_empty() {
        return None;
    }
    match kind {
        LoaderKind::Fabric | LoaderKind::Quilt => {
            let (lv, mc) = split_loader_mc(rest, known_mc);
            Some((LoaderInfo { kind, version: Some(lv) }, mc))
        }
        _ => Some((LoaderInfo { kind, version: Some(rest.to_string()) }, None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn cf_instance(launcher: Launcher, dir: &Path) -> Instance {
        read_instance(Os::current(), launcher, dir, "Pack").0.instance
    }

    #[test]
    fn hs_err_dirs_are_the_install_folders_of_curseforge_instances() {
        let t = tempfile::tempdir().expect("tempdir");
        let mc = dunce::canonicalize(t.path()).expect("canon").join("curseforge").join("minecraft");
        let a = mc.join("Instances").join("Pack A");
        let b = mc.join("Instances").join("Pack B");
        for d in [&a, &b, &mc.join("Install")] {
            fs::create_dir_all(d).expect("mkdir");
        }
        let both = [cf_instance(Launcher::Curseforge, &a), cf_instance(Launcher::Curseforge, &b)];
        assert_eq!(hs_err_dirs(&both), vec![mc.join("Install")], "one entry per Install folder");
        assert!(hs_err_dirs(&[]).is_empty());
        // Other launchers' instances never enable it, even in the same layout.
        assert!(hs_err_dirs(&[cf_instance(Launcher::Manual, &a)]).is_empty());
        // Not under `Instances/`, or no Install folder: nothing.
        let loose = mc.join("Pack C");
        fs::create_dir_all(&loose).expect("mkdir");
        assert!(hs_err_dirs(&[cf_instance(Launcher::Curseforge, &loose)]).is_empty());
        fs::remove_dir(mc.join("Install")).expect("rm");
        assert!(hs_err_dirs(&both).is_empty());
    }
}
