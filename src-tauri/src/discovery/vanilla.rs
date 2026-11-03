//! Vanilla launcher `.minecraft` and its `launcher_profiles.json`. launchers.md §4.
//! Account files (`launcher_accounts*.json`) are never read.

use std::path::{Path, PathBuf};

use crate::model::{Launcher, LoaderInfo, LoaderKind, ProbeResult, Side};

use super::common::{
    build, is_dir, json_get, json_str, location_key, read_json, Meta, NewInstance, Outcome,
};
use super::env::{Env, Os};

pub(crate) fn candidates(env: &Env) -> Vec<PathBuf> {
    match env.os {
        Os::Windows => vec![env.data_dir().join(".minecraft")],
        Os::MacOs => vec![env.data_dir().join("minecraft")],
        Os::Linux => vec![
            env.home.join(".minecraft"),
            env.home.join(".var").join("app").join("com.mojang.Minecraft").join(".minecraft"),
        ],
    }
}

#[derive(Debug, Clone, Default)]
struct Profile {
    name: Option<String>,
    kind: Option<String>,
    last_version_id: Option<String>,
    last_used: Option<String>,
    game_dir: Option<String>,
}

const PROFILE_FILES: &[&str] = &["launcher_profiles.json", "launcher_profiles_microsoft_store.json"];

pub(crate) fn probe(env: &Env, root: &Path) -> Outcome {
    let launcher = Launcher::Vanilla;
    if let Some(o) = Outcome::from_dir_state(launcher, root) {
        return o;
    }
    let mut out = Outcome::new(launcher, root, ProbeResult::NotInstalled);

    let mut profiles = Vec::new();
    for file in PROFILE_FILES {
        match read_json(&root.join(file)) {
            Ok(Some(v)) => match json_get(&v, "profiles").and_then(|p| p.as_object()) {
                Some(map) => profiles.extend(map.values().map(|p| Profile {
                    name: json_str(p, "name"),
                    kind: json_str(p, "type"),
                    last_version_id: json_str(p, "lastVersionId"),
                    last_used: json_str(p, "lastUsed"),
                    game_dir: json_str(p, "gameDir"),
                })),
                None => out.note(format!("{file} has no profiles")),
            },
            Ok(None) => {}
            Err(m) => out.note(format!("{m} — listing .minecraft only")),
        }
    }

    // Group profiles by resolved game dir; the root itself is one group.
    let root_key = location_key(root, env.os);
    let mut groups: Vec<(String, PathBuf, Vec<Profile>)> = Vec::new();
    let mut root_used = profiles.is_empty();
    for p in profiles {
        let dir = match &p.game_dir {
            None => root.to_path_buf(),
            Some(gd) => {
                let gd = PathBuf::from(gd);
                if gd.is_absolute() {
                    gd
                } else {
                    root.join(gd)
                }
            }
        };
        let key = location_key(&dir, env.os);
        if key == root_key {
            root_used = true;
        }
        match groups.iter_mut().find(|(k, _, _)| *k == key) {
            Some((_, _, list)) => list.push(p),
            None => groups.push((key, dir, vec![p])),
        }
    }
    if root_used && !groups.iter().any(|(k, _, _)| *k == root_key) {
        groups.insert(0, (root_key.clone(), root.to_path_buf(), Vec::new()));
    }
    // Root first, then the others in a stable order.
    groups.sort_by(|a, b| (a.0 != root_key).cmp(&(b.0 != root_key)).then_with(|| a.0.cmp(&b.0)));

    for (key, dir, list) in groups {
        let is_root = key == root_key;
        if !is_root && !is_dir(&dir) {
            let who = list.iter().find_map(|p| p.name.clone()).unwrap_or_else(|| "a profile".into());
            out.note(format!("{who}: game folder {} does not exist", super::common::display(&dir)));
            continue;
        }
        // Most recently used profile describes the folder.
        let best = list.iter().max_by(|a, b| a.last_used.cmp(&b.last_used)).cloned().unwrap_or_default();
        let name = best
            .name
            .clone()
            .or_else(|| match best.kind.as_deref() {
                Some("latest-release") => Some("Latest release".to_string()),
                Some("latest-snapshot") => Some("Latest snapshot".to_string()),
                _ => None,
            })
            .unwrap_or_else(|| {
                if is_root {
                    "Minecraft".to_string()
                } else {
                    dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Minecraft".into())
                }
            });
        let meta = best.last_version_id.as_deref().map(|id| version_meta(root, id)).unwrap_or_else(Meta::inferred);
        out.instances.push(build(
            env.os,
            NewInstance { launcher, name, root: &dir, game_dir: &dir, meta, side: Side::Client },
        ));
    }
    out.finish()
}

/// MC version + loader from a `lastVersionId`, confirmed by `versions/<id>/<id>.json`.
fn version_meta(root: &Path, id: &str) -> Meta {
    let (mut mc, mut loader) = parse_version_id(id);
    let json = if is_safe_id(id) {
        read_json(&root.join("versions").join(id).join(format!("{id}.json"))).ok().flatten()
    } else {
        None
    };
    if let Some(v) = json {
        match json_str(&v, "inheritsFrom") {
            Some(parent) => mc = Some(parent),
            None if loader.is_none() => mc = json_str(&v, "id").or(mc),
            None => {}
        }
        if loader.is_none() {
            loader = loader_from_libraries(&v);
        }
    }
    if mc.is_none() && loader.is_none() {
        return Meta::inferred();
    }
    Meta::launcher(mc, loader)
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && !id.contains(['/', '\\']) && id != "." && id != ".."
}

fn loader_from_libraries(v: &serde_json::Value) -> Option<LoaderInfo> {
    let libs = json_get(v, "libraries")?.as_array()?;
    for lib in libs {
        let Some(name) = json_str(lib, "name") else { continue };
        let mut parts = name.split(':');
        let (Some(group), Some(artifact), version) = (parts.next(), parts.next(), parts.next()) else { continue };
        let kind = match (group, artifact) {
            ("net.fabricmc", "fabric-loader") => LoaderKind::Fabric,
            ("org.quiltmc", "quilt-loader") => LoaderKind::Quilt,
            ("net.neoforged", "neoforge") => LoaderKind::Neoforge,
            ("net.minecraftforge", "forge") => LoaderKind::Forge,
            _ => continue,
        };
        let version = version.map(|v| match kind {
            // Forge library versions are `<mc>-<forge>`.
            LoaderKind::Forge => v.split_once('-').map(|(_, f)| f.to_string()).unwrap_or_else(|| v.to_string()),
            _ => v.to_string(),
        });
        return Some(LoaderInfo { kind, version });
    }
    None
}

/// `fabric-loader-0.15.11-1.20.1`, `quilt-loader-0.26.4-1.20.1`, `1.20.1-forge-47.3.0`,
/// `1.12.2-forge1.12.2-14.23.5.2860`, `neoforge-21.1.77`, plain `1.20.1`.
pub(crate) fn parse_version_id(id: &str) -> (Option<String>, Option<LoaderInfo>) {
    let id = id.trim();
    let lower = id.to_ascii_lowercase();
    for (prefix, kind) in [("fabric-loader-", LoaderKind::Fabric), ("quilt-loader-", LoaderKind::Quilt)] {
        if lower.starts_with(prefix) {
            let rest = &id[prefix.len()..];
            let (lv, mc) = match rest.split_once('-') {
                Some((lv, mc)) => (lv, Some(mc.to_string()).filter(|m| !m.is_empty())),
                None => (rest, None),
            };
            return (mc, Some(LoaderInfo { kind, version: Some(lv.to_string()).filter(|v| !v.is_empty()) }));
        }
    }
    if lower.starts_with("neoforge-") {
        let v = &id["neoforge-".len()..];
        return (neoforge_mc(v), Some(LoaderInfo { kind: LoaderKind::Neoforge, version: Some(v.to_string()) }));
    }
    for (marker, kind) in [("-neoforge", LoaderKind::Neoforge), ("-forge", LoaderKind::Forge)] {
        if let Some(idx) = lower.find(marker) {
            let mc = &id[..idx];
            let mut rest = id[idx + marker.len()..].trim_start_matches('-');
            if let Some(r) = rest.strip_prefix(mc) {
                rest = r.trim_start_matches('-');
            }
            if let Some(r) = rest.strip_suffix(&format!("-{mc}")) {
                rest = r;
            }
            let version = Some(rest.to_string()).filter(|v| !v.is_empty());
            return (Some(mc.to_string()).filter(|m| !m.is_empty()), Some(LoaderInfo { kind, version }));
        }
    }
    if matches!(lower.as_str(), "latest-release" | "latest-snapshot") {
        return (None, None);
    }
    // Plain vanilla ids start with a digit (`1.20.1`, `26.1`, `23w51a`).
    if id.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return (Some(id.to_string()), None);
    }
    (None, None)
}

/// NeoForge version → MC version: `21.1.77` → `1.21.1`, `20.2.3` → `1.20.2`, `21.0.1` → `1.21`;
/// year-based `26.1.0.5` → `26.1`, `26.1.2.3` → `26.1.2`.
fn neoforge_mc(v: &str) -> Option<String> {
    let parts: Vec<&str> = v.split(['.', '-', '+']).collect();
    let major: u32 = parts.first()?.parse().ok()?;
    let minor: u32 = parts.get(1)?.parse().ok()?;
    if major >= 25 {
        let patch: u32 = parts.get(2).and_then(|p| p.parse().ok()).unwrap_or(0);
        return Some(if patch == 0 { format!("{major}.{minor}") } else { format!("{major}.{minor}.{patch}") });
    }
    Some(if minor == 0 { format!("1.{major}") } else { format!("1.{major}.{minor}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lk(id: &str) -> (Option<String>, Option<(LoaderKind, Option<String>)>) {
        let (mc, l) = parse_version_id(id);
        (mc, l.map(|l| (l.kind, l.version)))
    }

    #[test]
    fn version_ids() {
        let s = |x: &str| Some(x.to_string());
        assert_eq!(lk("fabric-loader-0.15.11-1.20.1"), (s("1.20.1"), Some((LoaderKind::Fabric, s("0.15.11")))));
        assert_eq!(lk("quilt-loader-0.26.4-26.1"), (s("26.1"), Some((LoaderKind::Quilt, s("0.26.4")))));
        assert_eq!(lk("1.20.1-forge-47.3.0"), (s("1.20.1"), Some((LoaderKind::Forge, s("47.3.0")))));
        assert_eq!(lk("1.12.2-forge1.12.2-14.23.5.2860"), (s("1.12.2"), Some((LoaderKind::Forge, s("14.23.5.2860")))));
        assert_eq!(lk("1.7.10-Forge10.13.4.1614-1.7.10"), (s("1.7.10"), Some((LoaderKind::Forge, s("10.13.4.1614")))));
        assert_eq!(lk("neoforge-21.1.77"), (s("1.21.1"), Some((LoaderKind::Neoforge, s("21.1.77")))));
        assert_eq!(lk("neoforge-20.2.3-beta"), (s("1.20.2"), Some((LoaderKind::Neoforge, s("20.2.3-beta")))));
        assert_eq!(lk("neoforge-26.1.0.5-beta"), (s("26.1"), Some((LoaderKind::Neoforge, s("26.1.0.5-beta")))));
        assert_eq!(lk("1.20.1-neoforge-47.1.106"), (s("1.20.1"), Some((LoaderKind::Neoforge, s("47.1.106")))));
        assert_eq!(lk("1.20.1"), (s("1.20.1"), None));
        assert_eq!(lk("26.4-snapshot-6"), (s("26.4-snapshot-6"), None));
        assert_eq!(lk("latest-release"), (None, None));
        assert_eq!(lk("OptiFine HD"), (None, None));
    }
}
