//! The app's single Modrinth access point, held in `AppState` (CONTRACTS.md invariant 10, M5).
//!
//! Two clients over the same disk cache: an online one, built once so its rate limiter and
//! concurrency bound live as long as the app, and an offline twin that never sends a request.
//! Every command picks one from `Settings.modrinth_enabled` at call time, so toggling the setting
//! applies to the next command without a restart and never resets the online client's limiter.

use std::path::{Path, PathBuf};

use super::{ClientConfig, ModrinthClient, Tuning};
use crate::error::Result;

#[derive(Clone)]
pub struct ModrinthService {
    online: ModrinthClient,
    offline: ModrinthClient,
    icon_dir: PathBuf,
}

impl std::fmt::Debug for ModrinthService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModrinthService").field("icon_dir", &self.icon_dir).finish_non_exhaustive()
    }
}

impl ModrinthService {
    /// Production clients: API cache in `cache_dir` (`paths::api_cache_dir`), icons in
    /// `icon_dir` (`paths::icon_cache_dir`, the asset-protocol scope).
    pub fn new(cache_dir: PathBuf, icon_dir: PathBuf) -> Result<Self> {
        Self::with_tuning(ClientConfig::new(cache_dir, true), Tuning::default(), icon_dir)
    }

    /// Built from the app's directories (see `paths`).
    pub fn for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self> {
        Self::new(crate::paths::api_cache_dir(app)?, crate::paths::icon_cache_dir(app)?)
    }

    /// `cfg.online` is ignored: both clients are built from `cfg`.
    pub(crate) fn with_tuning(cfg: ClientConfig, t: Tuning, icon_dir: PathBuf) -> Result<Self> {
        let online = ModrinthClient::with_tuning(ClientConfig { online: true, ..cfg.clone() }, t.clone())?;
        let offline = ModrinthClient::with_tuning(ClientConfig { online: false, ..cfg }, t)?;
        Ok(ModrinthService { online, offline, icon_dir })
    }

    /// The client for the current `Settings.modrinth_enabled`: `false` = cache only.
    pub fn client(&self, enabled: bool) -> &ModrinthClient {
        if enabled {
            &self.online
        } else {
            &self.offline
        }
    }

    /// Against a wiremock server (`http://` allowed, fast retries), real User-Agent.
    #[cfg(test)]
    pub(crate) fn for_tests(base_url: String, cdn_host: String, cache_dir: PathBuf, icon_dir: PathBuf) -> Self {
        use std::time::Duration;
        let cfg = ClientConfig { base_url, cdn_host, cache_dir, user_agent: crate::USER_AGENT.into(), online: true };
        let policy = super::http::RetryPolicy {
            max_retries: 2,
            max_connect_retries: 0,
            backoff_base: Duration::from_millis(1),
            backoff_cap: Duration::from_millis(5),
            min_429_wait: Duration::ZERO,
        };
        let t = Tuning { allow_http: true, policy, ..Tuning::default() };
        Self::with_tuning(cfg, t, icon_dir).expect("test Modrinth service")
    }

    /// Where project icons are cached (absolute; `MrProject.icon_path` points inside it).
    pub fn icon_dir(&self) -> &Path {
        &self.icon_dir
    }
}
