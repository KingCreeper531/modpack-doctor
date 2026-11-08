//! Legacy Forge `mcmod.info` and Forge/NeoForge `META-INF/jarjar/metadata.json`.
//!
//! Legacy FML (1.12.2 / 1.7.10) enforces `requiredMods` / `dependencies` / `dependants` only for
//! entries with `"useDependencyInformation": true`, and never enforces `mcversion`
//! (docs/research/loader-enforcement.md, "Legacy FML"). So deps — and a `loader_range` from the
//! `forge` entry — are emitted only under that flag, and `mc_range` is always None.
//!
//! The `@Mod(dependencies = "required-after:forge@[14.23.5,);after:jei")` string FML enforces is
//! parsed here too ([`parse_dependency_string`]); both formats share `legacy_dep` for the
//! `modid@range` part. The annotation itself is read in `annotation.rs`.

use serde_json::Value;

use super::util::{excerpt, has_placeholder, maven_range, parse_json_lenient, placeholder_id, NestedDecl, Parsed};
use crate::model::{Dependency, DependencyKind, JarJarInfo, LoaderKind, ModEnvironment, ModMeta};

/// `modid@range` (range optional) → dependency (FML `VersionParser.parseVersionReference`).
fn legacy_dep(spec: &str, kind: DependencyKind) -> Option<Dependency> {
    let (id, range) = match spec.split_once('@') {
        Some((id, r)) => (id.trim(), Some(r.trim())),
        None => (spec.trim(), None),
    };
    (!id.is_empty()).then(|| Dependency { mod_id: id.to_string(), kind, range: maven_range(range), side: None })
}

/// The legacy FML dependency string (`@Mod(dependencies = …)`), as Forge 1.12.2's
/// `DependencyParser` reads it (a superset of the 1.7.10 forms):
///
/// - `;`-separated entries (empty ones ignored), each `<instructions>:<target>`, where the
///   instructions are `-`-separated tokens from `required`, `before`, `after`, `client`, `server`
///   (`required-after`, `after`, `required-before`, `before`, `required`, `required-client`,
///   `client-required-after`, …) and the target is `modid` or `modid@<maven range>`.
/// - `required` → [`DependencyKind::Required`]; `before`/`after` alone →
///   [`DependencyKind::Optional`] (load ordering, but FML still rejects an installed version
///   outside the range).
/// - `client` / `server` → `side` `CLIENT` / `SERVER` (FML ignores the entry on the other side).
/// - A `*` target (`after:*`, `before:*`) is ordering only and yields nothing.
/// - Entries FML would reject (unknown token, no required/before/after, both before and after,
///   both client and server, not exactly one `:`) yield nothing; the rest of the string still
///   counts. (FML refuses the whole mod then; we only report what we are sure of.)
/// - One dependency per mod id: the first wins, replaced by a later entry that requires it when
///   the first did not.
pub(crate) fn parse_dependency_string(s: &str) -> Vec<Dependency> {
    let mut out: Vec<Dependency> = Vec::new();
    for entry in s.split(';').map(str::trim).filter(|e| !e.is_empty()) {
        let parts: Vec<&str> = entry.split(':').map(str::trim).filter(|p| !p.is_empty()).collect();
        let [instructions, target] = parts.as_slice() else { continue };
        let (mut required, mut before, mut after, mut client, mut server) = (false, false, false, false, false);
        let mut ok = true;
        for token in instructions.split('-').map(str::trim).filter(|t| !t.is_empty()) {
            match token {
                "required" => required = true,
                "before" => before = true,
                "after" => after = true,
                "client" => client = true,
                "server" => server = true,
                _ => ok = false,
            }
        }
        if !ok || !(required || before || after) || (before && after) || (client && server) {
            continue;
        }
        if target.starts_with('*') {
            continue; // ordering against every mod; never a dependency
        }
        let kind = if required { DependencyKind::Required } else { DependencyKind::Optional };
        let Some(mut dep) = legacy_dep(target, kind) else { continue };
        dep.side = if client {
            Some("CLIENT".to_string())
        } else if server {
            Some("SERVER".to_string())
        } else {
            None
        };
        match out.iter_mut().find(|d| d.mod_id == dep.mod_id) {
            Some(existing) => {
                if dep.kind == DependencyKind::Required && existing.kind != DependencyKind::Required {
                    *existing = dep;
                }
            }
            None => out.push(dep),
        }
    }
    out
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
        // dependencies live in the `@Mod` annotation (`annotation.rs` adds them), so none are
        // emitted here.
        let use_dep_info = o.get("useDependencyInformation").and_then(Value::as_bool) == Some(true);
        if use_dep_info {
            out.uses_dependency_information.push(mod_id.to_string());
        }
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
