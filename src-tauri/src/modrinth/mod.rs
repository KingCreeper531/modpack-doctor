//! Modrinth API client + disk cache. Owner: M2 agent E.
//!
//! - Every request carries `ClientConfig::user_agent`; no auth.
//! - One client = one shared token bucket (300/min, burst 60) and at most 4 requests in flight.
//!   The app should keep a single `ModrinthClient` (it is cheap to clone) for all calls.
//! - Batched lookups (`identify`, `find_updates`, `projects`) never fail because of the network:
//!   failed batches land in `failed`, an unreachable network yields `offline: true` with cached
//!   data. They fail only on invalid input, an HTTP 410 (API retired), or when *every* batch was
//!   rate limited (`Error::RateLimited`).
//! - Disk cache layout and TTLs: see `cache.rs` and the `TTL_*` constants below.
//! - `resolve_mod_id` maps a loader mod id (`cloth_config`) to a project: slug guesses + alias
//!   table, then `/v2/search` (see `resolve.rs`).
//! - Downloads and icons only from `https://<cdn_host>/…`; redirects never leave the origin.

mod api;
mod cache;
mod download;
mod http;
mod resolve;
mod validate;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Url;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::error::{Error, Result};
use crate::model::{HashLookup, MrVersion, ProjectLookup};

use api::{CdnCheck, ProjectRecord};
use cache::{DiskCache, Ttl};
use http::{Limiter, ReqError, RetryPolicy};

pub const DEFAULT_BASE_URL: &str = "https://api.modrinth.com";
pub const DEFAULT_CDN_HOST: &str = "cdn.modrinth.com";

/// sha1 → Version (hashes are immutable, but a version can be deleted): 7 days; unknown: 24 h.
const TTL_IDENTIFY: Ttl = Ttl::hours(7 * 24, 24);
/// hash + filters → latest compatible Version (and "none compatible"): 1 h.
const TTL_UPDATES: Ttl = Ttl::hours(1, 1);
/// id/slug → Project (title, sides, icon URL); unknown slug: 24 h.
const TTL_PROJECTS: Ttl = Ttl::hours(24, 24);
/// version id → Version: 7 days.
const TTL_VERSIONS: Ttl = Ttl::hours(7 * 24, 0);
/// project + filters → version list. Only read when the network fails (stale-if-error).
const TTL_PROJECT_VERSIONS: Ttl = Ttl::hours(0, 0);

const HASH_BATCH: usize = 200;
const PROJECT_BATCH: usize = 100;
const MAX_IN_FLIGHT: usize = 4;
const BUCKET_BURST: u32 = 60;
const BUCKET_PER_MINUTE: u32 = 300;
const API_TIMEOUT: Duration = Duration::from_secs(30);

const NS_IDENTIFY: &str = "identify";
const NS_PROJECTS: &str = "projects";
const NS_VERSIONS: &str = "versions";
const NS_PROJECT_VERSIONS: &str = "project_versions";

#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// Default `https://api.modrinth.com`.
    pub base_url: String,
    /// `cdn.modrinth.com`; overridable only in tests.
    pub cdn_host: String,
    /// `paths::api_cache_dir()`.
    pub cache_dir: PathBuf,
    /// `crate::USER_AGENT`.
    pub user_agent: String,
    /// `false` = never touch the network; serve from cache only.
    pub online: bool,
}

impl ClientConfig {
    pub fn new(cache_dir: PathBuf, online: bool) -> Self {
        ClientConfig {
            base_url: DEFAULT_BASE_URL.into(),
            cdn_host: DEFAULT_CDN_HOST.into(),
            cache_dir,
            user_agent: crate::USER_AGENT.into(),
            online,
        }
    }
}

pub(crate) type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Internal knobs; production values from `Tuning::default()`, tests shrink waits and inject a clock.
#[derive(Clone)]
pub(crate) struct Tuning {
    /// Accept `http://` base URL and CDN (wiremock).
    pub allow_http: bool,
    pub policy: RetryPolicy,
    /// Epoch milliseconds, used for cache TTLs.
    pub clock: Clock,
    /// Hard cap for `download_verified` (bytes).
    pub max_download: u64,
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning {
            allow_http: false,
            policy: RetryPolicy::default(),
            clock: Arc::new(epoch_ms),
            max_download: download::MAX_DOWNLOAD,
        }
    }
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

pub(crate) struct Inner {
    http: reqwest::Client,
    base: String,
    cdn: CdnCheck,
    cache: DiskCache,
    online: bool,
    limiter: Limiter,
    sem: Arc<Semaphore>,
    policy: RetryPolicy,
    clock: Clock,
    max_download: u64,
}

impl Inner {
    fn now(&self) -> u64 {
        (self.clock)()
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        Url::parse(&format!("{}{path}", self.base))
            .map_err(|e| Error::Internal(format!("could not build the Modrinth URL for {path}: {e}")))
    }

    /// GET/POST through limiter + retries, return the parsed JSON body.
    async fn json(&self, build: &(dyn Fn() -> reqwest::RequestBuilder + Send + Sync), abort: Option<&AtomicBool>) -> Result<Value, ReqError> {
        let (resp, _permit) = http::send(build, Some(&self.limiter), Some(&self.sem), &self.policy, abort).await?;
        let bytes = http::read_capped(resp, http::MAX_API_BODY).await?;
        serde_json::from_slice(&bytes).map_err(|e| ReqError::Body(format!("invalid JSON: {e}")))
    }
}

/// Modrinth API v2 client. Cheap to clone; clones share the rate limiter.
#[derive(Clone)]
pub struct ModrinthClient {
    inner: Arc<Inner>,
}

type Fetched<V> = Result<HashMap<String, Option<V>>, ReqError>;
type FetchFuture<V> = Pin<Box<dyn Future<Output = Fetched<V>> + Send>>;
/// Fetch one batch of keys: `Some(Some(v))` found, `Some(None)` not on Modrinth, key missing =
/// malformed answer for that key (reported as failed).
type FetchFn<V> = Arc<dyn Fn(Vec<String>, Arc<AtomicBool>) -> FetchFuture<V> + Send + Sync>;

struct Lookup<V> {
    found: BTreeMap<String, V>,
    failed: Vec<String>,
    offline: bool,
}

/// A lookup's normalized filters, also hashed into its cache namespace.
#[derive(Debug, Serialize)]
struct Filters {
    loaders: Vec<String>,
    game_versions: Vec<String>,
    version_types: Vec<String>,
}

impl Filters {
    fn new(loaders: &[String], game_versions: &[String], version_types: &[String]) -> Result<Self> {
        let mut l = loaders
            .iter()
            .map(|s| validate::filter_value("loader", s).map(|v| v.to_ascii_lowercase()))
            .collect::<Result<Vec<_>>>()?;
        let mut g = game_versions
            .iter()
            .map(|s| validate::filter_value("game version", s))
            .collect::<Result<Vec<_>>>()?;
        let mut t = version_types.iter().map(|s| validate::version_type(s)).collect::<Result<Vec<_>>>()?;
        for v in [&mut l, &mut g, &mut t] {
            v.sort();
            v.dedup();
        }
        Ok(Filters { loaders: l, game_versions: g, version_types: t })
    }

    fn digest(&self, extra: &str) -> String {
        let s = serde_json::to_string(self).unwrap_or_default();
        let d = hex::encode(Sha1::digest(format!("{extra}|{s}").as_bytes()));
        d[..16].to_string()
    }
}

fn dedup_keep_order(v: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    v.into_iter().filter(|k| seen.insert(k.clone())).collect()
}

impl ModrinthClient {
    pub fn new(cfg: ClientConfig) -> Result<Self> {
        Self::with_tuning(cfg, Tuning::default())
    }

    pub(crate) fn with_tuning(cfg: ClientConfig, t: Tuning) -> Result<Self> {
        let ua = cfg.user_agent.trim();
        if ua.is_empty() || ua.chars().any(|c| c.is_control()) {
            return Err(Error::Invalid("the Modrinth User-Agent must be a non-empty single line".into()));
        }
        let base = Url::parse(cfg.base_url.trim())
            .map_err(|e| Error::Invalid(format!("the Modrinth API URL \"{}\" is not valid ({e})", cfg.base_url)))?;
        if !(base.scheme() == "https" || (t.allow_http && base.scheme() == "http")) || base.host_str().is_none() {
            return Err(Error::Invalid(format!("the Modrinth API URL \"{}\" must be an https URL", cfg.base_url)));
        }
        let cdn_host = cfg.cdn_host.trim().to_ascii_lowercase();
        let cdn_ok = !cdn_host.is_empty()
            && cdn_host.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'));
        if !cdn_ok {
            return Err(Error::Invalid(format!("\"{}\" is not a valid CDN host name", cfg.cdn_host)));
        }
        let mut builder = reqwest::Client::builder()
            .user_agent(ua)
            .redirect(http::redirect_policy())
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30));
        if !t.allow_http {
            builder = builder.https_only(true);
        } else {
            builder = builder.no_proxy();
        }
        let http = builder
            .build()
            .map_err(|e| Error::Internal(format!("could not create the HTTP client: {e}")))?;
        Ok(ModrinthClient {
            inner: Arc::new(Inner {
                http,
                base: base.as_str().trim_end_matches('/').to_string(),
                cdn: CdnCheck { host: cdn_host, allow_http: t.allow_http },
                cache: DiskCache::new(cfg.cache_dir),
                online: cfg.online,
                limiter: Limiter::new(BUCKET_BURST, BUCKET_PER_MINUTE),
                sem: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
                policy: t.policy,
                clock: t.clock,
                max_download: t.max_download,
            }),
        })
    }

    pub fn is_online(&self) -> bool {
        self.inner.online
    }

    /// `POST /v2/version_files`: sha1 → Version. Unknown hashes are absent from both `found`
    /// and `failed`, and cached negatively for 24 h. Keys are the lower-cased hashes.
    pub async fn identify(&self, sha1s: &[String], refresh: bool) -> Result<HashLookup> {
        let hashes = dedup_keep_order(sha1s.iter().map(|h| validate::sha1(h)).collect::<Result<_>>()?);
        let url = self.inner.endpoint("/v2/version_files")?;
        let fetch = self.hash_fetch(url, serde_json::Map::new(), true);
        let l = self.keyed_lookup(hashes, refresh, NS_IDENTIFY, TTL_IDENTIFY, HASH_BATCH, fetch).await?;
        Ok(HashLookup { found: l.found, failed: l.failed, offline: l.offline })
    }

    /// `POST /v2/version_files/update`: sha1 → newest Version of the same project matching the
    /// filters (may be the same version = up to date). Absent = unknown hash or no compatible
    /// version (use `identify` to tell them apart). Empty filter lists are not sent (no filter).
    pub async fn find_updates(
        &self,
        sha1s: &[String],
        loaders: &[String],
        game_versions: &[String],
        version_types: &[String],
        refresh: bool,
    ) -> Result<HashLookup> {
        let hashes = dedup_keep_order(sha1s.iter().map(|h| validate::sha1(h)).collect::<Result<_>>()?);
        let filters = Filters::new(loaders, game_versions, version_types)?;
        let mut extra = serde_json::Map::new();
        if !filters.loaders.is_empty() {
            extra.insert("loaders".into(), json!(filters.loaders));
        }
        if !filters.game_versions.is_empty() {
            extra.insert("game_versions".into(), json!(filters.game_versions));
        }
        if !filters.version_types.is_empty() {
            extra.insert("version_types".into(), json!(filters.version_types));
        }
        let ns = format!("updates/{}", filters.digest("updates"));
        let url = self.inner.endpoint("/v2/version_files/update")?;
        let fetch = self.hash_fetch(url, extra, false);
        let l = self.keyed_lookup(hashes, refresh, &ns, TTL_UPDATES, HASH_BATCH, fetch).await?;
        Ok(HashLookup { found: l.found, failed: l.failed, offline: l.offline })
    }

    /// `GET /v2/projects?ids=[…]`, keyed by the requested id or slug (slugs match
    /// case-insensitively). `icon_path` is always `None` here; see `projects_with_icon_urls`.
    pub async fn projects(&self, ids_or_slugs: &[String], refresh: bool) -> Result<ProjectLookup> {
        Ok(self.projects_with_icon_urls(ids_or_slugs, refresh).await?.0)
    }

    /// Like `projects`, plus project id → CDN icon URL for `fetch_icon` / `attach_icons`.
    pub async fn projects_with_icon_urls(
        &self,
        ids_or_slugs: &[String],
        refresh: bool,
    ) -> Result<(ProjectLookup, BTreeMap<String, String>)> {
        let keys: Vec<String> = ids_or_slugs.iter().map(|k| k.trim().to_string()).collect();
        for k in &keys {
            validate::id_or_slug(k)?;
        }
        let l = self.project_records(dedup_keep_order(keys), refresh).await?;
        let mut icons = BTreeMap::new();
        let mut found = BTreeMap::new();
        for (k, rec) in l.found {
            if let Some(u) = rec.icon_url {
                icons.insert(rec.project.id.clone(), u);
            }
            found.insert(k, rec.project);
        }
        Ok((ProjectLookup { found, failed: l.failed, offline: l.offline }, icons))
    }

    /// Batched, cached `GET /v2/projects` returning full records. `keys` must be validated.
    async fn project_records(&self, keys: Vec<String>, refresh: bool) -> Result<Lookup<ProjectRecord>> {
        let url = self.inner.endpoint("/v2/projects")?;
        let inner = Arc::clone(&self.inner);
        let fetch: FetchFn<ProjectRecord> = Arc::new(move |chunk: Vec<String>, abort: Arc<AtomicBool>| -> FetchFuture<ProjectRecord> {
            let inner = Arc::clone(&inner);
            let mut url = url.clone();
            Box::pin(async move {
                url.query_pairs_mut().append_pair("ids", &json!(chunk).to_string());
                let build = {
                    let inner = Arc::clone(&inner);
                    move || inner.http.get(url.clone()).timeout(API_TIMEOUT)
                };
                let body = inner.json(&build, Some(&abort)).await?;
                let records: Vec<ProjectRecord> = match body {
                    Value::Array(items) => items.into_iter().filter_map(|v| api::project_from_json(v, &inner.cdn)).collect(),
                    _ => return Err(ReqError::Body("expected a list of projects".into())),
                };
                let now = inner.now();
                let mut out = HashMap::new();
                for key in chunk {
                    let hit = records.iter().find(|r| r.project.id == key || r.project.slug.eq_ignore_ascii_case(&key));
                    if let Some(r) = hit {
                        // Also cache under the stable id when looked up by slug.
                        if r.project.id != key && validate::is_base62_id(&r.project.id) {
                            inner.cache.put(NS_PROJECTS, &r.project.id, Some(r), now).await;
                        }
                    }
                    out.insert(key, hit.cloned());
                }
                Ok(out)
            })
        });
        self.keyed_lookup(keys, refresh, NS_PROJECTS, TTL_PROJECTS, PROJECT_BATCH, fetch).await
    }

    /// `GET /v2/project/{id|slug}/version?include_changelog=false`, newest first (API order),
    /// then filtered by `version_types` client-side. Always asks the network when online; the
    /// last good answer is served when offline or when the request fails.
    pub async fn project_versions(
        &self,
        project_id: &str,
        loaders: &[String],
        game_versions: &[String],
        version_types: &[String],
    ) -> Result<Vec<MrVersion>> {
        let project_id = project_id.trim();
        validate::id_or_slug(project_id)?;
        let filters = Filters::new(loaders, game_versions, version_types)?;
        let key = format!("{project_id}|{}", filters.digest("project_versions"));
        let what = format!("Modrinth project {project_id}");
        let keep = |vs: Vec<MrVersion>| -> Vec<MrVersion> {
            vs.into_iter()
                .filter(|v| filters.version_types.is_empty() || filters.version_types.contains(&v.version_type))
                .collect()
        };
        let stale = || async {
            self.inner
                .cache
                .get::<Vec<MrVersion>>(NS_PROJECT_VERSIONS, &key, TTL_PROJECT_VERSIONS, self.inner.now())
                .await
                .and_then(|c| c.value)
        };
        if !self.inner.online {
            return stale().await.map(keep).ok_or(Error::Offline);
        }
        let mut url = self.inner.endpoint("/v2/project/")?;
        url.path_segments_mut()
            .map_err(|_| Error::Internal("the Modrinth API URL cannot take a path".into()))?
            .pop_if_empty()
            .push(project_id)
            .push("version");
        {
            let mut q = url.query_pairs_mut();
            if !filters.loaders.is_empty() {
                q.append_pair("loaders", &json!(filters.loaders).to_string());
            }
            if !filters.game_versions.is_empty() {
                q.append_pair("game_versions", &json!(filters.game_versions).to_string());
            }
            q.append_pair("include_changelog", "false");
        }
        let inner = Arc::clone(&self.inner);
        let build = move || inner.http.get(url.clone()).timeout(API_TIMEOUT);
        match self.inner.json(&build, None).await {
            Ok(Value::Array(items)) => {
                let versions: Vec<MrVersion> =
                    items.into_iter().filter_map(|v| api::version_from_json(v, &self.inner.cdn)).collect();
                self.inner.cache.put(NS_PROJECT_VERSIONS, &key, Some(&versions), self.inner.now()).await;
                Ok(keep(versions))
            }
            Ok(_) => Err(ReqError::Body("expected a list of versions".into()).into_error(&what)),
            Err(e @ (ReqError::NotFound | ReqError::Gone | ReqError::RateLimited { .. })) => Err(e.into_error(&what)),
            Err(e) => stale().await.map(keep).ok_or_else(|| e.into_error(&what)),
        }
    }

    /// `GET /v2/version/{id}` (cached 7 days; stale copy served offline or on network failure).
    pub async fn version(&self, version_id: &str) -> Result<MrVersion> {
        validate::version_id(version_id)?;
        let what = format!("Modrinth version {version_id}");
        let now = self.inner.now();
        let cached = self.inner.cache.get::<MrVersion>(NS_VERSIONS, version_id, TTL_VERSIONS, now).await;
        let mut stale = None;
        if let Some(c) = cached {
            match (c.fresh, c.value) {
                (true, Some(v)) => return Ok(v),
                (_, v) => stale = v,
            }
        }
        if !self.inner.online {
            return stale.ok_or(Error::Offline);
        }
        let url = self.inner.endpoint(&format!("/v2/version/{version_id}"))?;
        let inner = Arc::clone(&self.inner);
        let build = move || inner.http.get(url.clone()).timeout(API_TIMEOUT);
        match self.inner.json(&build, None).await {
            Ok(body) => {
                let v = api::version_from_json(body, &self.inner.cdn)
                    .ok_or_else(|| ReqError::Body("not a version object".into()).into_error(&what))?;
                if v.id != version_id {
                    return Err(Error::Network(format!("Modrinth answered with version {} for {what}", v.id)));
                }
                self.inner.cache.put(NS_VERSIONS, version_id, Some(&v), now).await;
                Ok(v)
            }
            Err(e @ (ReqError::NotFound | ReqError::Gone | ReqError::RateLimited { .. })) => Err(e.into_error(&what)),
            Err(e) => stale.ok_or_else(|| e.into_error(&what)),
        }
    }

    /// Batch fetcher for the two hash endpoints.
    fn hash_fetch(&self, url: Url, extra: serde_json::Map<String, Value>, cache_versions: bool) -> FetchFn<MrVersion> {
        let inner = Arc::clone(&self.inner);
        Arc::new(move |chunk: Vec<String>, abort: Arc<AtomicBool>| -> FetchFuture<MrVersion> {
            let inner = Arc::clone(&inner);
            let url = url.clone();
            let mut body = extra.clone();
            Box::pin(async move {
                body.insert("hashes".into(), json!(chunk));
                body.insert("algorithm".into(), json!("sha1"));
                let body = Value::Object(body);
                let build = {
                    let inner = Arc::clone(&inner);
                    move || inner.http.post(url.clone()).timeout(API_TIMEOUT).json(&body)
                };
                let answer = match inner.json(&build, Some(&abort)).await? {
                    Value::Object(m) => m,
                    _ => return Err(ReqError::Body("expected a map of hashes".into())),
                };
                let mut by_hash: HashMap<String, Value> =
                    answer.into_iter().map(|(k, v)| (k.to_ascii_lowercase(), v)).collect();
                let now = inner.now();
                let mut out = HashMap::new();
                for h in chunk {
                    match by_hash.remove(&h) {
                        Some(v) => {
                            // Malformed version → key left out → reported as failed.
                            if let Some(ver) = api::version_from_json(v, &inner.cdn) {
                                if cache_versions && validate::is_base62_id(&ver.id) {
                                    inner.cache.put(NS_VERSIONS, &ver.id, Some(&ver), now).await;
                                }
                                out.insert(h, Some(ver));
                            }
                        }
                        None => {
                            out.insert(h, None);
                        }
                    }
                }
                Ok(out)
            })
        })
    }

    /// Cache-first batched lookup shared by the hash and project endpoints.
    async fn keyed_lookup<V>(
        &self,
        keys: Vec<String>,
        refresh: bool,
        ns: &str,
        ttl: Ttl,
        batch: usize,
        fetch: FetchFn<V>,
    ) -> Result<Lookup<V>>
    where
        V: Serialize + DeserializeOwned + Send + 'static,
    {
        let inner = &self.inner;
        let now = inner.now();
        let mut found = BTreeMap::new();
        let mut stale: HashMap<String, Option<V>> = HashMap::new();
        let mut need = Vec::new();
        for k in keys {
            match inner.cache.get::<V>(ns, &k, ttl, now).await {
                Some(c) if c.fresh && !refresh => {
                    if let Some(v) = c.value {
                        found.insert(k, v);
                    }
                }
                Some(c) => {
                    stale.insert(k.clone(), c.value);
                    need.push(k);
                }
                None => need.push(k),
            }
        }
        if need.is_empty() {
            return Ok(Lookup { found, failed: Vec::new(), offline: !inner.online });
        }
        if !inner.online {
            let mut failed = Vec::new();
            for k in need {
                match stale.remove(&k) {
                    Some(Some(v)) => {
                        found.insert(k, v);
                    }
                    Some(None) => {}
                    None => failed.push(k),
                }
            }
            return Ok(Lookup { found, failed, offline: true });
        }

        let order: HashMap<String, usize> = need.iter().enumerate().map(|(i, k)| (k.clone(), i)).collect();
        let chunks: Vec<Vec<String>> = need.chunks(batch.max(1)).map(<[String]>::to_vec).collect();
        let total = chunks.len();
        let results = run_batches(chunks, fetch).await;

        let mut errors = Vec::new();
        let mut failed = Vec::new();
        for (chunk, res) in results {
            match res {
                Ok(mut map) => {
                    for k in chunk {
                        match map.remove(&k) {
                            Some(Some(v)) => {
                                inner.cache.put(ns, &k, Some(&v), now).await;
                                found.insert(k, v);
                            }
                            Some(None) => inner.cache.put::<V>(ns, &k, None, now).await,
                            None => failed.push(k),
                        }
                    }
                }
                Err(e) => {
                    for k in chunk {
                        match stale.remove(&k) {
                            Some(Some(v)) => {
                                found.insert(k, v);
                            }
                            Some(None) => {}
                            None => failed.push(k),
                        }
                    }
                    errors.push(e);
                }
            }
        }
        failed.sort_by_key(|k| order.get(k).copied().unwrap_or(usize::MAX));

        if let Some(e) = errors.iter().find(|e| matches!(e, ReqError::Gone)) {
            return Err(e.clone().into_error("this lookup"));
        }
        let mut offline = false;
        if !errors.is_empty() && errors.len() == total {
            let waits: Vec<u32> = errors
                .iter()
                .filter_map(|e| match e {
                    ReqError::RateLimited { retry_after_s } => Some(*retry_after_s),
                    _ => None,
                })
                .collect();
            if waits.len() == total {
                let retry_after_s = waits.into_iter().max().unwrap_or(1);
                return Err(Error::RateLimited { retry_after_s });
            }
            offline = errors.iter().all(|e| matches!(e, ReqError::Connect(_)));
        }
        Ok(Lookup { found, failed, offline })
    }
}

/// Run every batch concurrently (the client semaphore bounds requests in flight). Once one batch
/// finds the network unreachable, batches still waiting give up immediately.
async fn run_batches<V: Send + 'static>(chunks: Vec<Vec<String>>, fetch: FetchFn<V>) -> Vec<(Vec<String>, Fetched<V>)> {
    let abort = Arc::new(AtomicBool::new(false));
    let mut set = JoinSet::new();
    let mut by_id = HashMap::new();
    for chunk in chunks {
        let f = Arc::clone(&fetch);
        let a = Arc::clone(&abort);
        let keys = chunk.clone();
        let handle = set.spawn(async move {
            let r = f(keys, Arc::clone(&a)).await;
            if matches!(r, Err(ReqError::Connect(_))) {
                a.store(true, Ordering::Relaxed);
            }
            r
        });
        by_id.insert(handle.id(), chunk);
    }
    let mut out = Vec::with_capacity(by_id.len());
    while let Some(joined) = set.join_next_with_id().await {
        let (id, r) = match joined {
            Ok((id, r)) => (id, r),
            Err(e) => (e.id(), Err(ReqError::Body("an internal task failed".into()))),
        };
        if let Some(chunk) = by_id.remove(&id) {
            out.push((chunk, r));
        }
    }
    out
}
