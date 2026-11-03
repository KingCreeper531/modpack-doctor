//! Modrinth App (current `ModrinthApp`, legacy `com.modrinth.theseus`). launchers.md §1.
//!
//! `app.db` is opened strictly read-only (never `immutable=1`, which would ignore the WAL),
//! with a busy timeout and a bounded retry on `SQLITE_BUSY`. Nothing is ever written.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, OptionalExtension};

use crate::model::{Launcher, ProbeResult, Side};

use super::common::{
    build, dir_state, display, is_dir, is_file, json_get, json_str, list_subdirs, loader_from_name, name_of, non_empty,
    read_json, DirState, Meta, NewInstance, Outcome,
};
use super::env::{Env, Os};

#[derive(Debug, Clone)]
pub struct DbOptions {
    pub busy_timeout: Duration,
    /// Retries after the first `SQLITE_BUSY` (so `retries + 1` attempts in total).
    pub retries: u32,
    pub retry_delay: Duration,
}

impl Default for DbOptions {
    fn default() -> Self {
        DbOptions { busy_timeout: Duration::from_secs(2), retries: 3, retry_delay: Duration::from_millis(150) }
    }
}

/// Settings dirs to probe, most specific first.
pub(crate) fn candidates(env: &Env) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = env.var_path("THESEUS_CONFIG_DIR") {
        v.push(p);
    }
    v.push(env.data_dir().join("ModrinthApp"));
    if env.os == Os::Linux {
        v.push(env.home.join(".var").join("app").join("com.modrinth.ModrinthApp").join("data").join("ModrinthApp"));
    }
    v.push(env.config_dir().join("com.modrinth.theseus"));
    v
}

/// A user-chosen Modrinth folder: the settings dir, the custom data dir, or `profiles/` itself.
pub(crate) fn probe_user_root(env: &Env, root: &Path, opts: &DbOptions) -> Outcome {
    let is_profiles_dir = root.file_name().is_some_and(|n| n.eq_ignore_ascii_case("profiles"))
        && !is_dir(&root.join("profiles"))
        && !is_file(&root.join("app.db"));
    match root.parent() {
        Some(parent) if is_profiles_dir => probe(env, parent, opts),
        _ => probe(env, root, opts),
    }
}

#[derive(Debug, Clone)]
struct DbRow {
    path: String,
    name: Option<String>,
    game_version: Option<String>,
    loader: Option<String>,
    loader_version: Option<String>,
}

impl DbRow {
    fn meta(&self) -> Meta {
        let loader = self.loader.as_deref().and_then(|l| loader_from_name(l, self.loader_version.clone()));
        if self.game_version.is_none() && loader.is_none() {
            return Meta::inferred();
        }
        Meta::launcher(self.game_version.clone(), loader)
    }
}

#[derive(Debug, Default)]
struct DbData {
    custom_dir: Option<String>,
    /// `None` = no known schema.
    rows: Option<Vec<DbRow>>,
}

enum DbFailure {
    Busy { retries: u32 },
    Other(String),
}

const SQL_INSTANCES: &str = "SELECT i.path, i.name, cs.game_version, cs.loader, cs.loader_version \
     FROM instances i LEFT JOIN instance_content_sets cs ON cs.id = i.applied_content_set_id";
const SQL_PROFILES: &str = "SELECT path, name, game_version, mod_loader, mod_loader_version FROM profiles";

fn text(row: &rusqlite::Row<'_>, idx: usize) -> Option<String> {
    match row.get_ref(idx).ok()? {
        ValueRef::Text(t) | ValueRef::Blob(t) => std::str::from_utf8(t).ok().and_then(non_empty),
        ValueRef::Integer(i) => Some(i.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        ValueRef::Null => None,
    }
}

fn table_names(conn: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
    let names = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;
    Ok(names)
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<HashSet<String>> {
    // `table` is one of our constants, never user input.
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let cols = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<HashSet<_>>>()?;
    Ok(cols)
}

fn has_all(set: &HashSet<String>, want: &[&str]) -> bool {
    want.iter().all(|w| set.contains(*w))
}

fn read_db_once(path: &Path, timeout: Duration) -> rusqlite::Result<DbData> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags)?;
    conn.busy_timeout(timeout)?;
    let tables = table_names(&conn)?;
    let mut data = DbData::default();

    if tables.contains("settings") && columns(&conn, "settings")?.contains("custom_dir") {
        data.custom_dir =
            conn.query_row("SELECT custom_dir FROM settings LIMIT 1", [], |r| Ok(text(r, 0))).optional()?.flatten();
    }

    let gen_b = tables.contains("instances")
        && tables.contains("instance_content_sets")
        && has_all(&columns(&conn, "instances")?, &["path", "name", "applied_content_set_id"])
        && has_all(&columns(&conn, "instance_content_sets")?, &["id", "game_version", "loader", "loader_version"]);
    let gen_a = !gen_b
        && tables.contains("profiles")
        && has_all(&columns(&conn, "profiles")?, &["path", "name", "game_version", "mod_loader", "mod_loader_version"]);
    let sql = if gen_b {
        SQL_INSTANCES
    } else if gen_a {
        SQL_PROFILES
    } else {
        return Ok(data);
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DbRow {
                path: text(r, 0).unwrap_or_default(),
                name: text(r, 1),
                game_version: text(r, 2),
                loader: text(r, 3),
                loader_version: text(r, 4),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    data.rows = Some(rows.into_iter().filter(|r| !r.path.is_empty()).collect());
    Ok(data)
}

fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(f, _)
            if matches!(f.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

fn read_db(path: &Path, opts: &DbOptions) -> Result<DbData, DbFailure> {
    let mut retries = 0;
    loop {
        match read_db_once(path, opts.busy_timeout) {
            Ok(d) => return Ok(d),
            Err(e) if is_busy(&e) => {
                if retries >= opts.retries {
                    return Err(DbFailure::Busy { retries });
                }
                retries += 1;
                std::thread::sleep(opts.retry_delay);
            }
            Err(e) => return Err(DbFailure::Other(e.to_string())),
        }
    }
}

fn find_row<'a>(rows: &'a [DbRow], folder: &str, os: Os) -> Option<&'a DbRow> {
    rows.iter()
        .find(|r| r.path == folder)
        .or_else(|| if os.case_insensitive() { rows.iter().find(|r| r.path.to_lowercase() == folder.to_lowercase()) } else { None })
}

/// Pre-SQLite theseus: `profiles/<name>/profile.json`.
fn legacy_meta(profile_dir: &Path, folder: &str, out: &mut Outcome) -> (String, Meta) {
    match read_json(&profile_dir.join("profile.json")) {
        Ok(Some(v)) => {
            let md = json_get(&v, "metadata").unwrap_or(&v);
            let name = json_str(md, "name").unwrap_or_else(|| folder.to_string());
            let mc = json_str(md, "game_version");
            let loader_version = json_get(md, "loader_version").and_then(|lv| match lv {
                serde_json::Value::String(s) => non_empty(s),
                other => json_str(other, "id"),
            });
            let loader = json_str(md, "loader").and_then(|l| loader_from_name(&l, loader_version));
            let meta = if mc.is_none() && loader.is_none() { Meta::inferred() } else { Meta::launcher(mc, loader) };
            (name, meta)
        }
        Ok(None) => (folder.to_string(), Meta::inferred()),
        Err(m) => {
            out.note(format!("{folder}: {m} — using jar metadata"));
            (folder.to_string(), Meta::inferred())
        }
    }
}

/// Probe one Modrinth settings dir (holds `app.db`; or a legacy theseus config dir).
pub(crate) fn probe(env: &Env, dir: &Path, opts: &DbOptions) -> Outcome {
    let launcher = Launcher::Modrinth;
    if let Some(o) = Outcome::from_dir_state(launcher, dir) {
        return o;
    }
    let mut out = Outcome::new(launcher, dir, ProbeResult::NotInstalled);
    let mut rows: Option<Vec<DbRow>> = None;
    let mut config_dir = dir.to_path_buf();
    let mut custom_dir: Option<String> = None;
    let db_path = dir.join("app.db");
    let legacy = !is_file(&db_path);

    if legacy {
        match read_json(&dir.join("settings.json")) {
            Ok(Some(v)) => custom_dir = json_str(&v, "loaded_config_dir"),
            Ok(None) => {}
            Err(m) => out.note(m),
        }
    } else {
        match read_db(&db_path, opts) {
            Ok(data) => {
                custom_dir = data.custom_dir;
                match data.rows {
                    Some(r) => rows = Some(r),
                    None => out.note("app.db schema not recognised — using jar metadata"),
                }
            }
            Err(DbFailure::Busy { retries }) => out.note(format!(
                "database busy — retried {retries}×; listing profile folders without launcher metadata \
                 (a custom data folder, if set, could not be read)"
            )),
            Err(DbFailure::Other(m)) => out.note(format!("app.db could not be read ({m}) — using jar metadata")),
        }
    }

    if let Some(cd) = custom_dir {
        let p = PathBuf::from(&cd);
        if p.is_absolute() && is_dir(&p) {
            out.note(format!("profiles are in the custom data folder {}", display(&p)));
            config_dir = p;
        } else {
            out.note(format!("custom data folder {cd} does not exist — looking in {}", display(dir)));
        }
    }

    let profiles = config_dir.join("profiles");
    match dir_state(&profiles) {
        DirState::Dir => {}
        DirState::Denied => {
            out.probe.result = ProbeResult::PermissionDenied;
            return out;
        }
        DirState::Missing | DirState::NotDir => return out.finish(),
        DirState::Failed(m) => {
            out.probe.result = ProbeResult::Error { message: m };
            return out;
        }
    }
    let subdirs = match list_subdirs(&profiles) {
        Ok(s) => s,
        Err(e) => {
            let notes = std::mem::take(&mut out.probe.notes);
            let mut o = Outcome::from_io(launcher, dir, &e);
            o.probe.notes = notes;
            return o;
        }
    };

    let mut unmatched = 0usize;
    for (name, path) in subdirs {
        let folder = name_of(&name);
        let (display_name, meta) = if let Some(rows) = &rows {
            match find_row(rows, &folder, env.os) {
                Some(r) => (r.name.clone().unwrap_or_else(|| folder.clone()), r.meta()),
                None => {
                    unmatched += 1;
                    (folder.clone(), Meta::inferred())
                }
            }
        } else if legacy {
            legacy_meta(&path, &folder, &mut out)
        } else {
            (folder.clone(), Meta::inferred())
        };
        out.instances.push(build(
            env.os,
            NewInstance { launcher, name: display_name, root: &path, game_dir: &path, meta, side: Side::Client },
        ));
    }

    // Uncertain (launchers.md): `instances.path` is believed always relative; honour an
    // absolute one if it ever appears.
    if let Some(rows) = &rows {
        for r in rows {
            let p = PathBuf::from(&r.path);
            if p.is_absolute() && is_dir(&p) && !p.starts_with(&profiles) {
                let name = r.name.clone().unwrap_or_else(|| r.path.clone());
                out.instances.push(build(
                    env.os,
                    NewInstance { launcher, name, root: &p, game_dir: &p, meta: r.meta(), side: Side::Client },
                ));
            }
        }
    }
    if unmatched > 0 {
        out.note(format!("{unmatched} profile folder(s) are not in app.db — using jar metadata for them"));
    }
    out.finish()
}
