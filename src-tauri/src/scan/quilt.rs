//! Quilt `quilt.mod.json`, including normalisation of Quilt `versions` objects into the
//! OR-of-AND (`RawRange`) form. Ranges are restructured, never evaluated.

use serde_json::Value;

use super::fabric::environment;
use super::util::{excerpt, fabric_any, parse_json_lenient, strip_maven_group, NestedDecl, Parsed};
use crate::model::{Dependency, DependencyKind, LoaderKind, ModMeta, RangeSyntax, RawRange};

/// Maximum number of DNF entries before a range is reported as `unrepresentable`.
pub(crate) const DNF_CAP: usize = 64;

/// Normalise a Quilt `versions` value. Absent → any version.
pub(crate) fn quilt_versions(v: Option<&Value>) -> RawRange {
    let Some(v) = v else { return fabric_any() };
    match dnf(v) {
        Some(entries) => RawRange {
            syntax: RangeSyntax::Fabric,
            raw: entries.into_iter().map(|c| if c.is_empty() { "*".to_string() } else { c.join(" ") }).collect(),
            unrepresentable: None,
        },
        None => RawRange { syntax: RangeSyntax::Fabric, raw: Vec::new(), unrepresentable: Some(v.to_string()) },
    }
}

/// Disjunction of conjunctions. None = not representable (unknown shape or over the cap).
fn dnf(v: &Value) -> Option<Vec<Vec<String>>> {
    match v {
        Value::String(s) => Some(vec![vec![s.clone()]]),
        Value::Array(xs) => any(xs),
        Value::Object(m) if m.len() == 1 => match (m.get("any"), m.get("all")) {
            (Some(Value::Array(xs)), _) => any(xs),
            (_, Some(Value::Array(xs))) => all(xs),
            _ => None,
        },
        _ => None,
    }
}

fn any(xs: &[Value]) -> Option<Vec<Vec<String>>> {
    let mut out = Vec::new();
    for x in xs {
        out.extend(dnf(x)?);
        if out.len() > DNF_CAP {
            return None;
        }
    }
    // An empty disjunction matches nothing; that cannot be written as a RawRange.
    (!out.is_empty()).then_some(out)
}

fn all(xs: &[Value]) -> Option<Vec<Vec<String>>> {
    let mut acc: Vec<Vec<String>> = vec![Vec::new()];
    for x in xs {
        let d = dnf(x)?;
        if acc.len().saturating_mul(d.len()) > DNF_CAP {
            return None;
        }
        let mut next = Vec::with_capacity(acc.len() * d.len());
        for a in &acc {
            for b in &d {
                let mut c = a.clone();
                c.extend(b.iter().cloned());
                next.push(c);
            }
        }
        acc = next;
    }
    Some(acc)
}

/// One `depends`/`breaks` entry: a string id, an object, or an array of alternatives.
fn parse_dep(v: &Value, base: DependencyKind, out: &mut Vec<Dependency>) {
    match v {
        Value::String(id) => out.push(Dependency { mod_id: strip_maven_group(id), kind: base, range: fabric_any(), side: None }),
        Value::Object(o) => {
            let Some(id) = o.get("id").and_then(Value::as_str) else { return };
            let optional = o.get("optional").and_then(Value::as_bool) == Some(true);
            let kind = if optional && base == DependencyKind::Required { DependencyKind::Optional } else { base };
            out.push(Dependency { mod_id: strip_maven_group(id), kind, range: quilt_versions(o.get("versions")), side: None });
        }
        Value::Array(alts) => {
            // "Any one of these" — none of them is individually required.
            let alt_kind = if base == DependencyKind::Required { DependencyKind::Optional } else { base };
            for a in alts {
                parse_dep(a, alt_kind, out);
            }
        }
        _ => {}
    }
}

pub(crate) fn parse_quilt(text: &str, file: &str) -> Result<Parsed, String> {
    let v = parse_json_lenient(text)?;
    let obj = v.as_object().ok_or("not a JSON object")?;
    let ql = obj.get("quilt_loader").and_then(Value::as_object).ok_or("missing \"quilt_loader\"")?;
    let mod_id = ql.get("id").and_then(Value::as_str).ok_or("missing \"quilt_loader.id\"")?.to_string();
    let version = ql.get("version").and_then(Value::as_str).unwrap_or_default().to_string();

    let mut deps = Vec::new();
    for (key, kind) in [("depends", DependencyKind::Required), ("breaks", DependencyKind::Incompatible)] {
        if let Some(Value::Array(xs)) = ql.get(key) {
            for x in xs {
                parse_dep(x, kind, &mut deps);
            }
        }
    }
    let find = |id: &str| {
        deps.iter()
            .find(|d| matches!(d.kind, DependencyKind::Required | DependencyKind::Optional) && d.mod_id == id)
            .map(|d| d.range.clone())
    };
    let mc_range = find("minecraft");
    let loader_range = find("quilt_loader");

    let provides = match ql.get("provides") {
        Some(Value::Array(xs)) => xs
            .iter()
            .filter_map(|p| match p {
                Value::String(s) => Some(strip_maven_group(s)),
                Value::Object(o) => o.get("id").and_then(Value::as_str).map(strip_maven_group),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };

    let mut out = Parsed::default();
    if let Some(Value::Array(jars)) = ql.get("jars") {
        for j in jars.iter().filter_map(Value::as_str) {
            out.nested.push(NestedDecl::plain(j));
        }
    }
    out.mixins = super::util::string_or_array(obj.get("mixin"));

    out.mods.push(ModMeta {
        mod_id,
        version,
        name: ql.get("metadata").and_then(|m| m.get("name")).and_then(Value::as_str).map(str::to_string),
        loader: LoaderKind::Quilt,
        provides,
        environment: environment(obj.get("minecraft").and_then(|m| m.get("environment"))),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(v: Value) -> Vec<String> {
        let r = quilt_versions(Some(&v));
        assert_eq!(r.unrepresentable, None, "unexpectedly unrepresentable: {v}");
        r.raw
    }

    #[test]
    fn string_and_arrays() {
        assert_eq!(raw(json!(">=1.2")), vec![">=1.2"]);
        assert_eq!(raw(json!(["1.2", "1.3"])), vec!["1.2", "1.3"]);
        assert_eq!(raw(json!({"any": ["1.2", "1.3"]})), vec!["1.2", "1.3"]);
        assert_eq!(raw(json!({"all": [">=1.2", "<2"]})), vec![">=1.2 <2"]);
        assert_eq!(raw(json!({"all": []})), vec!["*"]);
        assert_eq!(quilt_versions(None).raw, Vec::<String>::new());
    }

    #[test]
    fn nesting_is_distributed() {
        // (a OR b) AND c AND (d OR (e AND f))
        let v = json!({"all": [{"any": ["a", "b"]}, "c", ["d", {"all": ["e", "f"]}]]});
        assert_eq!(raw(v), vec!["a c d", "a c e f", "b c d", "b c e f"]);
        // any of (all of (x, any(y,z)), w)
        let v = json!({"any": [{"all": ["x", {"any": ["y", "z"]}]}, "w"]});
        assert_eq!(raw(v), vec!["x y", "x z", "w"]);
    }

    #[test]
    fn cap_makes_unrepresentable() {
        // 2^6 = 64 entries: allowed.
        let pair = json!({"any": ["a", "b"]});
        let six = Value::Object(serde_json::Map::from_iter([("all".to_string(), Value::Array(vec![pair.clone(); 6]))]));
        assert_eq!(quilt_versions(Some(&six)).raw.len(), 64);
        // 2^7 = 128 entries: over the cap.
        let seven = Value::Object(serde_json::Map::from_iter([("all".to_string(), Value::Array(vec![pair; 7]))]));
        let r = quilt_versions(Some(&seven));
        assert!(r.raw.is_empty());
        assert_eq!(r.unrepresentable.as_deref(), Some(seven.to_string().as_str()));
        // 65 plain alternatives.
        let many = Value::Array((0..65).map(|i| Value::String(format!("1.{i}"))).collect());
        assert!(quilt_versions(Some(&many)).unrepresentable.is_some());
    }

    #[test]
    fn unknown_shapes_are_unrepresentable() {
        for v in [json!(5), json!({"any": ["a"], "all": ["b"]}), json!({"foo": []}), json!([]), json!([1])] {
            let r = quilt_versions(Some(&v));
            assert!(r.raw.is_empty() && r.unrepresentable.is_some(), "{v}");
        }
    }
}
