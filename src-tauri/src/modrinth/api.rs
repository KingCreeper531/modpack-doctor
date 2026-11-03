//! Wire shapes of the Modrinth v2 API (only the fields we read) and their mapping onto the
//! frozen model types. Responses are untrusted: everything is optional/defaulted, each element
//! of a batch is parsed on its own, and file URLs outside the CDN are dropped.

use reqwest::Url;
use serde::Deserialize;

use crate::model::{MrDependency, MrFile, MrProject, MrVersion, SideSupport};

/// Which download/icon URLs are acceptable: `https://<cdn_host>/…` only.
#[derive(Debug, Clone)]
pub(crate) struct CdnCheck {
    /// Lower-cased `host` or `host:port`.
    pub host: String,
    /// Tests only: also accept `http://` (wiremock has no TLS).
    pub allow_http: bool,
}

impl CdnCheck {
    pub fn parse(&self, url: &str) -> Option<Url> {
        let u = Url::parse(url).ok()?;
        let scheme_ok = u.scheme() == "https" || (self.allow_http && u.scheme() == "http");
        if !scheme_ok || !u.username().is_empty() || u.password().is_some() {
            return None;
        }
        let host = u.host_str()?.to_ascii_lowercase();
        let authority = match u.port() {
            Some(p) => format!("{host}:{p}"),
            None => host,
        };
        (authority == self.host).then_some(u)
    }

    pub fn allows(&self, url: &str) -> bool {
        self.parse(url).is_some()
    }
}

#[derive(Debug, Default, Deserialize)]
struct ApiHashes {
    #[serde(default)]
    sha1: Option<String>,
    #[serde(default)]
    sha512: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiFile {
    #[serde(default)]
    hashes: ApiHashes,
    url: String,
    filename: String,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    file_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiDependency {
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    file_name: Option<String>,
    dependency_type: String,
}

#[derive(Debug, Deserialize)]
struct ApiVersion {
    id: String,
    project_id: String,
    #[serde(default)]
    name: Option<String>,
    version_number: String,
    #[serde(default)]
    game_versions: Option<Vec<String>>,
    #[serde(default)]
    loaders: Option<Vec<String>>,
    version_type: String,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    files: Option<Vec<ApiFile>>,
    #[serde(default)]
    dependencies: Option<Vec<ApiDependency>>,
}

#[derive(Debug, Deserialize)]
struct ApiProject {
    id: String,
    slug: String,
    title: String,
    project_type: String,
    #[serde(default)]
    environment: Option<Vec<String>>,
    #[serde(default)]
    client_side: Option<String>,
    #[serde(default)]
    server_side: Option<String>,
    #[serde(default)]
    icon_url: Option<String>,
}

fn is_hex_len(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Parse one Version object. `None` when it is malformed.
pub(crate) fn version_from_json(v: serde_json::Value, cdn: &CdnCheck) -> Option<MrVersion> {
    let v: ApiVersion = serde_json::from_value(v).ok()?;
    let files = v
        .files
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| {
            if !cdn.allows(&f.url) {
                return None;
            }
            let sha1 = f.hashes.sha1?.to_ascii_lowercase();
            let sha512 = f.hashes.sha512?.to_ascii_lowercase();
            if !is_hex_len(&sha1, 40) || !is_hex_len(&sha512, 128) {
                return None;
            }
            Some(MrFile {
                url: f.url,
                filename: f.filename,
                size: f.size,
                primary: f.primary,
                sha1,
                sha512,
                file_type: f.file_type,
            })
        })
        .collect();
    let dependencies = v
        .dependencies
        .unwrap_or_default()
        .into_iter()
        .map(|d| MrDependency {
            version_id: d.version_id,
            project_id: d.project_id,
            file_name: d.file_name,
            dependency_type: d.dependency_type,
        })
        .collect();
    Some(MrVersion {
        name: v.name.unwrap_or_else(|| v.version_number.clone()),
        id: v.id,
        project_id: v.project_id,
        version_number: v.version_number,
        game_versions: v.game_versions.unwrap_or_default(),
        loaders: v.loaders.unwrap_or_default(),
        version_type: v.version_type,
        environment: v.environment,
        files,
        dependencies,
    })
}

fn side(s: Option<&str>) -> SideSupport {
    match s {
        Some("required") => SideSupport::Required,
        Some("optional") => SideSupport::Optional,
        Some("unsupported") => SideSupport::Unsupported,
        _ => SideSupport::Unknown,
    }
}

/// A parsed project plus its CDN icon URL (kept out of `MrProject`, which carries a local path).
#[derive(Debug, Clone, PartialEq, serde::Serialize, Deserialize)]
pub(crate) struct ProjectRecord {
    pub project: MrProject,
    pub icon_url: Option<String>,
}

pub(crate) fn project_from_json(v: serde_json::Value, cdn: &CdnCheck) -> Option<ProjectRecord> {
    let p: ApiProject = serde_json::from_value(v).ok()?;
    let icon_url = p.icon_url.filter(|u| cdn.allows(u));
    Some(ProjectRecord {
        project: MrProject {
            client_side: side(p.client_side.as_deref()),
            server_side: side(p.server_side.as_deref()),
            id: p.id,
            slug: p.slug,
            title: p.title,
            project_type: p.project_type,
            environment: p.environment.unwrap_or_default(),
            icon_path: None,
        },
        icon_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cdn() -> CdnCheck {
        CdnCheck { host: "cdn.modrinth.com".into(), allow_http: false }
    }

    #[test]
    fn cdn_check() {
        let c = cdn();
        assert!(c.allows("https://cdn.modrinth.com/data/AANobbMI/versions/x/a.jar"));
        assert!(c.allows("https://CDN.modrinth.com/data/a.jar"));
        assert!(!c.allows("http://cdn.modrinth.com/data/a.jar"));
        assert!(!c.allows("https://cdn.modrinth.com.evil.com/a.jar"));
        assert!(!c.allows("https://user@cdn.modrinth.com/a.jar"));
        assert!(!c.allows("https://cdn.modrinth.com:8443/a.jar"));
        assert!(!c.allows("https://github.com/a.jar"));
        assert!(!c.allows("not a url"));
    }

    #[test]
    fn maps_version_and_drops_foreign_files() {
        let v = json!({
            "id": "OihdIimA", "project_id": "AANobbMI", "name": "Sodium 0.5.13",
            "version_number": "0.5.13", "game_versions": ["1.20.1"], "loaders": ["fabric"],
            "version_type": "release", "environment": "client_only", "changelog": null,
            "files": [
                {"hashes": {"sha1": "A".repeat(40), "sha512": "b".repeat(128)},
                 "url": "https://cdn.modrinth.com/data/AANobbMI/versions/OihdIimA/s.jar",
                 "filename": "s.jar", "primary": true, "size": 10, "file_type": null},
                {"hashes": {"sha1": "c".repeat(40), "sha512": "d".repeat(128)},
                 "url": "https://evil.example/s.jar", "filename": "s2.jar", "primary": false, "size": 1},
                {"hashes": {"sha1": "e".repeat(40)},
                 "url": "https://cdn.modrinth.com/data/x/no-sha512.jar", "filename": "n.jar", "size": 1}
            ],
            "dependencies": [{"version_id": null, "project_id": "VOYxIjFI", "file_name": null,
                              "dependency_type": "incompatible"}]
        });
        let m = version_from_json(v, &cdn()).unwrap();
        assert_eq!(m.files.len(), 1);
        assert_eq!(m.files[0].sha1, "a".repeat(40));
        assert_eq!(m.environment.as_deref(), Some("client_only"));
        assert_eq!(m.dependencies[0].dependency_type, "incompatible");
    }

    #[test]
    fn maps_project_sides() {
        let p = json!({"id": "AANobbMI", "slug": "sodium", "title": "Sodium", "project_type": "mod",
            "client_side": "required", "server_side": "unsupported", "environment": ["client_only"],
            "icon_url": "https://cdn.modrinth.com/data/AANobbMI/icon_96.webp"});
        let r = project_from_json(p, &cdn()).unwrap();
        assert_eq!(r.project.client_side, SideSupport::Required);
        assert_eq!(r.project.server_side, SideSupport::Unsupported);
        assert_eq!(r.project.environment, vec!["client_only".to_string()]);
        assert!(r.icon_url.is_some());
        let p = json!({"id": "x", "slug": "y", "title": "t", "project_type": "mod", "client_side": "weird",
            "icon_url": "https://elsewhere.example/i.png"});
        let r = project_from_json(p, &cdn()).unwrap();
        assert_eq!(r.project.client_side, SideSupport::Unknown);
        assert_eq!(r.project.server_side, SideSupport::Unknown);
        assert_eq!(r.icon_url, None);
    }
}
