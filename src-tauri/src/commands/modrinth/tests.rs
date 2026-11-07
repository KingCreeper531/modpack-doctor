//! The `modrinth_*` commands end to end through the `AppState`-held client, against wiremock.
//! No real network.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tempfile::TempDir;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use super::*;
use crate::error::{AppError, ErrorKind};
use crate::model::SettingsPatch;

const SODIUM: &str = "AANobbMI";
const FAPI: &str = "P7dR8mSH";
const CLOTH: &str = "9s6osm5g";
const WEBP: &[u8] = b"RIFF\x10\0\0\0WEBPVP8 ";

struct Harness {
    server: MockServer,
    _dir: TempDir,
    icon_dir: PathBuf,
    st: AppState,
}

impl Harness {
    async fn new() -> Self {
        let server = MockServer::start().await;
        let dir = TempDir::new().unwrap();
        let icon_dir = dir.path().join("icons");
        let svc = ModrinthService::for_tests(
            server.uri(),
            server.address().to_string(),
            dir.path().join("modrinth"),
            icon_dir.clone(),
        );
        let st = AppState { modrinth: Some(svc), ..AppState::default() };
        Harness { server, _dir: dir, icon_dir, st }
    }

    fn cdn(&self) -> String {
        self.server.uri()
    }

    /// What `set_settings` does with `{ modrinthEnabled }`.
    fn set_enabled(&self, enabled: bool) {
        let patch = SettingsPatch { modrinth_enabled: Some(enabled), ..SettingsPatch::default() };
        self.st.settings.update(|s| crate::settings::apply_patch(s, patch, &HashSet::new())).unwrap();
        assert_eq!(self.st.settings.get().modrinth_enabled, enabled);
    }

    async fn requests(&self) -> Vec<Request> {
        self.server.received_requests().await.unwrap()
    }

    async fn count(&self) -> usize {
        self.requests().await.len()
    }

    /// Invariant 10: every request carries the app's User-Agent.
    async fn assert_ua(&self) {
        for r in self.requests().await {
            let ua = r.headers.get("user-agent").and_then(|v| v.to_str().ok());
            assert_eq!(ua, Some(crate::USER_AGENT), "request to {} without the app User-Agent", r.url);
        }
    }

    /// Mounts every endpoint the commands use, with a small fixed world:
    /// hashes `sha(n)` with even n are known (project SODIUM), projects SODIUM (icon ok),
    /// FAPI (icon 500) and CLOTH (icon ok), two SODIUM versions (release + beta).
    async fn mount_world(&self) {
        let cdn = self.cdn();
        let c1 = cdn.clone();
        Mock::given(method("POST"))
            .and(path("/v2/version_files"))
            .respond_with(move |r: &Request| known_hashes(r, &c1))
            .mount(&self.server)
            .await;
        let c2 = cdn.clone();
        Mock::given(method("POST"))
            .and(path("/v2/version_files/update"))
            .respond_with(move |r: &Request| known_hashes(r, &c2))
            .mount(&self.server)
            .await;
        let projects = [
            project_json(SODIUM, "sodium", "Sodium", &["fabric", "quilt"], &cdn),
            project_json(FAPI, "fabric-api", "Fabric API", &["fabric"], &cdn),
            project_json(CLOTH, "cloth-config", "Cloth Config API", &["fabric", "forge"], &cdn),
        ];
        Mock::given(method("GET"))
            .and(path("/v2/projects"))
            .respond_with(move |r: &Request| {
                let ids: Vec<String> = r
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "ids")
                    .map(|(_, v)| serde_json::from_str(&v).unwrap())
                    .unwrap();
                let hits: Vec<Value> = projects
                    .iter()
                    .filter(|p| {
                        ids.iter().any(|i| i == p["id"].as_str().unwrap() || i.eq_ignore_ascii_case(p["slug"].as_str().unwrap()))
                    })
                    .cloned()
                    .collect();
                ResponseTemplate::new(200).set_body_json(hits)
            })
            .mount(&self.server)
            .await;
        let versions = json!([
            version_json("V0000002", SODIUM, &sha(2), "release", &cdn),
            version_json("V0000004", SODIUM, &sha(4), "beta", &cdn),
        ]);
        Mock::given(method("GET"))
            .and(path(format!("/v2/project/{SODIUM}/version")))
            .respond_with(ResponseTemplate::new(200).set_body_json(versions))
            .mount(&self.server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v2/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"hits": [], "offset": 0, "limit": 10, "total_hits": 0})))
            .mount(&self.server)
            .await;
        for id in [SODIUM, CLOTH] {
            Mock::given(method("GET"))
                .and(path(format!("/data/{id}/icon.webp")))
                .respond_with(ResponseTemplate::new(200).set_body_raw(WEBP.to_vec(), "image/webp"))
                .mount(&self.server)
                .await;
        }
        Mock::given(method("GET"))
            .and(path(format!("/data/{FAPI}/icon.webp")))
            .respond_with(ResponseTemplate::new(500))
            .mount(&self.server)
            .await;
    }
}

fn sha(n: usize) -> String {
    format!("{n:040x}")
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn version_json(id: &str, project: &str, sha1: &str, version_type: &str, cdn: &str) -> Value {
    json!({
        "id": id, "project_id": project, "name": format!("Version {id}"), "version_number": "1.0.0",
        "game_versions": ["1.20.1"], "loaders": ["fabric"], "version_type": version_type,
        "environment": "client_and_server", "date_published": "2024-01-01T00:00:00Z",
        "files": [{
            "hashes": {"sha1": sha1, "sha512": "a".repeat(128)},
            "url": format!("{cdn}/data/{project}/versions/{id}/mod.jar"),
            "filename": "mod.jar", "primary": true, "size": 3, "file_type": null
        }],
        "dependencies": []
    })
}

fn project_json(id: &str, slug: &str, title: &str, loaders: &[&str], cdn: &str) -> Value {
    json!({"id": id, "slug": slug, "title": title, "project_type": "mod",
           "client_side": "required", "server_side": "optional", "environment": ["client_and_server"],
           "loaders": loaders, "game_versions": ["1.20.1"],
           "icon_url": format!("{cdn}/data/{id}/icon.webp")})
}

/// Version-file answers: hashes with an even number are known.
fn known_hashes(r: &Request, cdn: &str) -> ResponseTemplate {
    let body: Value = r.body_json().unwrap();
    let mut m = serde_json::Map::new();
    for h in body["hashes"].as_array().unwrap() {
        let h = h.as_str().unwrap();
        let n = usize::from_str_radix(h, 16).unwrap();
        if n % 2 == 0 {
            m.insert(h.to_string(), version_json(&format!("V{n:07}"), SODIUM, h, "release", cdn));
        }
    }
    ResponseTemplate::new(200).set_body_json(Value::Object(m))
}

fn is_under(p: &str, dir: &Path) -> bool {
    let p = Path::new(p);
    p.is_absolute() && p.starts_with(dir) && p.is_file()
}

#[tokio::test]
async fn identify_and_find_updates_go_through_the_shared_client() {
    let h = Harness::new().await;
    h.mount_world().await;

    let r = identify_with(&h.st, vec![sha(2).to_ascii_uppercase(), sha(3)], false).await.unwrap();
    assert_eq!(r.found.keys().cloned().collect::<Vec<_>>(), vec![sha(2)]);
    assert!(r.failed.is_empty() && !r.offline);
    // Cached: no second request, unknown hash included.
    let again = identify_with(&h.st, vec![sha(2), sha(3)], false).await.unwrap();
    assert_eq!(again, r);
    assert_eq!(h.count().await, 1);
    // `refresh` bypasses the cache.
    identify_with(&h.st, vec![sha(2)], true).await.unwrap();
    assert_eq!(h.count().await, 2);

    let u = find_updates_with(&h.st, vec![sha(4)], s(&["Fabric"]), s(&["1.20.1"]), s(&["release"]), false).await.unwrap();
    assert_eq!(u.found[&sha(4)].id, "V0000004");
    let req = h.requests().await.into_iter().find(|r| r.url.path() == "/v2/version_files/update").unwrap();
    let body: Value = req.body_json().unwrap();
    assert_eq!(body["loaders"], json!(["fabric"]));
    assert_eq!(body["game_versions"], json!(["1.20.1"]));
    assert_eq!(body["version_types"], json!(["release"]));
    h.assert_ua().await;
}

fn icon_requests(reqs: &[Request]) -> Vec<String> {
    reqs.iter().map(|r| r.url.path().to_string()).filter(|p| p.starts_with("/data/")).collect()
}

fn age_file(p: &Path, days: u64) {
    let f = std::fs::File::options().write(true).open(p).unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(days * 24 * 3600)).unwrap();
}

#[tokio::test]
async fn projects_never_download_icons_and_icons_is_the_second_pass() {
    let h = Harness::new().await;
    h.mount_world().await;

    // First pass: titles and sides at once, no icon request, no icon on disk yet.
    let r = projects_with(&h.st, s(&["sodium", FAPI, "nope"]), false).await.unwrap();
    assert!(r.failed.is_empty() && !r.offline);
    assert_eq!(r.found["sodium"].id, SODIUM);
    assert_eq!(r.found[FAPI].title, "Fabric API");
    assert!(r.found.values().all(|p| p.icon_path.is_none()));
    assert!(!r.found.contains_key("nope"));
    assert_eq!(icon_requests(&h.requests().await), Vec::<String>::new());
    let after_projects = h.count().await;

    // Second pass: icons. SODIUM and FAPI come from the project cache, CLOTH needs a lookup.
    // The icon server failed for Fabric API: it is just left out.
    let icons = icons_with(&h.st, s(&[SODIUM, FAPI, CLOTH])).await.unwrap();
    assert_eq!(icons.keys().map(String::as_str).collect::<Vec<_>>(), vec![CLOTH, SODIUM]);
    for (id, p) in &icons {
        assert!(is_under(p, &h.icon_dir), "{p} is not a cached file under {}", h.icon_dir.display());
        assert_eq!(Path::new(p), h.icon_dir.join(format!("{id}.webp")));
        assert_eq!(std::fs::read(p).unwrap(), WEBP);
    }
    let reqs = h.requests().await;
    let projects_calls: Vec<&Request> = reqs[after_projects..].iter().filter(|r| r.url.path() == "/v2/projects").collect();
    assert_eq!(projects_calls.len(), 1);
    assert!(projects_calls[0].url.query().unwrap().contains(CLOTH));
    assert!(!projects_calls[0].url.query().unwrap().contains(SODIUM));

    // Again: fresh icons are reused and the projects are cached; only the failed icon is retried.
    let before = h.count().await;
    assert_eq!(icons_with(&h.st, s(&[SODIUM, FAPI, CLOTH])).await.unwrap(), icons);
    let new: Vec<String> = h.requests().await[before..].iter().map(|r| r.url.path().to_string()).collect();
    assert!(!new.is_empty() && new.iter().all(|p| *p == format!("/data/{FAPI}/icon.webp")), "{new:?}");

    // Now `modrinth_projects` attaches the icons on disk, still without any request.
    let before = h.count().await;
    let r = projects_with(&h.st, s(&["sodium", FAPI]), false).await.unwrap();
    assert_eq!(r.found["sodium"].icon_path.as_ref(), Some(&icons[SODIUM]));
    assert_eq!(r.found[FAPI].icon_path, None);
    // Any age: a stale icon is still attached by `modrinth_projects`, and refreshed by `modrinth_icons`.
    age_file(Path::new(&icons[SODIUM]), 30);
    let r = projects_with(&h.st, s(&["sodium"]), false).await.unwrap();
    assert_eq!(r.found["sodium"].icon_path.as_ref(), Some(&icons[SODIUM]));
    assert_eq!(h.count().await, before);
    assert_eq!(icons_with(&h.st, s(&[SODIUM])).await.unwrap()[SODIUM], icons[SODIUM]);
    assert_eq!(icon_requests(&h.requests().await[before..]), vec![format!("/data/{SODIUM}/icon.webp")]);
    h.assert_ua().await;
}

#[tokio::test]
async fn project_versions_filter_by_version_type() {
    let h = Harness::new().await;
    h.mount_world().await;

    let v = project_versions_with(&h.st, SODIUM.into(), s(&["fabric"]), s(&["1.20.1"]), s(&["release"])).await.unwrap();
    assert_eq!(v.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["V0000002"]);
    let both = project_versions_with(&h.st, SODIUM.into(), s(&["fabric"]), s(&["1.20.1"]), s(&["release", "beta"])).await.unwrap();
    assert_eq!(both.len(), 2);
    let req = h.requests().await.into_iter().find(|r| r.url.path().ends_with("/version")).unwrap();
    let q: std::collections::HashMap<String, String> = req.url.query_pairs().into_owned().collect();
    assert_eq!(q["loaders"], r#"["fabric"]"#);
    assert_eq!(q["game_versions"], r#"["1.20.1"]"#);
    h.assert_ua().await;
}

#[tokio::test]
async fn resolve_mod_id_returns_the_project_and_only_a_cached_icon() {
    let h = Harness::new().await;
    h.mount_world().await;

    let p = resolve_mod_id_with(&h.st, "cloth_config".into(), s(&["forge"]), s(&["1.20.1"])).await.unwrap().unwrap();
    assert_eq!(p.id, CLOTH);
    assert_eq!(p.slug, "cloth-config");
    // Never waits for the CDN: no icon yet, and the project came from the cache filled by the slug
    // guess (one projects request).
    assert_eq!(p.icon_path, None);
    assert!(h.requests().await.iter().all(|r| !r.url.path().starts_with("/data/")), "no icon request");
    let projects_calls = h.requests().await.iter().filter(|r| r.url.path() == "/v2/projects").count();
    assert_eq!(projects_calls, 1);
    // After the icons pass, resolve attaches the cached icon.
    let fetched = icons_with(&h.st, s(&[CLOTH])).await.unwrap();
    let p = resolve_mod_id_with(&h.st, "cloth_config".into(), s(&["forge"]), s(&["1.20.1"])).await.unwrap().unwrap();
    let icon = p.icon_path.expect("cached icon attached");
    assert!(is_under(&icon, &h.icon_dir), "{icon}");
    assert_eq!(icon, fetched[CLOTH]);
    // Pseudo-dependencies resolve to nothing without a request.
    let before = h.count().await;
    assert_eq!(resolve_mod_id_with(&h.st, "minecraft".into(), s(&["forge"]), vec![]).await.unwrap(), None);
    assert_eq!(h.count().await, before);
    h.assert_ua().await;
}

#[tokio::test]
async fn disabled_modrinth_is_cache_only_and_reenabling_needs_no_restart() {
    let h = Harness::new().await;
    h.mount_world().await;

    // Prime the caches while enabled.
    identify_with(&h.st, vec![sha(2)], false).await.unwrap();
    let icons = icons_with(&h.st, s(&[SODIUM])).await.unwrap();
    assert!(icons.contains_key(SODIUM));
    let projects = projects_with(&h.st, s(&["sodium"]), false).await.unwrap();
    let versions = project_versions_with(&h.st, SODIUM.into(), s(&["fabric"]), s(&["1.20.1"]), s(&["release"])).await.unwrap();
    let resolved = resolve_mod_id_with(&h.st, "cloth_config".into(), s(&["forge"]), vec![]).await.unwrap();
    let primed = h.count().await;

    h.set_enabled(false);
    // Even with `refresh`, nothing is sent: cached data comes back marked offline.
    let r = identify_with(&h.st, vec![sha(2), sha(6)], true).await.unwrap();
    assert!(r.offline);
    assert_eq!(r.found.keys().cloned().collect::<Vec<_>>(), vec![sha(2)]);
    assert_eq!(r.failed, vec![sha(6)]);
    let u = find_updates_with(&h.st, vec![sha(2)], s(&["fabric"]), s(&["1.20.1"]), s(&["release"]), true).await.unwrap();
    assert!(u.offline && u.found.is_empty() && u.failed == vec![sha(2)]);
    let p = projects_with(&h.st, s(&["sodium"]), true).await.unwrap();
    assert!(p.offline);
    assert_eq!(p.found, projects.found, "cached project with its cached icon path");
    assert_eq!(p.found["sodium"].icon_path.as_ref(), Some(&icons[SODIUM]));
    // Icons: only what is on disk (SODIUM; resolving CLOTH never downloads its icon), no request
    // even when stale.
    age_file(Path::new(&icons[SODIUM]), 30);
    let off_icons = icons_with(&h.st, s(&[SODIUM, CLOTH, FAPI])).await.unwrap();
    assert_eq!(off_icons.keys().map(String::as_str).collect::<Vec<_>>(), vec![SODIUM]);
    assert_eq!(off_icons[SODIUM], icons[SODIUM]);
    let v = project_versions_with(&h.st, SODIUM.into(), s(&["fabric"]), s(&["1.20.1"]), s(&["release"])).await.unwrap();
    assert_eq!(v, versions);
    let e = project_versions_with(&h.st, SODIUM.into(), s(&["quilt"]), s(&["1.20.1"]), s(&["release"])).await.unwrap_err();
    assert_eq!(AppError::from(e).kind, ErrorKind::Offline);
    assert_eq!(resolve_mod_id_with(&h.st, "cloth_config".into(), s(&["forge"]), vec![]).await.unwrap(), resolved);
    let e = resolve_mod_id_with(&h.st, "jei".into(), s(&["forge"]), vec![]).await.unwrap_err();
    assert_eq!(AppError::from(e).kind, ErrorKind::Offline);
    assert_eq!(h.count().await, primed, "a request was sent while Modrinth was turned off");

    // Turned back on: the very next command goes online again.
    h.set_enabled(true);
    let r = identify_with(&h.st, vec![sha(6)], false).await.unwrap();
    assert!(!r.offline);
    assert!(r.found.contains_key(&sha(6)));
    assert_eq!(h.count().await, primed + 1);
    h.assert_ua().await;
}

#[tokio::test]
async fn invalid_input_is_rejected_with_a_sentence_and_no_request() {
    let h = Harness::new().await;
    h.mount_world().await;
    let ok = || s(&["fabric"]);
    let mc = || s(&["1.20.1"]);
    let rel = || s(&["release"]);
    let many: Vec<String> = (0..5_001).map(sha).collect();

    let errors: Vec<(&str, Error)> = vec![
        ("bad sha1", identify_with(&h.st, s(&["not-a-hash"]), false).await.unwrap_err()),
        ("too many hashes", identify_with(&h.st, many, false).await.unwrap_err()),
        ("bad version type", find_updates_with(&h.st, vec![sha(2)], ok(), mc(), s(&["snapshot"]), false).await.unwrap_err()),
        ("bad loader", find_updates_with(&h.st, vec![sha(2)], s(&["fab ric"]), mc(), rel(), false).await.unwrap_err()),
        ("empty game version", find_updates_with(&h.st, vec![sha(2)], ok(), s(&[""]), rel(), false).await.unwrap_err()),
        ("bad project id", projects_with(&h.st, s(&["sodium", "../etc"]), false).await.unwrap_err()),
        ("icon slug", icons_with(&h.st, s(&[SODIUM, "sodium"])).await.unwrap_err()),
        ("icon path id", icons_with(&h.st, s(&["../../x"])).await.unwrap_err()),
        ("too many icons", icons_with(&h.st, vec![SODIUM.to_string(); 1_001]).await.unwrap_err()),
        ("path project id", project_versions_with(&h.st, "a/b".into(), ok(), mc(), rel()).await.unwrap_err()),
        ("dots project id", project_versions_with(&h.st, "..".into(), ok(), mc(), rel()).await.unwrap_err()),
        ("alpha typo", project_versions_with(&h.st, SODIUM.into(), ok(), mc(), s(&["alfa"])).await.unwrap_err()),
        ("empty mod id", resolve_mod_id_with(&h.st, "".into(), ok(), mc()).await.unwrap_err()),
        // A pseudo-dependency with a bad filter is still rejected.
        ("pseudo dep bad loader", resolve_mod_id_with(&h.st, "minecraft".into(), s(&["a\nb"]), mc()).await.unwrap_err()),
    ];
    for (what, e) in errors {
        assert!(matches!(e, Error::Invalid(_)), "{what}: {e:?}");
        let a = AppError::from(e);
        assert_eq!(a.kind, ErrorKind::Invalid, "{what}");
        assert!(a.message.ends_with('.'), "{what}: {}", a.message);
        assert!(a.message.starts_with("Invalid request: "), "{what}: {}", a.message);
        assert_eq!(a.retry_after_s, None);
    }
    // Rejected even when Modrinth is off.
    h.set_enabled(false);
    let e = identify_with(&h.st, s(&["xyz"]), false).await.unwrap_err();
    assert!(matches!(e, Error::Invalid(_)), "{e:?}");
    assert_eq!(h.count().await, 0);
}

#[tokio::test]
async fn rate_limit_surfaces_retry_after_s() {
    let h = Harness::new().await;
    // Asked to wait longer than the client sleeps through: reported at once.
    Mock::given(wiremock::matchers::any())
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("x-ratelimit-remaining", "0")
                .insert_header("x-ratelimit-reset", "120")
                .set_body_json(json!({"error": "ratelimit_error", "description": "rate limit exceeded; retry after 120000 milliseconds"})),
        )
        .mount(&h.server)
        .await;

    let e = identify_with(&h.st, vec![sha(2)], false).await.unwrap_err();
    let a = AppError::from(e);
    assert_eq!(a.kind, ErrorKind::RateLimited);
    assert_eq!(a.retry_after_s, Some(120));
    let wire = serde_json::to_value(&a).unwrap();
    assert_eq!(wire["retryAfterS"], json!(120));
    assert_eq!(wire["kind"], json!("rateLimited"));

    let e = project_versions_with(&h.st, SODIUM.into(), s(&["fabric"]), s(&["1.20.1"]), s(&["release"])).await.unwrap_err();
    assert_eq!(AppError::from(e).retry_after_s, Some(120));
    let e = projects_with(&h.st, s(&["sodium"]), false).await.unwrap_err();
    assert_eq!(AppError::from(e).retry_after_s, Some(120));
    // Icons are never worth an error: nothing on disk, nothing fetched, an empty answer.
    assert_eq!(icons_with(&h.st, s(&[SODIUM])).await.unwrap(), BTreeMap::new());
    h.assert_ua().await;
}

#[tokio::test]
async fn missing_service_is_a_readable_error() {
    let st = AppState::default();
    let a = AppError::from(identify_with(&st, vec![sha(2)], false).await.unwrap_err());
    assert_eq!(a.kind, ErrorKind::Internal);
    assert!(a.message.ends_with('.'), "{}", a.message);
}
