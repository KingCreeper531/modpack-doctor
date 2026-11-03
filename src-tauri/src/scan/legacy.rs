//! Legacy Forge `mcmod.info` and Forge/NeoForge `META-INF/jarjar/metadata.json`.

use serde_json::Value;

use super::util::{excerpt, maven_range, parse_json_lenient, NestedDecl, Parsed};
use crate::model::{Dependency, DependencyKind, JarJarInfo, LoaderKind, ModEnvironment, ModMeta, RawRange};

/// `modid@range` (range optional) → dependency.
fn legacy_dep(spec: &str, kind: DependencyKind) -> Option<Dependency> {
    let (id, range) = match spec.split_once('@') {
        Some((id, r)) => (id.trim(), Some(r.trim())),
        None => (spec.trim(), None),
    };
    (!id.is_empty()).then(|| Dependency { mod_id: id.to_string(), kind, range: maven_range(range), side: None })
}

/// `mcversion` is a single version (`1.12.2`); expressed as the exact Maven range `[1.12.2]`.
/// Values that already look like a range pass through; unexpanded `${…}` placeholders are dropped.
fn mc_version_range(v: Option<&str>) -> Option<RawRange> {
    let v = v?.trim();
    if v.is_empty() || v.contains("${") {
        return None;
    }
    if v.starts_with(['[', '(']) {
        Some(maven_range(Some(v)))
    } else {
        Some(maven_range(Some(&format!("[{v}]"))))
    }
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
        let mut deps: Vec<Dependency> = strings(o.get("requiredMods"))
            .into_iter()
            .filter_map(|s| legacy_dep(s, DependencyKind::Required))
            .collect();
        for s in strings(o.get("dependencies")) {
            if let Some(d) = legacy_dep(s, DependencyKind::Optional) {
                if !deps.iter().any(|x| x.mod_id == d.mod_id) {
                    deps.push(d);
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
            mc_range: mc_version_range(o.get("mcversion").and_then(Value::as_str)),
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
