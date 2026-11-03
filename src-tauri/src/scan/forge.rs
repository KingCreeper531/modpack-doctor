//! Forge `META-INF/mods.toml`, NeoForge `META-INF/neoforge.mods.toml`, and
//! `META-INF/MANIFEST.MF`.

use toml::{Table, Value};

use super::util::{excerpt, has_placeholder, maven_range, placeholder_id, Parsed};
use crate::model::{Dependency, DependencyKind, LoaderKind, ModEnvironment, ModMeta};

/// Main section of `META-INF/MANIFEST.MF` (continuation lines joined).
#[derive(Debug, Default)]
pub(crate) struct Manifest {
    attrs: Vec<(String, String)>,
}

impl Manifest {
    pub fn parse(text: &str) -> Self {
        let mut attrs: Vec<(String, String)> = Vec::new();
        for line in text.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.is_empty() {
                break; // end of the main section
            }
            if let Some(cont) = line.strip_prefix(' ') {
                if let Some((_, v)) = attrs.last_mut() {
                    v.push_str(cont);
                }
                continue;
            }
            if let Some((k, v)) = line.split_once(':') {
                attrs.push((k.trim().to_string(), v.trim_start().to_string()));
            }
        }
        Manifest { attrs }
    }

    /// Case-insensitive attribute lookup (first match).
    pub fn get(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
    }

    /// `MixinConfigs: a.mixins.json,b.mixins.json`.
    pub fn mixin_configs(&self) -> Vec<String> {
        self.get("MixinConfigs")
            .map(|v| v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect())
            .unwrap_or_default()
    }
}

const JAR_VERSION: &str = "${file.jarVersion}";

fn resolve_placeholders(s: &str, manifest: &Manifest) -> String {
    match manifest.get("Implementation-Version") {
        Some(v) if s.contains(JAR_VERSION) => s.replace(JAR_VERSION, v),
        _ => s.to_string(),
    }
}

fn str_of<'a>(t: &'a Table, key: &str) -> Option<&'a str> {
    t.get(key).and_then(Value::as_str)
}

/// Parse a mods.toml-format file. `neoforge_file` = it is `META-INF/neoforge.mods.toml`, so
/// every entry is NeoForge; otherwise each entry is classified by its dependency ids.
pub(crate) fn parse_mods_toml(text: &str, file: &str, neoforge_file: bool, manifest: &Manifest) -> Result<Parsed, String> {
    let table: Table = toml::from_str(text).map_err(|e| format!("invalid TOML: {}", e.message()))?;

    let language_loader = str_of(&table, "modLoader").map(str::to_string);
    let language_range = str_of(&table, "loaderVersion").map(|s| maven_range(Some(s)));
    let client_only = table.get("clientSideOnly").and_then(Value::as_bool) == Some(true);
    let deps_table = table.get("dependencies").and_then(Value::as_table);

    let mods = match table.get("mods") {
        Some(Value::Array(a)) => a.as_slice(),
        _ => return Err("no [[mods]] entries".into()),
    };
    let excerpt = excerpt(text);
    let mut out = Parsed::default();

    for m in mods {
        let Some(m) = m.as_table() else { continue };
        let Some(mod_id) = str_of(m, "modId") else { continue };
        if has_placeholder(mod_id) {
            return Err(placeholder_id("modId", mod_id));
        }
        // Forge's own default when `version` is omitted.
        let version = resolve_placeholders(str_of(m, "version").unwrap_or("1"), manifest);
        let name = str_of(m, "displayName").map(str::to_string);

        let deps: Vec<Dependency> = match deps_table.and_then(|d| d.get(mod_id)) {
            Some(Value::Array(a)) => a.iter().filter_map(|d| d.as_table()).filter_map(|d| parse_dep(d, manifest)).collect(),
            Some(Value::Table(d)) => parse_dep(d, manifest).into_iter().collect(),
            _ => Vec::new(),
        };

        let has = |id: &str| deps.iter().any(|d| d.mod_id == id);
        let loader = if neoforge_file || has("neoforge") { LoaderKind::Neoforge } else { LoaderKind::Forge };
        let loader_dep = if loader == LoaderKind::Neoforge { "neoforge" } else { "forge" };
        let find = |id: &str| deps.iter().find(|d| d.mod_id == id).map(|d| d.range.clone());

        out.mods.push(ModMeta {
            mod_id: mod_id.to_string(),
            version,
            name,
            loader,
            provides: Vec::new(),
            environment: if client_only { ModEnvironment::Client } else { ModEnvironment::Unknown },
            mc_range: find("minecraft"),
            loader_range: find(loader_dep),
            language_loader: language_loader.clone(),
            language_range: language_range.clone(),
            deps,
            metadata_file: file.to_string(),
            metadata_excerpt: excerpt.clone(),
        });
    }
    if out.mods.is_empty() {
        return Err("no [[mods]] entry has a modId".into());
    }

    if let Some(Value::Array(mixins)) = table.get("mixins") {
        for m in mixins.iter().filter_map(Value::as_table) {
            if let Some(cfg) = str_of(m, "config") {
                out.mixins.push(cfg.to_string());
            }
        }
    }
    Ok(out)
}

fn parse_dep(d: &Table, manifest: &Manifest) -> Option<Dependency> {
    let mod_id = str_of(d, "modId")?.to_string();
    let kind = if let Some(ty) = str_of(d, "type") {
        match ty.to_ascii_lowercase().as_str() {
            "optional" => DependencyKind::Optional,
            "incompatible" => DependencyKind::Incompatible,
            "discouraged" => DependencyKind::Conflicts,
            _ => DependencyKind::Required,
        }
    } else {
        match d.get("mandatory").and_then(Value::as_bool) {
            Some(false) => DependencyKind::Optional,
            _ => DependencyKind::Required,
        }
    };
    let range = str_of(d, "versionRange").map(|r| resolve_placeholders(r, manifest));
    Some(Dependency { mod_id, kind, range: maven_range(range.as_deref()), side: str_of(d, "side").map(str::to_string) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_continuation_and_case() {
        let m = Manifest::parse("Manifest-Version: 1.0\r\nMixinConfigs: a.mixins.json,\r\n b.mixins.json\r\nimplementation-version: 2.1\r\n\r\nName: x\r\nFoo: bar\r\n");
        assert_eq!(m.mixin_configs(), vec!["a.mixins.json", "b.mixins.json"]);
        assert_eq!(m.get("Implementation-Version"), Some("2.1"));
        assert_eq!(m.get("Foo"), None);
    }
}
