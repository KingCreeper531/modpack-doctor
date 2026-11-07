//! The `modrinth_*` commands (M5). Each one validates its input, picks the shared client from
//! `AppState.modrinth` for the current `Settings.modrinth_enabled` (off = cache only, no request),
//! and maps errors per CONTRACTS.md invariant 7 (`RateLimited` carries `retryAfterS`).
//!
//! The command bodies are thin wrappers around the `*_with(&AppState, …)` functions below, which
//! the tests drive without a Tauri runtime. Everything runs on the async runtime; the client does
//! its cache and icon I/O with `tokio::fs`.

use std::collections::BTreeMap;

use tauri::State;

use crate::error::{Error, Result};
use crate::model::{HashLookup, MrProject, MrVersion, ProjectLookup};
use crate::modrinth::{validate, ModrinthClient, ModrinthService};
use crate::state::AppState;

use super::Cmd;

// Sanity bounds on IPC input (a large pack has a few hundred top-level jars).
const MAX_HASHES: usize = 5_000;
const MAX_IDS: usize = 1_000;
const MAX_FILTER_VALUES: usize = 64;

fn service(st: &AppState) -> Result<&ModrinthService> {
    st.modrinth.as_ref().ok_or_else(|| {
        Error::Internal("the Modrinth client could not be set up at startup because the app cache folder is unavailable".into())
    })
}

/// The client to use for this call: online, or cache-only when Modrinth is turned off in settings.
fn client(st: &AppState) -> Result<ModrinthClient> {
    let enabled = st.settings.get().modrinth_enabled;
    Ok(service(st)?.client(enabled).clone())
}

fn check_count(what: &str, n: usize, max: usize) -> Result<()> {
    if n > max {
        return Err(Error::Invalid(format!("at most {max} {what} can be looked up at once, got {n}")));
    }
    Ok(())
}

fn check_hashes(sha1s: &[String]) -> Result<()> {
    check_count("hashes", sha1s.len(), MAX_HASHES)?;
    sha1s.iter().try_for_each(|h| validate::sha1(h).map(drop))
}

fn check_filters(loaders: &[String], game_versions: &[String], version_types: Option<&[String]>) -> Result<()> {
    check_count("loaders", loaders.len(), MAX_FILTER_VALUES)?;
    check_count("game versions", game_versions.len(), MAX_FILTER_VALUES)?;
    loaders.iter().try_for_each(|l| validate::filter_value("loader", l).map(drop))?;
    game_versions.iter().try_for_each(|g| validate::filter_value("game version", g).map(drop))?;
    if let Some(types) = version_types {
        check_count("version types", types.len(), MAX_FILTER_VALUES)?;
        types.iter().try_for_each(|t| validate::version_type(t).map(drop))?;
    }
    Ok(())
}

fn check_id(what: &str, id: &str) -> Result<()> {
    validate::id_or_slug(id.trim()).map_err(|_| Error::Invalid(format!("\"{}\" is not a valid {what}", clip(id))))
}

fn clip(s: &str) -> String {
    let mut out: String = s.chars().filter(|c| !c.is_control()).take(48).collect();
    if s.chars().count() > 48 {
        out.push('…');
    }
    out
}

pub(crate) async fn identify_with(st: &AppState, sha1s: Vec<String>, refresh: bool) -> Result<HashLookup> {
    check_hashes(&sha1s)?;
    client(st)?.identify(&sha1s, refresh).await
}

pub(crate) async fn find_updates_with(
    st: &AppState,
    sha1s: Vec<String>,
    loaders: Vec<String>,
    game_versions: Vec<String>,
    version_types: Vec<String>,
    refresh: bool,
) -> Result<HashLookup> {
    check_hashes(&sha1s)?;
    check_filters(&loaders, &game_versions, Some(&version_types))?;
    client(st)?.find_updates(&sha1s, &loaders, &game_versions, &version_types, refresh).await
}

/// Projects plus the icons already on disk (any age). Never downloads an icon and never waits for
/// the CDN: `icons_with` (`modrinth_icons`) is the separate second pass that fetches them.
pub(crate) async fn projects_with(st: &AppState, ids: Vec<String>, refresh: bool) -> Result<ProjectLookup> {
    check_count("projects", ids.len(), MAX_IDS)?;
    for id in &ids {
        check_id("Modrinth project id or slug", id)?;
    }
    let svc = service(st)?;
    let c = client(st)?;
    let (mut lookup, icon_urls) = c.projects_with_icon_urls(&ids, refresh).await?;
    c.attach_cached_icons(&mut lookup, &icon_urls, svc.icon_dir()).await;
    Ok(lookup)
}

/// Project ids (base62) → absolute paths of their icons now on disk, after fetching missing or
/// stale ones. Only invalid input or a missing client fail; icon and network problems never do
/// (the affected projects are just left out). Modrinth off = no request, cached icons only.
pub(crate) async fn icons_with(st: &AppState, project_ids: Vec<String>) -> Result<BTreeMap<String, String>> {
    check_count("project icons", project_ids.len(), MAX_IDS)?;
    for id in &project_ids {
        if !validate::is_base62_id(id) {
            return Err(Error::Invalid(format!("\"{}\" is not a Modrinth project id", clip(id))));
        }
    }
    let svc = service(st)?;
    // Checked before every icon: switching Modrinth off stops a pass that is already running.
    let settings = std::sync::Arc::clone(&st.settings);
    let keep_going = std::sync::Arc::new(move || settings.get().modrinth_enabled);
    Ok(client(st)?.fetch_icons_while(&project_ids, svc.icon_dir(), keep_going).await)
}

pub(crate) async fn project_versions_with(
    st: &AppState,
    project_id: String,
    loaders: Vec<String>,
    game_versions: Vec<String>,
    version_types: Vec<String>,
) -> Result<Vec<MrVersion>> {
    check_id("Modrinth project id or slug", &project_id)?;
    check_filters(&loaders, &game_versions, Some(&version_types))?;
    client(st)?.project_versions(&project_id, &loaders, &game_versions, &version_types).await
}

/// Resolves the mod id, then attaches the project's icon (from the project cache when the slug
/// guess already fetched it). An icon problem never fails the resolution.
pub(crate) async fn resolve_mod_id_with(
    st: &AppState,
    mod_id: String,
    loaders: Vec<String>,
    game_versions: Vec<String>,
) -> Result<Option<MrProject>> {
    check_id("mod id", &mod_id)?;
    check_filters(&loaders, &game_versions, None)?;
    let svc = service(st)?;
    let c = client(st)?;
    let Some(project) = c.resolve_mod_id(&mod_id, &loaders, &game_versions).await? else {
        return Ok(None);
    };
    let id = project.id.clone();
    // Cached icon only: like `modrinth_projects`, never wait for the CDN (`modrinth_icons` fetches).
    let icon_path = match c.projects_with_icon_urls(std::slice::from_ref(&id), false).await {
        Ok((mut lookup, urls)) => {
            c.attach_cached_icons(&mut lookup, &urls, svc.icon_dir()).await;
            lookup.found.get(&id).and_then(|p| p.icon_path.clone())
        }
        Err(_) => None,
    };
    Ok(Some(MrProject { icon_path, ..project }))
}

/// `POST /v2/version_files` (sha1), batched + cached. `refresh` bypasses the disk cache.
#[tauri::command]
#[specta::specta]
pub async fn modrinth_identify(state: State<'_, AppState>, sha1s: Vec<String>, refresh: bool) -> Cmd<HashLookup> {
    Ok(identify_with(&state, sha1s, refresh).await?)
}

/// `POST /v2/version_files/update` with loaders + game versions + version types.
/// Callers always pass loaders and game versions (an unfiltered call returns betas of
/// other MC versions); `version_types` defaults in the UI to `["release"]`.
#[tauri::command]
#[specta::specta]
pub async fn modrinth_find_updates(
    state: State<'_, AppState>,
    sha1s: Vec<String>,
    loaders: Vec<String>,
    game_versions: Vec<String>,
    version_types: Vec<String>,
    refresh: bool,
) -> Cmd<HashLookup> {
    Ok(find_updates_with(&state, sha1s, loaders, game_versions, version_types, refresh).await?)
}

/// `GET /v2/projects?ids=[…]` (ids or slugs, ≤100 per request). `iconPath` is set only for icons
/// already in `paths::icon_cache_dir`: this command never downloads icons, so titles, sides and
/// fixes never wait for the CDN (see `modrinth_icons`).
#[tauri::command]
#[specta::specta]
pub async fn modrinth_projects(state: State<'_, AppState>, ids: Vec<String>, refresh: bool) -> Cmd<ProjectLookup> {
    Ok(projects_with(&state, ids, refresh).await?)
}

/// Downloads missing or stale project icons into `paths::icon_cache_dir` (CDN only, magic-byte
/// checked) and returns project id → absolute cached path for every icon now on disk. Never
/// touches the network when Modrinth is off; stops fetching after the first connection failure.
/// The UI calls it after `modrinth_projects`, as a second pass.
#[tauri::command]
#[specta::specta]
pub async fn modrinth_icons(
    state: State<'_, AppState>,
    project_ids: Vec<String>,
) -> Cmd<std::collections::BTreeMap<String, String>> {
    Ok(icons_with(&state, project_ids).await?)
}

/// `GET /v2/project/{id}/version?loaders=…&game_versions=…` newest first, filtered by
/// `version_types`. Lets src/core choose the version for `InstallDependency`.
#[tauri::command]
#[specta::specta]
pub async fn modrinth_project_versions(
    state: State<'_, AppState>,
    project_id: String,
    loaders: Vec<String>,
    game_versions: Vec<String>,
    version_types: Vec<String>,
) -> Cmd<Vec<MrVersion>> {
    Ok(project_versions_with(&state, project_id, loaders, game_versions, version_types).await?)
}

/// Maps a loader mod id (`cloth_config`) to its Modrinth project: alias table and validated slug
/// guesses, then `/v2/search` (`modrinth::resolve`). `None` = not on Modrinth or a
/// pseudo-dependency (`minecraft`, `java`, loaders). Used by src/core for `InstallDependency`.
#[tauri::command]
#[specta::specta]
pub async fn modrinth_resolve_mod_id(
    state: State<'_, AppState>,
    mod_id: String,
    loaders: Vec<String>,
    game_versions: Vec<String>,
) -> Cmd<Option<MrProject>> {
    Ok(resolve_mod_id_with(&state, mod_id, loaders, game_versions).await?)
}

#[cfg(test)]
mod tests;
