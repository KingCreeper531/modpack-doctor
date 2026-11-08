//! The fix engine's view of Modrinth: blocking calls into the shared async `ModrinthClient`.
//! Planning and execution run on a blocking thread and drive the client through a runtime
//! handle, so file work never blocks the async runtime.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use tokio::runtime::Handle;

use crate::error::{Error, Result};
use crate::model::{MrProject, MrVersion};
use crate::modrinth::ModrinthClient;

pub trait Remote: Send + Sync {
    /// `GET /v2/version/{id}`, always from the network: never a cached or stale copy
    /// (CONTRACTS.md invariant 14). A network failure is an error.
    fn version(&self, version_id: &str) -> Result<MrVersion>;
    /// The version a sha1 belongs to, asked from the network (`refresh`). `Ok(None)` = not on
    /// Modrinth; `Err(Offline)` when Modrinth could not be reached.
    fn identify(&self, sha1: &str) -> Result<Option<MrVersion>>;
    /// Many sha1s in one batched lookup from the network (`refresh`): (sha1 → version, hashes
    /// whose batch failed). A hash in neither is not on Modrinth. `Err(Offline)` when Modrinth
    /// could not be reached.
    fn identify_many(&self, sha1s: &[String]) -> Result<(HashMap<String, MrVersion>, HashSet<String>)>;
    /// The Modrinth project id Rust itself resolves for a loader mod id (`resolve_mod_id`,
    /// narrowed to the pack's Modrinth loaders and Minecraft version). `Ok(None)` = not on
    /// Modrinth.
    fn resolve_mod_id(&self, mod_id: &str, loaders: &[String], game_versions: &[String]) -> Result<Option<String>>;
    /// The project's title, best effort (None on any problem).
    fn project_title(&self, project_id: &str) -> Option<String>;
    /// The project (slug, title, client/server sides), best effort (None on any problem).
    fn project(&self, project_id: &str) -> Option<MrProject>;
    /// CDN-only, size-capped, SHA-512-verified download into `<dir>/.<name>.part` (created with
    /// `create_new`, fsynced).
    fn download(&self, url: &str, sha512: &str, size: u64, dir: &Path, name: &str) -> Result<PathBuf>;
}

/// [`Remote`] over the app's shared online client. Must be called from a thread that is not
/// running async code (it blocks on `handle`).
pub struct ClientRemote {
    client: ModrinthClient,
    handle: Handle,
}

impl ClientRemote {
    pub fn new(client: ModrinthClient, handle: Handle) -> Self {
        ClientRemote { client, handle }
    }
}

impl Remote for ClientRemote {
    fn version(&self, version_id: &str) -> Result<MrVersion> {
        self.handle.block_on(self.client.version_fresh(version_id))
    }

    fn identify(&self, sha1: &str) -> Result<Option<MrVersion>> {
        let key = sha1.trim().to_ascii_lowercase();
        let lookup = self.handle.block_on(self.client.identify(std::slice::from_ref(&key), true))?;
        if let Some(v) = lookup.found.get(&key) {
            return Ok(Some(v.clone()));
        }
        if lookup.offline {
            return Err(Error::Offline);
        }
        if lookup.failed.contains(&key) {
            return Err(Error::Network("Modrinth did not answer the lookup of the current jar".into()));
        }
        Ok(None)
    }

    fn identify_many(&self, sha1s: &[String]) -> Result<(HashMap<String, MrVersion>, HashSet<String>)> {
        let keys: Vec<String> = sha1s.iter().map(|s| s.trim().to_ascii_lowercase()).collect();
        if keys.is_empty() {
            return Ok((HashMap::new(), HashSet::new()));
        }
        let lookup = self.handle.block_on(self.client.identify(&keys, true))?;
        if lookup.offline {
            return Err(Error::Offline);
        }
        Ok((lookup.found.into_iter().collect(), lookup.failed.into_iter().collect()))
    }

    fn resolve_mod_id(&self, mod_id: &str, loaders: &[String], game_versions: &[String]) -> Result<Option<String>> {
        let found = self.handle.block_on(self.client.resolve_mod_id(mod_id, loaders, game_versions))?;
        Ok(found.map(|p| p.id))
    }

    fn project_title(&self, project_id: &str) -> Option<String> {
        let ids = vec![project_id.to_string()];
        let lookup = self.handle.block_on(self.client.projects(&ids, false)).ok()?;
        lookup.found.get(project_id).map(|p| p.title.clone()).filter(|t| !t.trim().is_empty())
    }

    fn project(&self, project_id: &str) -> Option<MrProject> {
        let ids = vec![project_id.to_string()];
        let lookup = self.handle.block_on(self.client.projects(&ids, false)).ok()?;
        lookup.found.get(project_id).cloned()
    }

    fn download(&self, url: &str, sha512: &str, size: u64, dir: &Path, name: &str) -> Result<PathBuf> {
        self.handle.block_on(self.client.download_verified(url, sha512, Some(size), dir, name))
    }
}
