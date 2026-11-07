//! End-to-end client tests against wiremock. No real network.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use tempfile::TempDir;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use super::http::RetryPolicy;
use super::*;

const UA: &str = "KingCreeper531/modpack-doctor/0.0.0-test (github.com/KingCreeper531/modpack-doctor)";
const DAY_MS: u64 = 24 * 3600 * 1000;
/// Stands in for the 512 MiB production cap.
const TEST_MAX_DOWNLOAD: u64 = 100 * 1024;

struct Harness {
    server: MockServer,
    dir: TempDir,
    clock: Arc<AtomicU64>,
}

impl Harness {
    async fn new() -> Self {
        Harness { server: MockServer::start().await, dir: TempDir::new().unwrap(), clock: Arc::new(AtomicU64::new(1_000 * DAY_MS)) }
    }

    fn cdn(&self) -> String {
        self.server.uri()
    }

    fn client(&self, online: bool) -> ModrinthClient {
        self.client_with(self.server.uri(), online)
    }

    fn client_with(&self, base_url: String, online: bool) -> ModrinthClient {
        self.client_tuned(base_url, online, |_| {})
    }

    fn client_tuned(&self, base_url: String, online: bool, tweak: impl FnOnce(&mut Tuning)) -> ModrinthClient {
        let clock = Arc::clone(&self.clock);
        let cfg = ClientConfig {
            base_url,
            cdn_host: self.server.address().to_string(),
            cache_dir: self.dir.path().join("cache"),
            user_agent: UA.into(),
            online,
        };
        let mut tuning = Tuning {
            allow_http: true,
            policy: RetryPolicy {
                max_retries: 5,
                max_connect_retries: 0,
                backoff_base: Duration::from_millis(1),
                backoff_cap: Duration::from_millis(5),
                min_429_wait: Duration::ZERO,
            },
            clock: Arc::new(move || clock.load(Ordering::SeqCst)),
            max_download: TEST_MAX_DOWNLOAD,
            icon_timeout: Duration::from_secs(30),
        };
        tweak(&mut tuning);
        ModrinthClient::with_tuning(cfg, tuning).unwrap()
    }

    fn advance(&self, ms: u64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    async fn requests(&self) -> Vec<Request> {
        self.server.received_requests().await.unwrap()
    }

    /// Invariant 10: every request carries our User-Agent.
    async fn assert_ua(&self) {
        for r in self.requests().await {
            let ua = r.headers.get("user-agent").and_then(|v| v.to_str().ok());
            assert_eq!(ua, Some(UA), "request to {} without our User-Agent", r.url);
        }
    }
}

fn sha(n: usize) -> String {
    format!("{n:040x}")
}

fn vid(n: usize) -> String {
    format!("V{n:07}")
}

fn version_json(id: &str, project: &str, sha1: &str, cdn: &str) -> Value {
    json!({
        "id": id, "project_id": project, "name": format!("Version {id}"), "version_number": "1.0.0",
        "game_versions": ["1.20.1"], "loaders": ["fabric"], "version_type": "release",
        "environment": "client_and_server", "date_published": "2024-01-01T00:00:00Z",
        "files": [{
            "hashes": {"sha1": sha1, "sha512": "a".repeat(128)},
            "url": format!("{cdn}/data/{project}/versions/{id}/mod.jar"),
            "filename": "mod.jar", "primary": true, "size": 3, "file_type": null
        }],
        "dependencies": [{"version_id": null, "project_id": "P7dR8mSH", "file_name": null, "dependency_type": "required"}]
    })
}

fn body_hashes(r: &Request) -> Vec<String> {
    let v: Value = r.body_json().unwrap();
    v["hashes"].as_array().unwrap().iter().map(|h| h.as_str().unwrap().to_string()).collect()
}

/// Knows every hash whose number is even.
fn even_hash_responder(cdn: String) -> impl Fn(&Request) -> ResponseTemplate + Send + Sync {
    move |r: &Request| {
        let mut m = serde_json::Map::new();
        for h in body_hashes(r) {
            let n = usize::from_str_radix(&h, 16).unwrap();
            if n % 2 == 0 {
                m.insert(h.clone(), version_json(&vid(n), "AANobbMI", &h, &cdn));
            }
        }
        ResponseTemplate::new(200).set_body_json(Value::Object(m))
    }
}

async fn mount_identify(h: &Harness) {
    Mock::given(method("POST"))
        .and(path("/v2/version_files"))
        .and(header("user-agent", UA))
        .respond_with(even_hash_responder(h.cdn()))
        .mount(&h.server)
        .await;
}

#[tokio::test]
async fn identify_batches_and_caches_unknown_hashes_negatively() {
    let h = Harness::new().await;
    mount_identify(&h).await;
    let c = h.client(true);
    let hashes: Vec<String> = (0..450).map(sha).collect();

    let r = c.identify(&hashes, false).await.unwrap();
    assert_eq!(r.found.len(), 225);
    assert!(r.failed.is_empty());
    assert!(!r.offline);
    assert!(r.found.contains_key(&sha(2)) && !r.found.contains_key(&sha(1)));
    assert_eq!(r.found[&sha(4)].id, vid(4));
    assert_eq!(r.found[&sha(4)].dependencies[0].project_id.as_deref(), Some("P7dR8mSH"));

    let mut sizes: Vec<usize> = h.requests().await.iter().map(|r| body_hashes(r).len()).collect();
    sizes.sort_unstable();
    assert_eq!(sizes, vec![50, 200, 200]);
    for r in h.requests().await {
        let v: Value = r.body_json().unwrap();
        assert_eq!(v["algorithm"], "sha1");
    }

    // Everything (including the 225 negatives) now comes from disk.
    let again = c.identify(&hashes, false).await.unwrap();
    assert_eq!(again, r);
    assert_eq!(h.requests().await.len(), 3);
    let neg = c.inner.cache.get::<MrVersion>(NS_IDENTIFY, &sha(1), TTL_IDENTIFY, h.clock.load(Ordering::SeqCst)).await;
    assert_eq!(neg, Some(cache::Cached { value: None, fresh: true }));
    // identify also fills the version cache.
    assert_eq!(c.version(&vid(4)).await.unwrap().id, vid(4));
    assert_eq!(h.requests().await.len(), 3);
    h.assert_ua().await;
}

#[tokio::test]
async fn identify_normalizes_and_validates_hashes() {
    let h = Harness::new().await;
    mount_identify(&h).await;
    let c = h.client(true);
    let upper = sha(10).to_ascii_uppercase();
    let r = c.identify(&[upper.clone(), sha(10)], false).await.unwrap();
    assert_eq!(r.found.keys().collect::<Vec<_>>(), vec![&sha(10)]);
    assert_eq!(body_hashes(&h.requests().await[0]), vec![sha(10)]);
    assert!(matches!(c.identify(&["nothex".into()], false).await, Err(Error::Invalid(_))));
    h.assert_ua().await;
}

#[tokio::test]
async fn failed_batch_is_reported_others_succeed() {
    let h = Harness::new().await;
    let cdn = h.cdn();
    let ok = even_hash_responder(cdn);
    let poison = sha(300);
    Mock::given(method("POST"))
        .and(path("/v2/version_files"))
        .respond_with(move |r: &Request| {
            if body_hashes(r).contains(&poison) {
                ResponseTemplate::new(503)
            } else {
                ok(r)
            }
        })
        .mount(&h.server)
        .await;
    let c = h.client(true);
    let hashes: Vec<String> = (0..250).map(|i| sha(i + 100)).collect();
    let r = c.identify(&hashes, false).await.unwrap();
    assert!(!r.offline);
    // Batch 1 = hashes 100..300 (ok), batch 2 = 300..350 (503 after retries).
    assert_eq!(r.found.len(), 100);
    assert_eq!(r.failed, (300..350).map(sha).collect::<Vec<_>>());
    // 1 good request + 6 attempts for the failing batch.
    assert_eq!(h.requests().await.len(), 7);
    // Failed hashes were not cached negatively: they are asked again next time.
    let again = c.identify(&[sha(300)], false).await.unwrap();
    assert_eq!(again.failed, vec![sha(300)]);
    h.assert_ua().await;
}

#[tokio::test]
async fn rate_limited_then_success() {
    let h = Harness::new().await;
    Mock::given(method("POST"))
        .and(path("/v2/version_files"))
        .respond_with(ResponseTemplate::new(429).insert_header("x-ratelimit-remaining", "0").set_body_json(json!({
            "error": "ratelimit_error",
            "description": "You are being rate-limited. rate limit exceeded; retry after 40 milliseconds"
        })))
        .up_to_n_times(1)
        .mount(&h.server)
        .await;
    mount_identify(&h).await;
    let c = h.client(true);
    let t0 = Instant::now();
    let r = c.identify(&[sha(2)], false).await.unwrap();
    assert!(t0.elapsed() >= Duration::from_millis(40), "did not wait as asked");
    assert_eq!(r.found.len(), 1);
    assert_eq!(h.requests().await.len(), 2);
    h.assert_ua().await;
}

#[tokio::test]
async fn rate_limit_exhaustion_is_an_error() {
    let h = Harness::new().await;
    Mock::given(method("POST"))
        .and(path("/v2/version_files"))
        .respond_with(ResponseTemplate::new(429).set_body_json(json!({
            "error": "ratelimit_error", "description": "rate limit exceeded; retry after 5 milliseconds"
        })))
        .mount(&h.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/version/AAAAAAAA"))
        .respond_with(ResponseTemplate::new(429))
        .mount(&h.server)
        .await;
    let c = h.client(true);
    let e = c.identify(&[sha(2)], false).await.unwrap_err();
    assert!(matches!(e, Error::RateLimited { retry_after_s: 1 }), "{e:?}");
    assert_eq!(h.requests().await.len(), 6, "1 attempt + 5 retries");
    let e = c.version("AAAAAAAA").await.unwrap_err();
    assert!(matches!(e, Error::RateLimited { .. }), "{e:?}");
    h.assert_ua().await;
}

#[tokio::test]
async fn gone_410_is_a_readable_network_error() {
    let h = Harness::new().await;
    Mock::given(wiremock::matchers::any()).respond_with(ResponseTemplate::new(410)).mount(&h.server).await;
    let c = h.client(true);
    let e = c.identify(&[sha(2)], false).await.unwrap_err();
    let msg = e.to_string();
    assert!(matches!(e, Error::Network(_)) && msg.contains("410") && msg.contains("update Modpack Doctor"), "{msg}");
    assert!(matches!(c.version("AAAAAAAA").await, Err(Error::Network(_))));
    assert!(matches!(c.projects(&["sodium".into()], false).await, Err(Error::Network(_))));
    assert_eq!(h.requests().await.len(), 3, "410 is not retried");
    h.assert_ua().await;
}

#[tokio::test]
async fn offline_serves_cache_including_negative_entries() {
    let h = Harness::new().await;
    mount_identify(&h).await;
    h.client(true).identify(&[sha(2), sha(3)], false).await.unwrap();
    let before = h.requests().await.len();

    let off = h.client(false);
    // Even long after the TTLs, offline mode serves what it has.
    h.advance(30 * DAY_MS);
    let r = off.identify(&[sha(2), sha(3), sha(4)], false).await.unwrap();
    assert!(r.offline);
    assert_eq!(r.found.keys().collect::<Vec<_>>(), vec![&sha(2)]);
    assert_eq!(r.failed, vec![sha(4)], "uncached = unknown, never 'not on Modrinth'");
    assert_eq!(h.requests().await.len(), before, "offline client touched the network");
    // refresh cannot bypass the cache while offline.
    assert_eq!(off.identify(&[sha(2)], true).await.unwrap().found.len(), 1);
    assert!(matches!(off.version("AAAAAAAA").await, Err(Error::Offline)));
    assert!(matches!(off.project_versions("sodium", &[], &[], &[]).await, Err(Error::Offline)));
}

#[tokio::test]
async fn network_down_falls_back_to_cache() {
    let h = Harness::new().await;
    mount_identify(&h).await;
    h.client(true).identify(&[sha(2), sha(3)], false).await.unwrap();
    h.advance(30 * DAY_MS); // everything stale

    // A port nobody listens on.
    let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_url = format!("http://{}", dead.local_addr().unwrap());
    drop(dead);
    let c = h.client_with(dead_url, true);
    let hashes: Vec<String> = vec![sha(2), sha(3)].into_iter().chain((1000..1450).map(sha)).collect();
    let r = c.identify(&hashes, false).await.unwrap();
    assert!(r.offline);
    assert_eq!(r.found.keys().collect::<Vec<_>>(), vec![&sha(2)]);
    assert_eq!(r.failed.len(), 450);
    assert_eq!(r.failed[0], sha(1000));
}

#[tokio::test]
async fn refresh_bypasses_cache_reads() {
    let h = Harness::new().await;
    mount_identify(&h).await;
    let c = h.client(true);
    c.identify(&[sha(2), sha(3)], false).await.unwrap();
    c.identify(&[sha(2), sha(3)], false).await.unwrap();
    assert_eq!(h.requests().await.len(), 1);
    c.identify(&[sha(2), sha(3)], true).await.unwrap();
    assert_eq!(h.requests().await.len(), 2);
    assert_eq!(body_hashes(&h.requests().await[1]).len(), 2);
    h.assert_ua().await;
}

#[tokio::test]
async fn ttl_expiry_refetches() {
    let h = Harness::new().await;
    mount_identify(&h).await;
    let c = h.client(true);
    c.identify(&[sha(2), sha(3)], false).await.unwrap();
    // 25 h later: the negative entry (24 h) expired, the positive one (7 d) did not.
    h.advance(25 * 3600 * 1000);
    c.identify(&[sha(2), sha(3)], false).await.unwrap();
    assert_eq!(body_hashes(&h.requests().await[1]), vec![sha(3)]);
    // 8 days later both expired.
    h.advance(8 * DAY_MS);
    c.identify(&[sha(2), sha(3)], false).await.unwrap();
    assert_eq!(body_hashes(&h.requests().await[2]).len(), 2);
    h.assert_ua().await;
}

#[tokio::test]
async fn corrupt_cache_file_is_ignored_and_rewritten() {
    let h = Harness::new().await;
    mount_identify(&h).await;
    let c = h.client(true);
    c.identify(&[sha(2)], false).await.unwrap();
    let file = c.inner.cache.path(NS_IDENTIFY, &sha(2));
    std::fs::write(&file, b"\0garbage").unwrap();
    let r = c.identify(&[sha(2)], false).await.unwrap();
    assert_eq!(r.found.len(), 1);
    assert_eq!(h.requests().await.len(), 2);
    let txt = std::fs::read_to_string(&file).unwrap();
    assert!(txt.contains(&vid(2)));
}

#[tokio::test]
async fn non_cdn_file_urls_are_dropped() {
    let h = Harness::new().await;
    let cdn = h.cdn();
    Mock::given(method("POST"))
        .and(path("/v2/version_files"))
        .respond_with(move |_: &Request| {
            let mut v = version_json("OihdIimA", "AANobbMI", &sha(2), &cdn);
            let mut evil = v["files"][0].clone();
            evil["url"] = json!("https://evil.example/mod.jar");
            evil["filename"] = json!("evil.jar");
            v["files"].as_array_mut().unwrap().push(evil);
            ResponseTemplate::new(200).set_body_json(json!({ (sha(2)): v }))
        })
        .mount(&h.server)
        .await;
    let r = h.client(true).identify(&[sha(2)], false).await.unwrap();
    let files = &r.found[&sha(2)].files;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].filename, "mod.jar");
    h.assert_ua().await;
}

#[tokio::test]
async fn find_updates_sends_filters_and_caches_per_filter_set() {
    let h = Harness::new().await;
    let cdn = h.cdn();
    Mock::given(method("POST"))
        .and(path("/v2/version_files/update"))
        .and(header("user-agent", UA))
        .respond_with(move |r: &Request| {
            let hashes = body_hashes(r);
            ResponseTemplate::new(200).set_body_json(json!({ (hashes[0].clone()): version_json("NEWVERS1", "AANobbMI", &sha(99), &cdn) }))
        })
        .mount(&h.server)
        .await;
    let c = h.client(true);
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let r = c.find_updates(&[sha(1), sha(3)], &s(&["Fabric", "quilt"]), &s(&["1.20.1"]), &s(&["release"]), false).await.unwrap();
    assert_eq!(r.found.len(), 1);
    assert_eq!(r.found[&sha(1)].id, "NEWVERS1");
    let body: Value = h.requests().await[0].body_json().unwrap();
    assert_eq!(body["algorithm"], "sha1");
    assert_eq!(body["loaders"], json!(["fabric", "quilt"]));
    assert_eq!(body["game_versions"], json!(["1.20.1"]));
    assert_eq!(body["version_types"], json!(["release"]));

    // Same filters (different order/case): cached, including "no compatible version" for sha(3).
    c.find_updates(&[sha(1), sha(3)], &s(&["quilt", "fabric"]), &s(&["1.20.1"]), &s(&["release"]), false).await.unwrap();
    assert_eq!(h.requests().await.len(), 1);
    // Different filters: separate cache entries.
    c.find_updates(&[sha(1)], &s(&["fabric"]), &s(&["1.20.1"]), &s(&["release", "beta"]), false).await.unwrap();
    assert_eq!(h.requests().await.len(), 2);
    // Empty filters are omitted from the body.
    c.find_updates(&[sha(1)], &[], &[], &[], false).await.unwrap();
    let body: Value = h.requests().await[2].body_json().unwrap();
    assert!(body.get("loaders").is_none() && body.get("version_types").is_none());
    assert!(matches!(c.find_updates(&[sha(1)], &[], &[], &s(&["snapshot"]), false).await, Err(Error::Invalid(_))));
    h.assert_ua().await;
}

fn project_json(id: &str, slug: &str, cdn: &str) -> Value {
    json!({"id": id, "slug": slug, "title": slug.to_uppercase(), "project_type": "mod",
           "client_side": "required", "server_side": "optional", "environment": ["client_and_server"],
           "icon_url": format!("{cdn}/data/{id}/icon_96.webp")})
}

#[tokio::test]
async fn projects_keyed_by_requested_id_or_slug() {
    let h = Harness::new().await;
    let cdn = h.cdn();
    let known = [project_json("AANobbMI", "sodium", &cdn), project_json("P7dR8mSH", "fabric-api", &cdn)];
    Mock::given(method("GET"))
        .and(path("/v2/projects"))
        .and(header("user-agent", UA))
        .respond_with(move |r: &Request| {
            let ids: Vec<String> = r
                .url
                .query_pairs()
                .find(|(k, _)| k == "ids")
                .map(|(_, v)| serde_json::from_str(&v).unwrap())
                .unwrap();
            assert!(ids.len() <= 100);
            let hits: Vec<Value> = known
                .iter()
                .filter(|p| ids.iter().any(|i| i == p["id"].as_str().unwrap() || i.eq_ignore_ascii_case(p["slug"].as_str().unwrap())))
                .cloned()
                .collect();
            ResponseTemplate::new(200).set_body_json(hits)
        })
        .mount(&h.server)
        .await;
    let c = h.client(true);
    let req: Vec<String> = ["SODIUM", "fabric-api", "P7dR8mSH", "doesnotexist"].iter().map(|s| s.to_string()).collect();
    let (r, icons) = c.projects_with_icon_urls(&req, false).await.unwrap();
    assert_eq!(r.found.keys().cloned().collect::<Vec<_>>(), vec!["P7dR8mSH", "SODIUM", "fabric-api"]);
    assert_eq!(r.found["SODIUM"].id, "AANobbMI");
    assert_eq!(r.found["SODIUM"].client_side, crate::model::SideSupport::Required);
    assert_eq!(r.found["SODIUM"].icon_path, None);
    assert!(r.failed.is_empty());
    assert_eq!(icons.len(), 2);
    assert!(icons["AANobbMI"].ends_with("/data/AANobbMI/icon_96.webp"));

    // Unknown slug cached negatively; slug hits also cached under their id.
    let again = c.projects(&["doesnotexist".into(), "AANobbMI".into()], false).await.unwrap();
    assert_eq!(again.found.keys().cloned().collect::<Vec<_>>(), vec!["AANobbMI"]);
    assert_eq!(h.requests().await.len(), 1);

    // 250 ids → 3 requests of ≤100.
    let many: Vec<String> = (0..250).map(|i| format!("mod-{i}")).collect();
    let r = c.projects(&many, false).await.unwrap();
    assert!(r.found.is_empty() && r.failed.is_empty());
    assert_eq!(h.requests().await.len(), 4);
    assert!(matches!(c.projects(&["bad slug".into()], false).await, Err(Error::Invalid(_))));
    h.assert_ua().await;
}

#[tokio::test]
async fn project_versions_filters_and_validates() {
    let h = Harness::new().await;
    let cdn = h.cdn();
    let mut beta = version_json("BETAVER1", "AANobbMI", &sha(1), &cdn);
    beta["version_type"] = json!("beta");
    let rel = version_json("RELVER01", "AANobbMI", &sha(2), &cdn);
    Mock::given(method("GET"))
        .and(path("/v2/project/sodium/version"))
        .and(query_param("include_changelog", "false"))
        .and(query_param("loaders", "[\"fabric\"]"))
        .and(query_param("game_versions", "[\"1.20.1\"]"))
        .and(header("user-agent", UA))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([beta, rel])))
        .mount(&h.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/project/missing1/version"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&h.server)
        .await;
    let c = h.client(true);
    let s = |v: &str| vec![v.to_string()];
    let all = c.project_versions("sodium", &s("fabric"), &s("1.20.1"), &[]).await.unwrap();
    assert_eq!(all.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["BETAVER1", "RELVER01"]);
    let rel = c.project_versions("sodium", &s("fabric"), &s("1.20.1"), &s("release")).await.unwrap();
    assert_eq!(rel.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["RELVER01"]);
    assert!(matches!(c.project_versions("missing1", &[], &[], &[]).await, Err(Error::NotFound { .. })));
    assert!(matches!(c.project_versions("../x", &[], &[], &[]).await, Err(Error::Invalid(_))));
    // Offline: last good answer.
    let off = h.client(false);
    assert_eq!(off.project_versions("sodium", &s("fabric"), &s("1.20.1"), &s("release")).await.unwrap().len(), 1);
    h.assert_ua().await;
}

#[tokio::test]
async fn version_fetch_validate_and_cache() {
    let h = Harness::new().await;
    let cdn = h.cdn();
    Mock::given(method("GET"))
        .and(path("/v2/version/OihdIimA"))
        .and(header("user-agent", UA))
        .respond_with(ResponseTemplate::new(200).set_body_json(version_json("OihdIimA", "AANobbMI", &sha(5), &cdn)))
        .mount(&h.server)
        .await;
    let c = h.client(true);
    assert!(matches!(c.version("../../etc").await, Err(Error::Invalid(_))));
    assert!(matches!(c.version("short").await, Err(Error::Invalid(_))));
    let v = c.version("OihdIimA").await.unwrap();
    assert_eq!(v.files[0].sha1, sha(5));
    assert_eq!(c.version("OihdIimA").await.unwrap(), v);
    assert_eq!(h.requests().await.len(), 1);
    assert_eq!(h.client(false).version("OihdIimA").await.unwrap(), v);
    assert!(matches!(c.version("ZZZZZZZZ").await, Err(Error::NotFound { .. })));
    h.assert_ua().await;
}

// ---------- downloads ----------

fn sha512_hex(b: &[u8]) -> String {
    hex::encode(Sha512::digest(b))
}

#[tokio::test]
async fn download_success_streams_to_part_file() {
    let h = Harness::new().await;
    let body = b"jar bytes ".repeat(5000);
    Mock::given(method("GET"))
        .and(path("/data/AANobbMI/versions/x/mod.jar"))
        .and(header("user-agent", UA))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
        .mount(&h.server)
        .await;
    let dest = TempDir::new().unwrap();
    let url = format!("{}/data/AANobbMI/versions/x/mod.jar", h.cdn());
    let p = h.client(true).download_verified(&url, &sha512_hex(&body), Some(body.len() as u64), dest.path(), "mod.jar").await.unwrap();
    assert_eq!(p, dest.path().join(".mod.jar.part"));
    assert_eq!(std::fs::read(&p).unwrap(), body);
    h.assert_ua().await;
}

#[tokio::test]
async fn download_hash_mismatch_removes_temp() {
    let h = Harness::new().await;
    Mock::given(method("GET"))
        .and(path("/data/a.jar"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"tampered".to_vec()))
        .mount(&h.server)
        .await;
    let dest = TempDir::new().unwrap();
    let url = format!("{}/data/a.jar", h.cdn());
    let e = h.client(true).download_verified(&url, &sha512_hex(b"original"), Some(8), dest.path(), "a.jar").await.unwrap_err();
    assert!(matches!(e, Error::HashMismatch { .. }), "{e:?}");
    assert!(!dest.path().join(".a.jar.part").exists());
    assert_eq!(std::fs::read_dir(dest.path()).unwrap().count(), 0);
    h.assert_ua().await;
}

#[tokio::test]
async fn download_rejects_wrong_host_and_bad_input() {
    let h = Harness::new().await;
    let c = h.client(true);
    let dest = TempDir::new().unwrap();
    let good = sha512_hex(b"x");
    for url in [
        "https://evil.example/data/a.jar".to_string(),
        "https://cdn.modrinth.com/data/a.jar".to_string(), // not the configured CDN in this test
        format!("ftp://{}/data/a.jar", h.server.address()),
        "file:///etc/passwd".to_string(),
    ] {
        let e = c.download_verified(&url, &good, Some(1), dest.path(), "a.jar").await.unwrap_err();
        assert!(matches!(e, Error::Invalid(_)), "{url}: {e:?}");
    }
    let url = format!("{}/data/a.jar", h.cdn());
    assert!(matches!(c.download_verified(&url, "abc", Some(1), dest.path(), "a.jar").await, Err(Error::Invalid(_))));
    assert!(matches!(c.download_verified(&url, &good, Some(1), dest.path(), "../a.jar").await, Err(Error::Invalid(_))));
    assert!(matches!(c.download_verified(&url, &good, Some(u64::MAX), dest.path(), "a.jar").await, Err(Error::Invalid(_))));
    assert!(h.requests().await.is_empty());
    assert!(matches!(h.client(false).download_verified(&url, &good, Some(1), dest.path(), "a.jar").await, Err(Error::Offline)));
}

#[tokio::test]
async fn production_client_requires_https_cdn() {
    let dir = TempDir::new().unwrap();
    let c = ModrinthClient::new(ClientConfig::new(dir.path().to_path_buf(), true)).unwrap();
    let e = c
        .download_verified("http://cdn.modrinth.com/data/a.jar", &"0".repeat(128), Some(1), dir.path(), "a.jar")
        .await
        .unwrap_err();
    assert!(matches!(e, Error::Invalid(_)));
    let mut bad = ClientConfig::new(dir.path().to_path_buf(), true);
    bad.base_url = "http://api.modrinth.com".into();
    assert!(matches!(ModrinthClient::new(bad), Err(Error::Invalid(_))));
}

#[tokio::test]
async fn download_oversize_rejected() {
    let h = Harness::new().await;
    let body = vec![7u8; 200 * 1024];
    Mock::given(method("GET"))
        .and(path("/data/big.jar"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
        .mount(&h.server)
        .await;
    let dest = TempDir::new().unwrap();
    let url = format!("{}/data/big.jar", h.cdn());
    let e = h.client(true).download_verified(&url, &sha512_hex(&body), Some(1000), dest.path(), "big.jar").await.unwrap_err();
    assert!(matches!(e, Error::Corrupt { .. }), "{e:?}");
    assert!(!dest.path().join(".big.jar.part").exists());
}

#[tokio::test]
async fn download_redirect_to_other_host_rejected() {
    let h = Harness::new().await;
    let other = MockServer::start().await;
    Mock::given(wiremock::matchers::any())
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"x".to_vec()))
        .mount(&other)
        .await;
    Mock::given(method("GET"))
        .and(path("/data/r.jar"))
        .respond_with(ResponseTemplate::new(302).insert_header("location", format!("{}/payload.jar", other.uri())))
        .mount(&h.server)
        .await;
    // Same-origin redirects are fine.
    Mock::given(method("GET"))
        .and(path("/data/same.jar"))
        .respond_with(ResponseTemplate::new(301).insert_header("location", "/data/final.jar"))
        .mount(&h.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/data/final.jar"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"x".to_vec()))
        .mount(&h.server)
        .await;
    let dest = TempDir::new().unwrap();
    let c = h.client(true);
    let e = c
        .download_verified(&format!("{}/data/r.jar", h.cdn()), &sha512_hex(b"x"), Some(1), dest.path(), "r.jar")
        .await
        .unwrap_err();
    assert!(matches!(&e, Error::Network(m) if m.contains("redirected")), "{e:?}");
    assert!(other.received_requests().await.unwrap().is_empty(), "followed a cross-host redirect");
    assert!(!dest.path().join(".r.jar.part").exists());
    let ok = c.download_verified(&format!("{}/data/same.jar", h.cdn()), &sha512_hex(b"x"), Some(1), dest.path(), "same.jar").await;
    assert!(ok.is_ok(), "{ok:?}");
    h.assert_ua().await;
}

// ---------- icons ----------

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDRfake";

#[tokio::test]
async fn icon_fetch_validates_and_caches() {
    let h = Harness::new().await;
    Mock::given(method("GET"))
        .and(path("/data/AANobbMI/icon.png"))
        .and(header("user-agent", UA))
        .respond_with(ResponseTemplate::new(200).set_body_raw(PNG.to_vec(), "image/png"))
        .expect(1)
        .mount(&h.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/data/P7dR8mSH/icon.svg"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(b"<svg onload='x'/>".to_vec(), "image/svg+xml"))
        .mount(&h.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/data/P7dR8mSH/fake.png"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(b"<svg/>".to_vec(), "image/png"))
        .mount(&h.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/data/P7dR8mSH/huge.png"))
        .respond_with(ResponseTemplate::new(200).set_body_raw([PNG, &vec![0u8; 1100 * 1024]].concat(), "image/png"))
        .mount(&h.server)
        .await;
    let c = h.client(true);
    let icons = TempDir::new().unwrap();
    let cdn = h.cdn();

    assert!(matches!(c.fetch_icon("../evil", &format!("{cdn}/data/AANobbMI/icon.png"), icons.path()).await, Err(Error::Invalid(_))));
    assert!(matches!(c.fetch_icon("AANobbM", &format!("{cdn}/data/AANobbMI/icon.png"), icons.path()).await, Err(Error::Invalid(_))));
    assert!(matches!(c.fetch_icon("AANobbMI", "https://evil.example/icon.png", icons.path()).await, Err(Error::Invalid(_))));

    let p = c.fetch_icon("AANobbMI", &format!("{cdn}/data/AANobbMI/icon.png"), icons.path()).await.unwrap().unwrap();
    assert_eq!(p, icons.path().join("AANobbMI.png"));
    assert_eq!(std::fs::read(&p).unwrap(), PNG);
    // Second call reuses the file (mock expects exactly one hit).
    assert_eq!(c.fetch_icon("AANobbMI", &format!("{cdn}/data/AANobbMI/icon.png"), icons.path()).await.unwrap(), Some(p));

    for bad in ["icon.svg", "fake.png", "huge.png"] {
        let r = c.fetch_icon("P7dR8mSH", &format!("{cdn}/data/P7dR8mSH/{bad}"), icons.path()).await.unwrap();
        assert_eq!(r, None, "{bad} accepted");
    }
    let names: Vec<String> =
        std::fs::read_dir(icons.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["AANobbMI.png"]);
    h.assert_ua().await;
}

#[tokio::test]
async fn icon_format_comes_from_the_bytes_not_the_label() {
    // Seen live on cdn.modrinth.com: WebP bytes served as `image/png` (with nosniff).
    const WEBP: &[u8] = b"RIFF(0  WEBPVP8Lfake";
    let h = Harness::new().await;
    Mock::given(method("GET"))
        .and(path("/data/8BmcQJ2H/icon_96.webp"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(WEBP.to_vec(), "image/png"))
        .mount(&h.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/data/P7dR8mSH/page.png"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(b"<html>not an image</html>".to_vec(), "image/webp"))
        .mount(&h.server)
        .await;
    let c = h.client(true);
    let icons = TempDir::new().unwrap();
    let cdn = h.cdn();
    let p = c.fetch_icon("8BmcQJ2H", &format!("{cdn}/data/8BmcQJ2H/icon_96.webp"), icons.path()).await.unwrap().unwrap();
    assert_eq!(p, icons.path().join("8BmcQJ2H.webp"));
    assert_eq!(std::fs::read(&p).unwrap(), WEBP);
    assert_eq!(c.fetch_icon("P7dR8mSH", &format!("{cdn}/data/P7dR8mSH/page.png"), icons.path()).await.unwrap(), None);
}

#[tokio::test]
async fn attach_icons_fills_icon_paths() {
    let h = Harness::new().await;
    let cdn = h.cdn();
    let p = project_json("AANobbMI", "sodium", &cdn);
    Mock::given(method("GET")).and(path("/v2/projects")).respond_with(ResponseTemplate::new(200).set_body_json(json!([p]))).mount(&h.server).await;
    Mock::given(method("GET"))
        .and(path("/data/AANobbMI/icon_96.webp"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(b"RIFF\x10\0\0\0WEBPVP8 ".to_vec(), "image/webp"))
        .mount(&h.server)
        .await;
    let c = h.client(true);
    let icons = TempDir::new().unwrap();
    let (mut r, urls) = c.projects_with_icon_urls(&["sodium".into()], false).await.unwrap();
    c.attach_icons(&mut r, &urls, icons.path()).await;
    let path = r.found["sodium"].icon_path.clone().unwrap();
    assert!(path.ends_with("AANobbMI.webp"), "{path}");
    h.assert_ua().await;
}

#[tokio::test]
async fn concurrent_fetches_of_one_icon_all_succeed() {
    let h = Harness::new().await;
    Mock::given(method("GET"))
        .and(path("/data/AANobbMI/icon.png"))
        // Slow enough that every fetch is in flight before the first one writes.
        .respond_with(ResponseTemplate::new(200).set_body_raw(PNG.to_vec(), "image/png").set_delay(Duration::from_millis(100)))
        .mount(&h.server)
        .await;
    let c = h.client(true);
    let icons = TempDir::new().unwrap();
    let url = format!("{}/data/AANobbMI/icon.png", h.cdn());
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let (c, url, dir) = (c.clone(), url.clone(), icons.path().to_path_buf());
        set.spawn(async move { c.fetch_icon("AANobbMI", &url, &dir).await });
    }
    let dest = icons.path().join("AANobbMI.png");
    let mut n = 0;
    while let Some(r) = set.join_next().await {
        assert_eq!(r.unwrap().unwrap(), Some(dest.clone()));
        n += 1;
    }
    assert_eq!(n, 8);
    assert_eq!(h.requests().await.len(), 8, "every fetch went to the CDN at once");
    assert_eq!(std::fs::read(&dest).unwrap(), PNG);
    let names: Vec<String> =
        std::fs::read_dir(icons.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["AANobbMI.png"], "temp files left behind");
}

/// `/v2/projects` answering for every requested id, each with a CDN icon.
async fn mount_projects_for_any_id(h: &Harness) {
    let cdn = h.cdn();
    Mock::given(method("GET"))
        .and(path("/v2/projects"))
        .respond_with(move |r: &Request| {
            let ids: Vec<String> =
                r.url.query_pairs().find(|(k, _)| k == "ids").map(|(_, v)| serde_json::from_str(&v).unwrap()).unwrap();
            let hits: Vec<Value> = ids.iter().map(|id| project_json(id, &id.to_ascii_lowercase(), &cdn)).collect();
            ResponseTemplate::new(200).set_body_json(hits)
        })
        .mount(&h.server)
        .await;
}

fn icon_requests(reqs: &[Request]) -> usize {
    reqs.iter().filter(|r| r.url.path().starts_with("/data/")).count()
}

fn age_file(p: &Path, days: u64) {
    let f = std::fs::File::options().write(true).open(p).unwrap();
    f.set_modified(std::time::SystemTime::now() - Duration::from_secs(days * 24 * 3600)).unwrap();
}

#[tokio::test]
async fn fetch_icons_stops_after_the_cdn_times_out() {
    let h = Harness::new().await;
    mount_projects_for_any_id(&h).await;
    Mock::given(method("GET"))
        .and(wiremock::matchers::path_regex(r"^/data/[A-Za-z0-9]{8}/icon_96\.webp$"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(PNG.to_vec(), "image/png").set_delay(Duration::from_secs(2)))
        .mount(&h.server)
        .await;
    let ids: Vec<String> = (0..12).map(|n| format!("PROJ{n:04}")).collect();
    let icons = TempDir::new().unwrap();
    // A stale icon on disk survives the failed refresh and is still returned.
    let stale = icons.path().join("PROJ0000.png");
    std::fs::write(&stale, PNG).unwrap();
    age_file(&stale, 30);

    let c = h.client_tuned(h.server.uri(), true, |t| {
        t.icon_timeout = Duration::from_millis(150);
        t.policy.max_retries = 0;
    });
    let t0 = Instant::now();
    let r = c.fetch_icons(&ids, icons.path()).await;
    assert!(t0.elapsed() < Duration::from_secs(2), "waited {:?}", t0.elapsed());
    let expected: BTreeMap<String, String> = [("PROJ0000".to_string(), stale.to_string_lossy().into_owned())].into();
    assert_eq!(r, expected);
    // Only the first wave (4 at a time) went out; nothing started after the first timeout.
    let sent = icon_requests(&h.requests().await);
    assert!((1..=4).contains(&sent), "{sent} icon requests for 12 projects");
    h.assert_ua().await;
}

#[tokio::test]
async fn fetch_icons_fetches_reuses_and_skips_the_cdn_when_offline() {
    let h = Harness::new().await;
    mount_projects_for_any_id(&h).await;
    Mock::given(method("GET"))
        .and(wiremock::matchers::path_regex(r"^/data/[A-Za-z0-9]{8}/icon_96\.webp$"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(PNG.to_vec(), "image/png"))
        .mount(&h.server)
        .await;
    let ids: Vec<String> = vec!["AANobbMI".into(), "P7dR8mSH".into(), "AANobbMI".into(), "not an id".into()];
    let icons = TempDir::new().unwrap();
    let c = h.client(true);
    let r = c.fetch_icons(&ids, icons.path()).await;
    assert_eq!(r.keys().collect::<Vec<_>>(), vec!["AANobbMI", "P7dR8mSH"]);
    assert_eq!(Path::new(&r["AANobbMI"]), icons.path().join("AANobbMI.png"));
    let reqs = h.requests().await;
    assert_eq!((reqs.len(), icon_requests(&reqs)), (3, 2));

    // Fresh icons and cached projects: no request at all.
    assert_eq!(c.fetch_icons(&ids, icons.path()).await, r);
    assert_eq!(h.requests().await.len(), 3);

    // A stale icon is fetched again (the project record is still cached).
    age_file(&icons.path().join("P7dR8mSH.png"), 8);
    assert_eq!(c.fetch_icons(&ids, icons.path()).await, r);
    let reqs = h.requests().await;
    assert_eq!((reqs.len(), icon_requests(&reqs)), (4, 3));

    // The API is unreachable: the project lookup comes back offline, so the CDN is not asked
    // either (even for the stale icon), and what is on disk is returned.
    h.advance(30 * DAY_MS);
    age_file(&icons.path().join("P7dR8mSH.png"), 8);
    let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_url = format!("http://{}", dead.local_addr().unwrap());
    drop(dead);
    assert_eq!(h.client_with(dead_url, true).fetch_icons(&ids, icons.path()).await, r);
    // Offline client: no request, cached icons only.
    assert_eq!(h.client(false).fetch_icons(&ids, icons.path()).await, r);
    assert_eq!(h.requests().await.len(), 4);
    h.assert_ua().await;
}

#[tokio::test]
async fn attach_cached_icons_never_fetches() {
    let h = Harness::new().await;
    mount_projects_for_any_id(&h).await;
    let c = h.client(true);
    let icons = TempDir::new().unwrap();
    let old = icons.path().join("AANobbMI.webp");
    std::fs::write(&old, b"RIFF\x10\0\0\0WEBPVP8 ").unwrap();
    age_file(&old, 365);
    let (mut r, urls) = c.projects_with_icon_urls(&["AANobbMI".into(), "P7dR8mSH".into()], false).await.unwrap();
    c.attach_cached_icons(&mut r, &urls, icons.path()).await;
    assert_eq!(r.found["AANobbMI"].icon_path.as_deref().map(Path::new), Some(old.as_path()));
    assert_eq!(r.found["P7dR8mSH"].icon_path, None);
    assert_eq!(icon_requests(&h.requests().await), 0);
}

// ---------- datePublished / cache schema ----------

#[test]
fn date_published_is_parsed_and_optional() {
    let cdn = api::CdnCheck { host: "cdn.modrinth.com".into(), allow_http: false };
    let mut v = version_json("OihdIimA", "AANobbMI", &sha(5), "https://cdn.modrinth.com");
    v["date_published"] = json!("2024-05-06T07:08:09.123456Z");
    let m = api::version_from_json(v.clone(), &cdn).unwrap();
    assert_eq!(m.date_published.as_deref(), Some("2024-05-06T07:08:09.123456Z"));
    assert_eq!(serde_json::to_value(&m).unwrap()["datePublished"], json!("2024-05-06T07:08:09.123456Z"));

    v["date_published"] = Value::Null;
    assert_eq!(api::version_from_json(v.clone(), &cdn).unwrap().date_published, None);
    v.as_object_mut().unwrap().remove("date_published");
    let m = api::version_from_json(v, &cdn).unwrap();
    assert_eq!(m.date_published, None);
    // Left out on the wire when absent (`datePublished?: string`).
    assert!(serde_json::to_value(&m).unwrap().get("datePublished").is_none());
}

#[tokio::test]
async fn schema_1_cache_entries_are_refetched() {
    let h = Harness::new().await;
    let cdn = h.cdn();
    let body = version_json("OihdIimA", "AANobbMI", &sha(5), &cdn);
    Mock::given(method("GET"))
        .and(path("/v2/version/OihdIimA"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body.clone()))
        .expect(1)
        .mount(&h.server)
        .await;
    mount_identify(&h).await;
    let c = h.client(true);
    let now = c.inner.now();

    // What an M5-beta build wrote: schema 1, fresh, no `datePublished`.
    let mut old = serde_json::to_value(api::version_from_json(body, &c.inner.cdn).unwrap()).unwrap();
    old.as_object_mut().unwrap().remove("datePublished");
    let write_v1 = |ns: &str, key: &str| {
        let file = c.inner.cache.path(ns, key);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let entry = json!({"v": 1, "key": key, "fetched_at_ms": now, "value": old});
        std::fs::write(&file, serde_json::to_vec(&entry).unwrap()).unwrap();
        file
    };
    let version_file = write_v1(NS_VERSIONS, "OihdIimA");
    let hash_file = write_v1(NS_IDENTIFY, &sha(2));

    let v = c.version("OihdIimA").await.unwrap();
    assert_eq!(v.date_published.as_deref(), Some("2024-01-01T00:00:00Z"));
    let r = c.identify(&[sha(2)], false).await.unwrap();
    assert_eq!(r.found[&sha(2)].date_published.as_deref(), Some("2024-01-01T00:00:00Z"));
    assert_eq!(h.requests().await.len(), 2);
    for file in [version_file, hash_file] {
        let entry: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(entry["v"], json!(2), "{} not rewritten", file.display());
        assert!(entry["value"]["datePublished"].is_string());
    }
    // Rewritten entries are served from the cache again.
    c.version("OihdIimA").await.unwrap();
    c.identify(&[sha(2)], false).await.unwrap();
    assert_eq!(h.requests().await.len(), 2);
    // Offline, a schema-1 entry is as good as absent: unknown, never a stale MrVersion.
    write_v1(NS_IDENTIFY, &sha(4));
    let off = h.client(false).identify(&[sha(4)], false).await.unwrap();
    assert!(off.found.is_empty() && off.failed == vec![sha(4)]);
}

#[tokio::test]
async fn download_unknown_size_allowed_up_to_cap() {
    let h = Harness::new().await;
    let small = vec![1u8; 90 * 1024];
    let big = vec![2u8; 120 * 1024];
    Mock::given(method("GET")).and(path("/data/small.jar")).respond_with(ResponseTemplate::new(200).set_body_bytes(small.clone())).mount(&h.server).await;
    Mock::given(method("GET")).and(path("/data/big.jar")).respond_with(ResponseTemplate::new(200).set_body_bytes(big.clone())).mount(&h.server).await;
    let c = h.client(true);
    let dest = TempDir::new().unwrap();
    // Unknown size: only the hard cap applies (90 KiB is under the 100 KiB test cap)...
    let p = c.download_verified(&format!("{}/data/small.jar", h.cdn()), &sha512_hex(&small), None, dest.path(), "small.jar").await.unwrap();
    assert_eq!(std::fs::read(p).unwrap(), small);
    // ...and the hard cap still applies.
    let e = c.download_verified(&format!("{}/data/big.jar", h.cdn()), &sha512_hex(&big), None, dest.path(), "big.jar").await.unwrap_err();
    assert!(matches!(e, Error::Corrupt { .. }), "{e:?}");
    assert!(!dest.path().join(".big.jar.part").exists());
    // A known size keeps its own (tighter) limit: size + 64 KiB.
    let e = c.download_verified(&format!("{}/data/small.jar", h.cdn()), &sha512_hex(&small), Some(1), dest.path(), "s2.jar").await.unwrap_err();
    assert!(matches!(e, Error::Corrupt { .. }), "{e:?}");
    h.assert_ua().await;
}

#[tokio::test]
async fn dropped_primary_is_reported_end_to_end() {
    let h = Harness::new().await;
    let cdn = h.cdn();
    Mock::given(method("GET"))
        .and(path("/v2/version/OihdIimA"))
        .respond_with(move |_: &Request| {
            let mut v = version_json("OihdIimA", "AANobbMI", &sha(5), &cdn);
            v["files"][0]["url"] = json!("https://github.com/x/mod.jar"); // primary off-CDN
            let mut extra = version_json("OihdIimA", "AANobbMI", &sha(6), &cdn)["files"][0].clone();
            extra["primary"] = json!(false);
            extra["size"] = Value::Null;
            v["files"].as_array_mut().unwrap().push(extra);
            ResponseTemplate::new(200).set_body_json(v)
        })
        .mount(&h.server)
        .await;
    let v = h.client(true).version("OihdIimA").await.unwrap();
    assert_eq!((v.files.len(), v.dropped_files, v.primary_dropped), (1, 1, true));
    assert_eq!(v.files[0].size, None);
}

// ---------- search / resolve_mod_id ----------

fn project_with_loaders(id: &str, slug: &str, title: &str, ptype: &str, loaders: &[&str]) -> Value {
    json!({"id": id, "slug": slug, "title": title, "project_type": ptype, "client_side": "optional",
           "server_side": "optional", "loaders": loaders, "game_versions": ["1.20.1"]})
}

fn hit(id: &str, slug: &str, title: &str) -> Value {
    json!({"project_id": id, "slug": slug, "title": title, "project_type": "mod", "client_side": "required",
           "server_side": "optional", "environment": ["client_and_server"], "categories": ["fabric"]})
}

/// `/v2/projects` that knows `projects`; `/v2/search` that answers `hits`.
async fn mount_resolve(h: &Harness, projects: Vec<Value>, hits: Vec<Value>) {
    Mock::given(method("GET"))
        .and(path("/v2/projects"))
        .and(header("user-agent", UA))
        .respond_with(move |r: &Request| {
            let ids: Vec<String> =
                r.url.query_pairs().find(|(k, _)| k == "ids").map(|(_, v)| serde_json::from_str(&v).unwrap()).unwrap();
            let found: Vec<Value> = projects
                .iter()
                .filter(|p| ids.iter().any(|i| i == p["id"].as_str().unwrap() || i.eq_ignore_ascii_case(p["slug"].as_str().unwrap())))
                .cloned()
                .collect();
            ResponseTemplate::new(200).set_body_json(found)
        })
        .mount(&h.server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/search"))
        .and(header("user-agent", UA))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"hits": hits, "offset": 0, "limit": 10, "total_hits": 1})))
        .mount(&h.server)
        .await;
}

async fn count(h: &Harness, p: &str) -> usize {
    h.requests().await.iter().filter(|r| r.url.path() == p).count()
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn query_map(r: &Request) -> std::collections::HashMap<String, String> {
    r.url.query_pairs().into_owned().collect()
}

#[tokio::test]
async fn resolve_by_slug_guess_in_one_batch() {
    let h = Harness::new().await;
    mount_resolve(&h, vec![project_with_loaders("9s6osm5g", "cloth-config", "Cloth Config API", "mod", &["fabric", "forge"])], vec![]).await;
    let c = h.client(true);
    let p = c.resolve_mod_id("cloth_config", &strs(&["forge"]), &strs(&["1.20.1"])).await.unwrap().unwrap();
    assert_eq!(p.id, "9s6osm5g");
    let reqs = h.requests().await;
    assert_eq!(reqs.len(), 1, "guesses must go in one request and need no search");
    let ids: Vec<String> = serde_json::from_str(&query_map(&reqs[0])["ids"]).unwrap();
    assert_eq!(ids, vec!["cloth_config", "cloth-config"]);
    // Cached.
    assert_eq!(c.resolve_mod_id("cloth_config", &strs(&["forge"]), &strs(&["1.20.1"])).await.unwrap().unwrap().id, "9s6osm5g");
    assert_eq!(h.requests().await.len(), 1);
    h.assert_ua().await;
}

#[tokio::test]
async fn resolve_uses_alias_table() {
    let h = Harness::new().await;
    mount_resolve(&h, vec![project_with_loaders("lhGA9TYQ", "architectury-api", "Architectury API", "mod", &["fabric", "forge"])], vec![]).await;
    let p = h.client(true).resolve_mod_id("architectury", &strs(&["fabric"]), &[]).await.unwrap().unwrap();
    assert_eq!(p.slug, "architectury-api");
    assert_eq!(count(&h, "/v2/search").await, 0);
}

#[tokio::test]
async fn resolve_rejects_wrong_loader_or_type_then_searches() {
    let h = Harness::new().await;
    // `jei` exists but is Forge-only here and `my_mod` is a resource pack: neither may satisfy
    // a Fabric lookup; search must then find the right project by name.
    mount_resolve(
        &h,
        vec![
            project_with_loaders("u6dRKJwZ", "jei", "Just Enough Items", "mod", &["forge"]),
            project_with_loaders("RESPACK1", "my_mod", "My Mod", "resourcepack", &["minecraft"]),
        ],
        vec![hit("ZZZZZZZ1", "my-mod-fabric-port", "Totally Different"), hit("ABCDEFG1", "my-mod", "My Mod Reborn")],
    )
    .await;
    let c = h.client(true);
    let p = c.resolve_mod_id("my_mod", &strs(&["fabric"]), &strs(&["1.20.1"])).await.unwrap().unwrap();
    assert_eq!(p.id, "ABCDEFG1", "only a hit whose slug/title normalises to the id counts");
    let search = h.requests().await.into_iter().find(|r| r.url.path() == "/v2/search").unwrap();
    let q = query_map(&search);
    assert_eq!(q["query"], "my mod");
    assert_eq!(q["limit"], "10");
    let facets: Value = serde_json::from_str(&q["facets"]).unwrap();
    assert_eq!(facets, json!([["project_type:mod"], ["categories:fabric"], ["versions:1.20.1"]]));

    assert_eq!(c.resolve_mod_id("jei", &strs(&["fabric"]), &[]).await.unwrap(), None, "loader mismatch and no search match");
    h.assert_ua().await;
}

#[tokio::test]
async fn resolve_negative_is_cached_and_served_offline() {
    let h = Harness::new().await;
    mount_resolve(&h, vec![], vec![hit("ZZZZZZZ1", "unrelated", "Unrelated")]).await;
    let c = h.client(true);
    assert_eq!(c.resolve_mod_id("nosuchmod", &strs(&["fabric"]), &[]).await.unwrap(), None);
    assert_eq!(h.requests().await.len(), 2); // projects + search
    assert_eq!(c.resolve_mod_id("nosuchmod", &strs(&["fabric"]), &[]).await.unwrap(), None);
    assert_eq!(h.requests().await.len(), 2, "negative answer cached");
    // Offline: cached answers (even expired) are served; unknown ids are an error, not "absent".
    h.advance(10 * DAY_MS);
    let off = h.client(false);
    assert_eq!(off.resolve_mod_id("nosuchmod", &strs(&["fabric"]), &[]).await.unwrap(), None);
    assert!(matches!(off.resolve_mod_id("othermod", &strs(&["fabric"]), &[]).await, Err(Error::Offline)));
    // Online again after 24 h: the negative entry expired and is looked up again.
    c.resolve_mod_id("nosuchmod", &strs(&["fabric"]), &[]).await.unwrap();
    assert_eq!(h.requests().await.len(), 4);
    // Different filters = different cache entry (the projects guess is cached; search is not).
    c.resolve_mod_id("nosuchmod", &strs(&["forge"]), &[]).await.unwrap();
    assert_eq!(count(&h, "/v2/search").await, 3);
}

#[tokio::test]
async fn resolve_pseudo_deps_and_invalid_ids_make_no_requests() {
    let h = Harness::new().await;
    let c = h.client(true);
    for id in ["minecraft", "java", "fabricloader", "forge", "neoforge"] {
        assert_eq!(c.resolve_mod_id(id, &[], &[]).await.unwrap(), None);
    }
    for bad in ["..", "a/b", "", "has space"] {
        assert!(matches!(c.resolve_mod_id(bad, &[], &[]).await, Err(Error::Invalid(_))), "{bad}");
    }
    assert!(h.requests().await.is_empty());
}

#[tokio::test]
async fn resolve_network_failure_is_an_error_not_absent() {
    let h = Harness::new().await;
    Mock::given(wiremock::matchers::any()).respond_with(ResponseTemplate::new(503)).mount(&h.server).await;
    let e = h.client(true).resolve_mod_id("somemod", &[], &[]).await.unwrap_err();
    assert!(matches!(e, Error::Network(_)), "{e:?}");
}

#[tokio::test]
async fn search_sends_query_facets_limit_and_validates() {
    let h = Harness::new().await;
    mount_resolve(&h, vec![], vec![hit("AANobbMI", "sodium", "Sodium"), json!({"broken": true})]).await;
    let c = h.client(true);
    let facets = vec![strs(&["project_type:mod"]), vec![], strs(&["categories:fabric", "categories:quilt"])];
    let hits = c.search("sodium", &facets, 5).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "AANobbMI");
    assert_eq!(hits[0].environment, vec!["client_and_server".to_string()]);
    let q = query_map(&h.requests().await[0]);
    assert_eq!(q["query"], "sodium");
    assert_eq!(q["limit"], "5");
    assert_eq!(serde_json::from_str::<Value>(&q["facets"]).unwrap(), json!([["project_type:mod"], ["categories:fabric", "categories:quilt"]]));
    // No facets: the parameter is omitted.
    c.search("sodium", &[], 1).await.unwrap();
    assert!(!query_map(&h.requests().await[1]).contains_key("facets"));
    assert!(matches!(c.search("x", &[], 0).await, Err(Error::Invalid(_))));
    assert!(matches!(c.search("x", &[], 101).await, Err(Error::Invalid(_))));
    assert!(matches!(c.search("x", &[strs(&["nocolon"])], 5).await, Err(Error::Invalid(_))));
    assert!(matches!(c.search("a\nb", &[], 5).await, Err(Error::Invalid(_))));
    assert!(matches!(h.client(false).search("x", &[], 5).await, Err(Error::Offline)));
    assert_eq!(h.requests().await.len(), 2);
    h.assert_ua().await;
}
