//! App-owned directories. The icon cache must stay in lock-step with the asset-protocol
//! scope in tauri.conf.json (`$APPCACHE/icons/**`); a test enforces it.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

use crate::error::{Error, Result};

/// Sub-directory of `app_cache_dir()` that the asset protocol may serve.
pub const ICON_CACHE_SUBDIR: &str = "icons";
/// The exact scope string expected in tauri.conf.json.
pub const ICON_ASSET_SCOPE: &str = "$APPCACHE/icons/**";

/// `<app cache>/icons`. Never wipe `app_cache_dir()` itself: on Windows it is also the
/// WebView2 profile directory.
pub fn icon_cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| Error::Internal(format!("could not resolve the app cache directory: {e}")))?;
    Ok(base.join(ICON_CACHE_SUBDIR))
}

/// `<app data>/backups`.
pub fn backups_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| Error::Internal(format!("could not resolve the app data directory: {e}")))?;
    Ok(base.join("backups"))
}

/// `<app cache>/modrinth` — API response cache.
pub fn api_cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| Error::Internal(format!("could not resolve the app cache directory: {e}")))?;
    Ok(base.join("modrinth"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_scope_matches_icon_cache_dir() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid tauri.conf.json");
        let scope = &conf["app"]["security"]["assetProtocol"]["scope"];
        assert_eq!(scope, &serde_json::json!([ICON_ASSET_SCOPE]), "asset scope must be exactly the icon cache");
        assert_eq!(ICON_ASSET_SCOPE, format!("$APPCACHE/{ICON_CACHE_SUBDIR}/**"));
    }
}
