//! Dev tool: run the M5 Modrinth lookups for real instances, READ-ONLY on disk, against the live
//! API (api.modrinth.com only, the app's User-Agent, its rate limiter). Reads the
//! `<instance id>.json` files written by `smoke_scan` and writes `<instance id>.modrinth.json`
//! ({ identify, updates, betaFallback, projects }) next to them, for
//! `SMOKE_DIR=<dir> npx vitest run src/core/__tests__/real-modrinth-smoke.test.ts`.
//!
//!   cargo run --release --example smoke_scan -- <dir>
//!   cargo run --release --example smoke_modrinth -- <dir> <cache dir>
//!
//! Update filters come from the launcher metadata (loader + MC version) with the same loader
//! mapping as `src/core/modrinth` `modrinthLoaders`. The API cache goes to `<cache dir>`, never
//! the app's own cache. Nothing is written outside those two folders.

use std::path::{Path, PathBuf};

use modpack_doctor_lib::model::{HashLookup, Instance, LoaderKind, ScanResult};
use modpack_doctor_lib::modrinth::{ClientConfig, ModrinthClient};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(dir), Some(cache)) = (args.get(1).map(PathBuf::from), args.get(2).map(PathBuf::from)) else {
        eprintln!("usage: smoke_modrinth <smoke_scan dir> <cache dir>");
        std::process::exit(2);
    };
    let client = match ModrinthClient::new(ClientConfig::new(cache, true)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cannot build the Modrinth client: {e}");
            std::process::exit(1);
        }
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("cannot read {}", dir.display());
        std::process::exit(1);
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json") && !p.to_string_lossy().ends_with(".modrinth.json"))
        .collect();
    files.sort();
    println!("{:<44} {:>5} {:>6} {:>7} {:>6}", "instance", "jars", "found", "updates", "failed");
    for file in files {
        if let Err(e) = tauri::async_runtime::block_on(one(&client, &file)) {
            eprintln!("{}: {e}", file.display());
        }
    }
}

async fn one(client: &ModrinthClient, file: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let inst: Instance = serde_json::from_value(v["instance"].clone()).map_err(|e| e.to_string())?;
    let scan: ScanResult = serde_json::from_value(v["scan"].clone()).map_err(|e| e.to_string())?;
    let mut sha1s: Vec<String> =
        scan.jars.iter().filter(|j| j.depth == 0 && !j.sha1.is_empty()).map(|j| j.sha1.to_lowercase()).collect();
    sha1s.sort();
    sha1s.dedup();
    if sha1s.is_empty() {
        return Ok(());
    }
    let identify = client.identify(&sha1s, false).await.map_err(|e| e.to_string())?;
    let (loaders, games) = filters(&inst);
    let (mut updates, mut beta) = (None::<HashLookup>, None::<HashLookup>);
    if !loaders.is_empty() && !games.is_empty() {
        let release = ["release".to_string()];
        let both = ["release".to_string(), "beta".to_string()];
        updates = Some(client.find_updates(&sha1s, &loaders, &games, &release, false).await.map_err(|e| e.to_string())?);
        beta = Some(client.find_updates(&sha1s, &loaders, &games, &both, false).await.map_err(|e| e.to_string())?);
    }
    let mut ids: Vec<String> = identify.found.values().map(|v| v.project_id.clone()).collect();
    ids.sort();
    ids.dedup();
    let projects = client.projects(&ids, false).await.map_err(|e| e.to_string())?;
    let n_up = updates.as_ref().map_or(0, |u| u.found.len());
    println!(
        "{:<44} {:>5} {:>6} {:>7} {:>6}",
        inst.name.chars().take(44).collect::<String>(),
        sha1s.len(),
        identify.found.len(),
        n_up,
        identify.failed.len()
    );
    let out = serde_json::json!({ "identify": identify, "updates": updates, "betaFallback": beta, "projects": projects });
    let path = file.with_extension("modrinth.json");
    std::fs::write(&path, out.to_string()).map_err(|e| e.to_string())
}

/// Same mapping as `src/core/modrinth` `modrinthLoaders`, from launcher metadata.
fn filters(inst: &Instance) -> (Vec<String>, Vec<String>) {
    let mc = inst.mc_version.clone().filter(|m| !m.trim().is_empty());
    let loaders: Vec<&str> = match inst.loader.as_ref().map(|l| l.kind) {
        Some(LoaderKind::Forge | LoaderKind::Legacyforge) => vec!["forge"],
        Some(LoaderKind::Neoforge) if mc.as_deref() == Some("1.20.1") => vec!["neoforge", "forge"],
        Some(LoaderKind::Neoforge) => vec!["neoforge"],
        Some(LoaderKind::Fabric) => vec!["fabric"],
        Some(LoaderKind::Quilt) => vec!["quilt", "fabric"],
        _ => vec![],
    };
    (loaders.into_iter().map(String::from).collect(), mc.into_iter().collect())
}
