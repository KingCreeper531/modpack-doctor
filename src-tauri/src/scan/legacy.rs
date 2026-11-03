//! Legacy Forge `mcmod.info` and Forge/NeoForge `META-INF/jarjar/metadata.json`.
//!
//! Legacy FML (1.12.2 / 1.7.10) enforces `requiredMods` / `dependencies` / `dependants` only for
//! entries with `"useDependencyInformation": true`, and never enforces `mcversion`
//! (docs/research/loader-enforcement.md, "Legacy FML"). So deps — and a `loader_range` from the
//! `forge` entry — are emitted only under that flag, and `mc_range` is always None.

use serde_json::Value;

use super::util::{excerpt, has_placeholder, maven_range, parse_json_lenient, placeholder_id, NestedDecl, Parsed};
use crate::model::{Dependency, DependencyKind, JarJarInfo, LoaderKind, ModEnvironment, ModMeta};

/// `modid@range` (range optional) → dependency.
fn legacy_dep(spec: &str, kind: DependencyKind) -> Option<Dependency> {
    let (id, range) = match spec.split_once('@') {
        Some((id, r)) => (id.trim(), Some(r.trim())),
        None => (spec.trim(), None),
    };
    (!id.is_empty()).then(|| Dependency { mod_id: id.to_string(), kind, range: maven_range(range), side: None })
}

fn strings(v: Option<&Value>) -> Vec<&str> {
    match v {
        Some(Value::Array(xs)) => xs.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn parse_mcmod_info(text: &str, file: &str) -> Result<Parsed, String> {
    let v = parse_json_lenient(text)?;
    let list = match &v {
        Value::Array(xs) => xs.as_slice(),
        Value::Object(o) => match o.get("modList").or_else(|| o.get("modlist")) {
            Some(Value::Array(xs)) => xs.as_slice(),
            _ => return Err("expected an array or {\"modList\": [...]}".into()),
        },
        _ => return Err("expected an array or {\"modList\": [...]}".into()),
    };
    let excerpt = excerpt(text);
    let mut out = Parsed::default();
    for entry in list {
        let Some(o) = entry.as_object() else { continue };
        let Some(mod_id) = o.get("modid").or_else(|| o.get("modId")).and_then(Value::as_str) else { continue };
        if has_placeholder(mod_id) {
            return Err(placeholder_id("modid", mod_id));
        }
        // Legacy FML reads these lists only when the entry opts in; otherwise the real
        // dependencies live in the `@Mod` annotation (not parsed yet), so none are emitted.
        let use_dep_info = o.get("useDependencyInformation").and_then(Value::as_bool) == Some(true);
        let mut deps: Vec<Dependency> = Vec::new();
        if use_dep_info {
            for (key, kind) in [
                ("requiredMods", DependencyKind::Required),
                ("dependencies", DependencyKind::Optional),
                ("dependants", DependencyKind::Optional),
            ] {
                for s in strings(o.get(key)) {
                    if let Some(d) = legacy_dep(s, kind) {
                        if !deps.iter().any(|x| x.mod_id == d.mod_id) {
                            deps.push(d);
                        }
                    }
                }
            }
        }
        let loader_range = deps
            .iter()
            .find(|d| d.mod_id.eq_ignore_ascii_case("forge") && !d.range.raw.is_empty())
            .map(|d| d.range.clone());
        out.mods.push(ModMeta {
            mod_id: mod_id.to_string(),
            version: o.get("version").and_then(Value::as_str).unwrap_or_default().to_string(),
            name: o.get("name").and_then(Value::as_str).map(str::to_string),
            loader: LoaderKind::Legacyforge,
            provides: Vec::new(),
            environment: ModEnvironment::Unknown,
            // `mcversion` is display-only; FML never enforces it.
            mc_range: None,
            loader_range,
            language_loader: None,
            language_range: None,
            deps,
            metadata_file: file.to_string(),
            metadata_excerpt: excerpt.clone(),
        });
    }
    if out.mods.is_empty() {
        return Err("no entry has a \"modid\"".into());
    }
    Ok(out)
}

/// `{"jars":[{"identifier":{"group","artifact"},"version":{"range","artifactVersion"},"path"}]}`.
pub(crate) fn parse_jarjar(text: &str) -> Result<Vec<NestedDecl>, String> {
    let v = parse_json_lenient(text)?;
    let jars = match v.get("jars") {
        Some(Value::Array(xs)) => xs,
        _ => return Err("missing \"jars\" array".into()),
    };
    let s = |v: Option<&Value>, k: &str| v.and_then(|x| x.get(k)).and_then(Value::as_str).map(str::to_string);
    let mut out = Vec::new();
    for j in jars {
        let Some(path) = j.get("path").and_then(Value::as_str) else { continue };
        let ident = j.get("identifier");
        let version = j.get("version");
        let mut decl = NestedDecl::plain(path);
        decl.jarjar = Some(JarJarInfo {
            group: s(ident, "group").unwrap_or_default(),
            artifact: s(ident, "artifact").unwrap_or_default(),
            range: s(version, "range"),
            version: s(version, "artifactVersion"),
        });
        out.push(decl);
    }
    Ok(out)
}
