//! `/v2/search` and resolving a loader mod id (`cloth_config`, `architectury`) to a Modrinth
//! project, following docs/research/modrinth-api.md §5:
//!
//! 1. pseudo-dependencies (`minecraft`, `java`, loaders) resolve to nothing, without a request;
//! 2. slug guesses in one batched `projects` call, in priority order: alias table, the id as
//!    given, `_` → `-`, lower-cased. A hit counts only if it is a `mod` for one of the loaders;
//! 3. otherwise `/v2/search` with facets `project_type:mod`, `categories:<loader>`,
//!    `versions:<game version>`, accepting only a hit whose slug or title normalises to the id;
//! 4. the answer, including "not on Modrinth", is cached per id + filters.

use serde_json::{json, Value};

use super::api::{self, ProjectRecord};
use super::cache::Ttl;
use super::http::ReqError;
use super::{validate, Filters, ModrinthClient, API_TIMEOUT};
use crate::error::{Error, Result};
use crate::model::MrProject;

const NS_RESOLVE: &str = "resolve";
/// Research rec. 5: mod id → project guesses 7 days; "not found" 24 h.
const TTL_RESOLVE: Ttl = Ttl::hours(7 * 24, 24);
const RESOLVE_SEARCH_LIMIT: u32 = 10;
pub const MAX_SEARCH_LIMIT: u32 = 100;

/// Dependency ids that are the game, Java or a loader, never a Modrinth mod.
const PSEUDO_DEPS: [&str; 10] = [
    "minecraft",
    "java",
    "fabricloader",
    "fabric-loader",
    "quilt_loader",
    "quilt-loader",
    "forge",
    "neoforge",
    "fml",
    "javafml",
];

/// Mod ids whose Modrinth slug differs by more than `_`/`-`/case (research §5 + well-known).
const ALIASES: [(&str, &str); 6] = [
    ("architectury", "architectury-api"),
    ("fabric", "fabric-api"),
    ("quilted_fabric_api", "qsl"),
    ("cloth-config2", "cloth-config"),
    ("kotlinforforge", "kotlin-for-forge"),
    ("forgeconfigapiport", "forge-config-api-port"),
];

pub(crate) fn is_pseudo_dependency(mod_id: &str) -> bool {
    PSEUDO_DEPS.contains(&mod_id.to_ascii_lowercase().as_str())
}

/// Fabric API module ids (`fabric-api-base`, `fabric-resource-loader-v0`, …) belong to `fabric-api`.
fn is_fabric_api_module(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("fabric-") else { return false };
    if id == "fabric-api-base" {
        return true;
    }
    rest.rsplit_once("-v").is_some_and(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Slug guesses in priority order, de-duplicated, invalid ones skipped.
pub(crate) fn candidates(mod_id: &str) -> Vec<String> {
    let lower = mod_id.to_ascii_lowercase();
    let mut out: Vec<String> = Vec::new();
    for (from, to) in ALIASES {
        if lower == from {
            out.push(to.to_string());
        }
    }
    if is_fabric_api_module(&lower) {
        out.push("fabric-api".into());
    }
    for c in [mod_id.to_string(), mod_id.replace('_', "-"), lower.clone(), lower.replace('_', "-")] {
        if validate::id_or_slug(&c).is_ok() && !out.contains(&c) {
            out.push(c);
        }
    }
    out
}

/// Lower-case alphanumerics only: `Cloth Config`, `cloth-config`, `cloth_config` → `clothconfig`.
pub(crate) fn normalize(s: &str) -> String {
    s.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

fn guess_ok(rec: &ProjectRecord, loaders: &[String]) -> bool {
    rec.project.project_type == "mod"
        && (loaders.is_empty() || rec.loaders.iter().any(|l| loaders.contains(&l.to_ascii_lowercase())))
}

fn check_facet(f: &str) -> Result<()> {
    let ok = !f.is_empty()
        && f.len() <= 128
        && !f.chars().any(char::is_control)
        && f.contains([':', '=', '<', '>']);
    if ok {
        Ok(())
    } else {
        Err(Error::Invalid(format!("\"{f}\" is not a Modrinth search facet such as \"categories:fabric\"")))
    }
}

impl ModrinthClient {
    /// `GET /v2/search`. `facets` is AND of OR-groups, e.g.
    /// `[["project_type:mod"], ["categories:fabric", "categories:quilt"], ["versions:1.20.1"]]`;
    /// empty groups are skipped. `limit` is 1–100. Hits are mapped to `MrProject` (no icon).
    pub async fn search(&self, query: &str, facets: &[Vec<String>], limit: u32) -> Result<Vec<MrProject>> {
        let query = query.trim();
        if query.chars().count() > 200 || query.chars().any(char::is_control) {
            return Err(Error::Invalid("the search text must be a single line of at most 200 characters".into()));
        }
        if !(1..=MAX_SEARCH_LIMIT).contains(&limit) {
            return Err(Error::Invalid(format!("the search limit must be between 1 and {MAX_SEARCH_LIMIT}")));
        }
        let groups: Vec<&Vec<String>> = facets.iter().filter(|g| !g.is_empty()).collect();
        for f in groups.iter().flat_map(|g| g.iter()) {
            check_facet(f)?;
        }
        if !self.inner.online {
            return Err(Error::Offline);
        }
        let mut url = self.inner.endpoint("/v2/search")?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("query", query);
            if !groups.is_empty() {
                q.append_pair("facets", &json!(groups).to_string());
            }
            q.append_pair("limit", &limit.to_string());
        }
        let inner = std::sync::Arc::clone(&self.inner);
        let build = move || inner.http.get(url.clone()).timeout(API_TIMEOUT);
        let what = "the Modrinth search";
        let body = self.inner.json(&build, None).await.map_err(|e| e.into_error(what))?;
        let hits = match body.get("hits") {
            Some(Value::Array(hits)) => hits.clone(),
            _ => return Err(ReqError::Body("expected search hits".into()).into_error(what)),
        };
        Ok(hits.into_iter().filter_map(api::search_hit_from_json).collect())
    }

    /// Resolve a loader mod id (`fabric.mod.json` / `mods.toml` id) to its Modrinth project.
    /// `Ok(None)` = not on Modrinth (or a pseudo-dependency such as `minecraft`). `loaders` /
    /// `game_versions` narrow the search and validate slug guesses (any-of). Cached 7 days
    /// (not found: 24 h); a stale answer is used offline or when Modrinth cannot be reached.
    pub async fn resolve_mod_id(
        &self,
        mod_id: &str,
        loaders: &[String],
        game_versions: &[String],
    ) -> Result<Option<MrProject>> {
        let mod_id = mod_id.trim();
        validate::id_or_slug(mod_id)?;
        if is_pseudo_dependency(mod_id) {
            return Ok(None);
        }
        let filters = Filters::new(loaders, game_versions, &[])?;
        let ns = format!("{NS_RESOLVE}/{}", filters.digest("resolve"));
        let key = mod_id.to_ascii_lowercase();
        let now = self.inner.now();
        let cached = self.inner.cache.get::<MrProject>(&ns, &key, TTL_RESOLVE, now).await;
        let stale = match cached {
            Some(c) if c.fresh => return Ok(c.value),
            Some(c) => Some(c.value),
            None => None,
        };
        if !self.inner.online {
            return stale.ok_or(Error::Offline);
        }
        match self.resolve_online(mod_id, &filters).await {
            Ok(found) => {
                self.inner.cache.put(&ns, &key, found.as_ref(), now).await;
                Ok(found)
            }
            Err(e) => stale.ok_or(e),
        }
    }

    async fn resolve_online(&self, mod_id: &str, filters: &Filters) -> Result<Option<MrProject>> {
        // a) slug guesses, one batched request (and the projects cache).
        let guesses = candidates(mod_id);
        let l = self.project_records(guesses.clone(), false).await?;
        if !l.failed.is_empty() {
            return Err(if l.offline {
                Error::Offline
            } else {
                Error::Network(format!("the lookup of mod id {mod_id} failed"))
            });
        }
        for g in &guesses {
            if let Some(rec) = l.found.get(g) {
                if guess_ok(rec, &filters.loaders) {
                    return Ok(Some(rec.project.clone()));
                }
            }
        }

        // b) search, accepting only an unambiguous name match.
        let mut facets = vec![vec!["project_type:mod".to_string()]];
        facets.push(filters.loaders.iter().map(|l| format!("categories:{l}")).collect());
        facets.push(filters.game_versions.iter().map(|v| format!("versions:{v}")).collect());
        let query = mod_id.replace(['_', '-'], " ");
        let want = normalize(mod_id);
        let hits = self.search(&query, &facets, RESOLVE_SEARCH_LIMIT).await?;
        Ok(hits
            .into_iter()
            .find(|p| p.project_type == "mod" && (normalize(&p.slug) == want || normalize(&p.title) == want)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_order() {
        assert_eq!(candidates("cloth_config"), vec!["cloth_config", "cloth-config"]);
        assert_eq!(candidates("architectury"), vec!["architectury-api", "architectury"]);
        assert_eq!(candidates("Fabric"), vec!["fabric-api", "Fabric", "fabric"]);
        assert_eq!(candidates("fabric-resource-loader-v0")[0], "fabric-api");
        assert_eq!(candidates("fabric-api-base")[0], "fabric-api");
        assert_eq!(candidates("fabric-language-kotlin"), vec!["fabric-language-kotlin"]);
    }

    #[test]
    fn normalization() {
        assert_eq!(normalize("Cloth Config"), "clothconfig");
        assert_eq!(normalize("cloth_config"), normalize("cloth-config"));
        assert_ne!(normalize("Cloth Config API"), normalize("cloth_config"));
    }

    #[test]
    fn pseudo_deps() {
        for id in ["minecraft", "java", "fabricloader", "NeoForge", "forge"] {
            assert!(is_pseudo_dependency(id), "{id}");
        }
        assert!(!is_pseudo_dependency("fabric-api"));
    }

    #[test]
    fn facets_validated() {
        assert!(check_facet("categories:fabric").is_ok());
        assert!(check_facet("downloads>100").is_ok());
        assert!(check_facet("fabric").is_err());
        assert!(check_facet("").is_err());
    }
}
