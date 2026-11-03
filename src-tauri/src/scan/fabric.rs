//! Fabric `fabric.mod.json` (parsed leniently as JSON5).

use serde_json::Value;

use super::util::{excerpt, has_placeholder, parse_json_lenient, placeholder_id, placeholder_range, string_or_array, NestedDecl, Parsed};
use crate::model::{Dependency, DependencyKind, LoaderKind, ModEnvironment, ModMeta, RangeSyntax, RawRange};

const DEP_KEYS: [(&str, DependencyKind); 5] = [
    ("depends", DependencyKind::Required),
    ("recommends", DependencyKind::Recommended),
    ("suggests", DependencyKind::Optional),
    ("breaks", DependencyKind::Breaks),
    ("conflicts", DependencyKind::Conflicts),
];

/// Fabric version predicate value: a string, or an array of strings (OR).
/// A `${…}` placeholder anywhere makes it `unrepresentable` (the string, or the JSON array).
fn fabric_range(v: &Value) -> RawRange {
    match v {
        Value::String(s) if has_placeholder(s) => placeholder_range(RangeSyntax::Fabric, s.clone()),
        Value::Array(xs) if xs.iter().any(|x| x.as_str().is_some_and(has_placeholder)) => {
            placeholder_range(RangeSyntax::Fabric, v.to_string())
        }
        Value::String(s) => RawRange { syntax: RangeSyntax::Fabric, raw: vec![s.clone()], unrepresentable: None },
        Value::Array(xs) if xs.iter().all(Value::is_string) => RawRange {
            syntax: RangeSyntax::Fabric,
            raw: xs.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
            unrepresentable: None,
        },
        other => RawRange { syntax: RangeSyntax::Fabric, raw: Vec::new(), unrepresentable: Some(other.to_string()) },
    }
}

pub(crate) fn environment(v: Option<&Value>) -> ModEnvironment {
    match v.and_then(Value::as_str) {
        // Fabric's default environment is "*".
        None | Some("*") => ModEnvironment::Both,
        Some("client") => ModEnvironment::Client,
        Some("server") | Some("dedicated_server") => ModEnvironment::Server,
        Some(_) => ModEnvironment::Unknown,
    }
}

pub(crate) fn parse_fabric(text: &str, file: &str) -> Result<Parsed, String> {
    let v = parse_json_lenient(text)?;
    let obj = v.as_object().ok_or("not a JSON object")?;
    let mod_id = obj.get("id").and_then(Value::as_str).ok_or("missing \"id\"")?.to_string();
    if has_placeholder(&mod_id) {
        return Err(placeholder_id("id", &mod_id));
    }
    let version = obj.get("version").and_then(Value::as_str).unwrap_or_default().to_string();

    let mut deps = Vec::new();
    for (key, kind) in DEP_KEYS {
        if let Some(map) = obj.get(key).and_then(Value::as_object) {
            for (id, range) in map {
                deps.push(Dependency { mod_id: id.clone(), kind, range: fabric_range(range), side: None });
            }
        }
    }
    let find = |id: &str| {
        deps.iter().find(|d| d.kind == DependencyKind::Required && d.mod_id == id).map(|d| d.range.clone())
    };
    let mc_range = find("minecraft");
    let loader_range = find("fabricloader");

    let mut out = Parsed::default();
    if let Some(Value::Array(mixins)) = obj.get("mixins") {
        for m in mixins {
            match m {
                Value::String(s) => out.mixins.push(s.clone()),
                Value::Object(o) => {
                    if let Some(cfg) = o.get("config").and_then(Value::as_str) {
                        out.mixins.push(cfg.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(Value::Array(jars)) = obj.get("jars") {
        for j in jars {
            if let Some(f) = j.get("file").and_then(Value::as_str) {
                out.nested.push(NestedDecl::plain(f));
            }
        }
    }

    out.mods.push(ModMeta {
        mod_id,
        version,
        name: obj.get("name").and_then(Value::as_str).map(str::to_string),
        loader: LoaderKind::Fabric,
        provides: string_or_array(obj.get("provides")),
        environment: environment(obj.get("environment")),
        mc_range,
        loader_range,
        language_loader: None,
        language_range: None,
        deps,
        metadata_file: file.to_string(),
        metadata_excerpt: excerpt(text),
    });
    Ok(out)
}
