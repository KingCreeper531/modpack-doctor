//! Instance config files that change what the loader enforces, read next to every instance scan
//! (docs/research/loader-enforcement.md, "Instance config files"):
//!
//! - `config/fml.toml` — NeoForge FML `dependencyOverrides` (`dependencyOverrides.<mod> =
//!   ["-dep", "+dep"]` or a single string). FML ≥ 4.0.34 / 5.0.6 / 6.0.4; Forge has none.
//! - `config/connector.json` — Sinytra Connector `hiddenMods` and `globalModAliases`.
//!
//! Rust extracts raw facts only (CONTRACTS invariant 4): the override strings exactly as written,
//! the Connector fields as written. Whether the running loader supports them, and what they do to
//! a check, is decided in `src/core` (checks/fmlOverrides.ts, checks/connector.ts).
//!
//! Safety: both paths are fixed and joined under the game dir with `PathGuard::join_relative`,
//! resolved with `check_existing` (a symlink pointing outside the PathGuard roots is not read),
//! must be regular files, and are read with a hard cap of [`MAX_CONFIG_BYTES`]. Parsing is
//! lenient: a missing file is silently absent; anything else that goes wrong (unreadable, too
//! large, not UTF-8, invalid TOML/JSON, wrong shapes) becomes a `ScanIssue` whose subject is the
//! relative path, never a failed scan. Messages never contain absolute paths.

use std::io::Read;
use std::path::Path;

use serde_json::Value as Json;
use toml::Value as TomlValue;

use crate::guard::PathGuard;
use crate::model::{ConnectorAlias, ConnectorConfigFile, FmlDependencyOverride, LoaderConfig, ScanIssue, ScanResult};

/// Size cap per config file. Real files are about 1–2 KiB.
pub const MAX_CONFIG_BYTES: u64 = 256 * 1024;
/// NeoForge/Forge FML config (`FMLPaths.FMLCONFIG` = `<gameDir>/config/fml.toml`).
pub const FML_TOML: &str = "config/fml.toml";
/// Sinytra Connector config (`FMLPaths.CONFIGDIR.resolve("connector.json")`).
pub const CONNECTOR_JSON: &str = "config/connector.json";

/// Read both config files of the instance whose game dir is `game_dir`. Never fails: problems are
/// returned as issues. `None` when neither file exists.
pub fn read_loader_config(game_dir: &Path, guard: &PathGuard) -> (Option<LoaderConfig>, Vec<ScanIssue>) {
    let mut issues = Vec::new();
    let mut cfg = LoaderConfig { source_files: Vec::new(), fml_dependency_overrides: Vec::new(), connector: None };
    if let Some(text) = read_config_file(game_dir, FML_TOML, guard, &mut cfg.source_files, &mut issues) {
        cfg.fml_dependency_overrides = parse_fml_toml(&text, &mut issues);
    }
    if let Some(text) = read_config_file(game_dir, CONNECTOR_JSON, guard, &mut cfg.source_files, &mut issues) {
        cfg.connector = parse_connector_json(&text, &mut issues);
    }
    (if cfg.source_files.is_empty() { None } else { Some(cfg) }, issues)
}

/// Read the config files and attach them to a finished instance scan (sets
/// `ScanResult.loader_config`, appends issues, keeps the issue order the scanner uses).
pub fn attach(res: &mut ScanResult, game_dir: &Path, guard: &PathGuard) {
    let (cfg, issues) = read_loader_config(game_dir, guard);
    res.loader_config = cfg;
    if !issues.is_empty() {
        res.issues.extend(issues);
        res.issues.sort_by(|a, b| a.subject.cmp(&b.subject).then_with(|| a.message.cmp(&b.message)));
    }
}

fn issue(rel: &str, message: String) -> ScanIssue {
    ScanIssue { subject: rel.to_string(), message }
}

/// The file's text, or None when it is absent (silently) or unusable (with an issue). Every file
/// that exists is listed in `sources`.
fn read_config_file(game_dir: &Path, rel: &str, guard: &PathGuard, sources: &mut Vec<String>, issues: &mut Vec<ScanIssue>) -> Option<String> {
    let path = PathGuard::join_relative(game_dir, rel).ok()?;
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            sources.push(rel.to_string());
            issues.push(issue(rel, format!("could not be read ({}); its settings are not applied by the checks", e.kind())));
            return None;
        }
        Ok(_) => sources.push(rel.to_string()),
    }
    let unread = |why: &str| issue(rel, format!("{why}, so it was not read; its settings are not applied by the checks"));
    let Ok(canon) = guard.check_existing(&path) else {
        issues.push(unread("points outside the folders Modpack Doctor may access"));
        return None;
    };
    let meta = match std::fs::metadata(&canon) {
        Ok(m) => m,
        Err(e) => {
            issues.push(unread(&format!("could not be opened ({})", e.kind())));
            return None;
        }
    };
    if !meta.is_file() {
        issues.push(unread("is not a regular file"));
        return None;
    }
    if meta.len() > MAX_CONFIG_BYTES {
        issues.push(unread(&format!("is larger than {} KiB", MAX_CONFIG_BYTES / 1024)));
        return None;
    }
    let mut buf = Vec::new();
    let read = std::fs::File::open(&canon).and_then(|f| f.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut buf));
    if let Err(e) = read {
        issues.push(unread(&format!("could not be opened ({})", e.kind())));
        return None;
    }
    if buf.len() as u64 > MAX_CONFIG_BYTES {
        issues.push(unread(&format!("is larger than {} KiB", MAX_CONFIG_BYTES / 1024)));
        return None;
    }
    match String::from_utf8(buf) {
        Ok(text) => Some(text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text)),
        Err(_) => {
            issues.push(issue(rel, "is not UTF-8 text; its settings are not applied by the checks".to_string()));
            None
        }
    }
}

/// `dependencyOverrides` from fml.toml (FML `FMLConfig.load`): a table of mod id → string or
/// list of strings. Entries are kept as written; `src/core` interprets the `+`/`-` prefix.
pub fn parse_fml_toml(text: &str, issues: &mut Vec<ScanIssue>) -> Vec<FmlDependencyOverride> {
    let table: toml::Table = match toml::from_str(text) {
        Ok(t) => t,
        Err(e) => {
            let msg = e.message().trim().trim_end_matches('.').to_string();
            issues.push(issue(FML_TOML, format!("is not valid TOML ({msg}); its dependency overrides are not applied by the checks")));
            return Vec::new();
        }
    };
    let overrides = match table.get("dependencyOverrides") {
        None => return Vec::new(),
        Some(TomlValue::Table(t)) => t,
        Some(_) => {
            issues.push(issue(
                FML_TOML,
                "has a dependencyOverrides value that is not a table; NeoForge ignores all dependency overrides in it".to_string(),
            ));
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for (mod_id, value) in overrides {
        let values: Vec<&TomlValue> = match value {
            TomlValue::Array(a) => a.iter().collect(),
            other => vec![other],
        };
        let mut entries = Vec::new();
        for v in values {
            match v {
                TomlValue::String(s) => entries.push(s.clone()),
                _ => issues.push(issue(
                    FML_TOML,
                    format!("dependencyOverrides.{mod_id} has a value that is not a string; NeoForge can't read it, and the checks ignore it"),
                )),
            }
        }
        if !entries.is_empty() {
            out.push(FmlDependencyOverride { mod_id: mod_id.clone(), entries });
        }
    }
    out.sort_by(|a, b| a.mod_id.cmp(&b.mod_id));
    out
}

/// The fields of connector.json (Connector `ConnectorConfig.CODEC`). None when the file is not a
/// JSON object (Connector then falls back to its defaults); fields of the wrong shape are listed
/// in `invalid_fields`.
pub fn parse_connector_json(text: &str, issues: &mut Vec<ScanIssue>) -> Option<ConnectorConfigFile> {
    let value: Json = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            issues.push(issue(CONNECTOR_JSON, format!("is not valid JSON ({e}); the checks assume Connector's default settings")));
            return None;
        }
    };
    let Json::Object(map) = value else {
        issues.push(issue(CONNECTOR_JSON, "is not a JSON object; the checks assume Connector's default settings".to_string()));
        return None;
    };
    let mut invalid: Vec<String> = Vec::new();
    if let Some(v) = map.get("version") {
        if v.as_f64() != Some(1.0) {
            invalid.push("version".to_string());
        }
    }
    let hidden_mods = match map.get("hiddenMods") {
        None => None,
        Some(v) => {
            let list = string_list(v);
            if list.is_none() {
                invalid.push("hiddenMods".to_string());
            }
            list
        }
    };
    let global_mod_aliases = match map.get("globalModAliases") {
        None => None,
        Some(v) => {
            let aliases = alias_map(v);
            if aliases.is_none() {
                invalid.push("globalModAliases".to_string());
            }
            aliases
        }
    };
    if map.get("enableMixinSafeguard").is_some_and(|v| !v.is_boolean()) {
        invalid.push("enableMixinSafeguard".to_string());
    }
    invalid.sort();
    if !invalid.is_empty() {
        issues.push(issue(
            CONNECTOR_JSON,
            format!(
                "has fields Connector does not accept ({}); depending on its version, Connector then ignores those fields or the whole file",
                invalid.join(", ")
            ),
        ));
    }
    Some(ConnectorConfigFile { hidden_mods, global_mod_aliases, invalid_fields: invalid })
}

fn string_list(v: &Json) -> Option<Vec<String>> {
    v.as_array()?.iter().map(|x| x.as_str().map(str::to_string)).collect()
}

/// `{ "id": "alias" | ["alias", …] }`, sorted by mod id.
fn alias_map(v: &Json) -> Option<Vec<ConnectorAlias>> {
    let mut out = Vec::new();
    for (mod_id, val) in v.as_object()? {
        let aliases = match val {
            Json::String(s) => vec![s.clone()],
            other => string_list(other)?,
        };
        out.push(ConnectorAlias { mod_id: mod_id.clone(), aliases });
    }
    out.sort_by(|a, b| a.mod_id.cmp(&b.mod_id));
    Some(out)
}

#[cfg(test)]
mod tests;
