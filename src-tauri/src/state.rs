//! Process-wide state managed by Tauri. Owned by the integrator; agents propose additions.
//!
//! Every field is an `Arc`, so a command clones the `AppState` (cheap) and moves the clone
//! into `spawn_blocking` work.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use crate::discovery::Discovered;
use crate::error::{Error, Result};
use crate::guard::PathGuard;
use crate::logs::watch::Watchers;
use crate::model::{DiscoveryReport, Instance, Launcher};
use crate::modrinth::ModrinthService;
use crate::process::Processes;
use crate::scan::ScanCache;
use crate::settings::SettingsService;

#[derive(Clone, Default)]
pub struct AppState {
    pub guard: Arc<PathGuard>,
    pub settings: Arc<SettingsService>,
    /// Instances from the last discovery.
    pub registry: Arc<RwLock<Registry>>,
    /// Shared across rescans of every instance (keyed by absolute jar path).
    pub scan_cache: Arc<ScanCache>,
    /// Instances currently being scanned.
    pub scans: InFlight,
    /// Scope changes (discovery, pickers, removals) take it for writing, so registry updates and
    /// PathGuard roots are applied in order; scans take it for reading, so roots can't be
    /// unregistered mid-scan while different instances still scan in parallel.
    pub scope_lock: Arc<tokio::sync::RwLock<()>>,
    /// Roots that are never unregistered by discovery (the app data dir).
    pub pinned_roots: Arc<RwLock<Vec<PathBuf>>>,
    /// Java-process detection shared by watch mode and the running-game guard.
    pub processes: Processes,
    /// Live crash watchers by instance id (started only by `set_watch`).
    pub watchers: Arc<Watchers>,
    /// The shared Modrinth clients (set by `init`; `None` if the cache dirs could not be resolved).
    pub modrinth: Option<ModrinthService>,
    /// Planned work orders, the per-instance execution lock and the backups root (M6).
    pub fixes: crate::fix::FixState,
    /// `.mrpack` files opened this session (CONTRACTS invariant 15), in opening order. Never
    /// persisted; merged into the registry by every discovery so they survive rediscovery.
    pub opened_packs: Arc<RwLock<Vec<Instance>>>,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState").field("guard", &self.guard).field("settings", &self.settings).finish_non_exhaustive()
    }
}

impl AppState {
    pub fn new(settings: SettingsService) -> Self {
        Self { settings: Arc::new(settings), ..Self::default() }
    }

    /// Register a root that discovery must never remove (app data dir).
    pub fn pin_root(&self, root: &Path) -> Result<PathBuf> {
        let canon = self.guard.add_root(root)?;
        let mut pinned = self.pinned_roots.write().map_err(|_| poisoned("pinned roots"))?;
        if !pinned.contains(&canon) {
            pinned.push(canon.clone());
        }
        Ok(canon)
    }

    pub fn pinned(&self) -> Vec<PathBuf> {
        self.pinned_roots.read().map(|p| p.clone()).unwrap_or_default()
    }

    /// The registered instance with `id`, or a readable NotFound.
    pub fn instance(&self, id: &str) -> Result<RegisteredInstance> {
        let reg = self.registry.read().map_err(|_| poisoned("instance registry"))?;
        reg.get(id).cloned().ok_or_else(|| unknown_instance(id))
    }

    pub fn known_ids(&self) -> HashSet<String> {
        self.registry.read().map(|r| r.ids()).unwrap_or_default()
    }

    /// Replace the registry with a discovery result and sync the PathGuard (see
    /// [`apply_discovery`]). Returns the report.
    /// Blocking (probes each instance's `mods/`, `logs/`, `crash-reports/` links).
    pub fn apply_discovery(&self, discovered: Discovered) -> Result<DiscoveryReport> {
        let mut discovered = discovered;
        // Probe outside the lock; only the swap happens under it.
        let mut next = Registry::from_discovered(&discovered, crate::discovery::guard_roots);
        // Opened packs are session-only and not found by discovery: keep them (and report them).
        for pack in self.opened_packs() {
            if next.insert_session(pack.clone(), false) {
                discovered.report.instances.push(pack);
            }
        }
        let pinned = self.pinned();
        let mut reg = self.registry.write().map_err(|_| poisoned("instance registry"))?;
        apply_registry(&self.guard, &mut reg, next, &pinned);
        // An instance that is no longer discovered can't be watched: its roots are gone.
        let known = reg.ids();
        drop(reg);
        for id in self.watchers.ids() {
            if !known.contains(&id) {
                self.watchers.stop(&id);
            }
        }
        Ok(discovered.report)
    }

    /// The `.mrpack`s opened this session, in opening order.
    pub fn opened_packs(&self) -> Vec<Instance> {
        self.opened_packs.read().map(|p| p.clone()).unwrap_or_default()
    }

    /// Register an opened `.mrpack` (session only): remembered for rediscovery, put in the
    /// registry (no PathGuard root) and given the read-only exact-file rule. Opening the same
    /// pack again refreshes its entry. Callers hold `scope_lock` for writing.
    pub fn add_opened_pack(&self, pack: Instance) -> Result<()> {
        let mut packs = self.opened_packs.write().map_err(|_| poisoned("opened packs"))?;
        match packs.iter_mut().find(|p| p.id == pack.id) {
            Some(p) => *p = pack.clone(),
            None => packs.push(pack.clone()),
        }
        let mut reg = self.registry.write().map_err(|_| poisoned("instance registry"))?;
        reg.insert_session(pack, true);
        self.guard.set_read_only_files(&reg.pack_files());
        Ok(())
    }

    /// Forget an opened `.mrpack`: registry entry, read-only rule and session list. NotFound if
    /// `id` is not an opened pack. Callers hold `scope_lock` for writing.
    pub fn remove_opened_pack(&self, id: &str) -> Result<()> {
        let mut packs = self.opened_packs.write().map_err(|_| poisoned("opened packs"))?;
        let before = packs.len();
        packs.retain(|p| p.id != id);
        if packs.len() == before {
            return Err(unknown_instance(id));
        }
        let mut reg = self.registry.write().map_err(|_| poisoned("instance registry"))?;
        reg.remove(id);
        self.guard.set_read_only_files(&reg.pack_files());
        Ok(())
    }
}

/// Build the app state at startup: settings from `<app data>/settings.json` (defaults if that
/// fails) and the app data dir as a pinned PathGuard root. Problems are logged, never fatal.
pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppState {
    use tauri::Manager;

    let settings = match crate::settings::plugin_store::PluginStore::open(app) {
        Ok(store) => {
            let (service, log) = SettingsService::load(Box::new(store));
            for line in log {
                eprintln!("{line}");
            }
            service
        }
        Err(e) => {
            eprintln!("settings: {e} Using defaults; changes will not be saved.");
            SettingsService::default()
        }
    };
    let mut state = AppState::new(settings);
    match ModrinthService::for_app(app) {
        Ok(m) => state.modrinth = Some(m),
        Err(e) => eprintln!("Modrinth features are off: {e}"),
    }
    match app.path().app_data_dir() {
        Ok(dir) => {
            let registered = std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e)).and_then(|()| state.pin_root(&dir));
            if let Err(e) = registered {
                eprintln!("could not register the app data folder: {e}");
            }
            match crate::paths::backups_dir(app) {
                Ok(backups) => state.fixes.set_backups_root(backups),
                Err(e) => eprintln!("fixes are off: {e}"),
            }
        }
        Err(e) => eprintln!("could not resolve the app data folder: {e}"),
    }
    state
}

pub(crate) fn poisoned(what: &str) -> Error {
    Error::Internal(format!("the {what} lock was poisoned"))
}

pub(crate) fn unknown_instance(id: &str) -> Error {
    Error::NotFound { path: format!("the instance with id \"{id}\" (refresh the instance list and try again)") }
}

// ── Registry ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct RegisteredInstance {
    pub instance: Instance,
    pub game_dir: PathBuf,
    /// The PathGuard roots this instance needs (`discovery::guard_roots`).
    pub roots: Vec<PathBuf>,
}

/// Instances from the last discovery (in report order) and the roots they registered.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Registry {
    order: Vec<String>,
    by_id: HashMap<String, RegisteredInstance>,
    /// Union of all roots registered for discovered instances.
    roots: Vec<PathBuf>,
}

impl Registry {
    /// Build from a discovery result. `roots_of(root, game_dir)` gives an instance's guard
    /// roots (in the app: `discovery::guard_roots`).
    pub fn from_discovered(d: &Discovered, roots_of: impl Fn(&Path, &Path) -> Vec<PathBuf>) -> Self {
        let mut reg = Registry { roots: d.roots.clone(), ..Registry::default() };
        for inst in &d.report.instances {
            if reg.by_id.contains_key(&inst.id) {
                continue;
            }
            let game_dir = PathBuf::from(&inst.game_dir);
            let roots = roots_of(Path::new(&inst.root), &game_dir);
            for r in &roots {
                if !reg.roots.contains(r) {
                    reg.roots.push(r.clone());
                }
            }
            reg.order.push(inst.id.clone());
            reg.by_id.insert(inst.id.clone(), RegisteredInstance { instance: inst.clone(), game_dir, roots });
        }
        reg
    }

    /// Add an instance that discovery does not produce (an opened `.mrpack`): no PathGuard
    /// roots, `game_dir` = its `game_dir`. An existing entry with the same id is replaced when
    /// `replace`, else kept. True if the id was not registered before.
    pub fn insert_session(&mut self, inst: Instance, replace: bool) -> bool {
        let fresh = !self.by_id.contains_key(&inst.id);
        if fresh {
            self.order.push(inst.id.clone());
        } else if !replace {
            return false;
        }
        let game_dir = PathBuf::from(&inst.game_dir);
        self.by_id.insert(inst.id.clone(), RegisteredInstance { instance: inst, game_dir, roots: Vec::new() });
        fresh
    }

    /// The files of the registered `.mrpack` instances (their `root`), for the read-only rule.
    pub fn pack_files(&self) -> Vec<PathBuf> {
        self.order
            .iter()
            .filter_map(|id| self.by_id.get(id))
            .filter(|r| r.instance.launcher == Launcher::Mrpack)
            .map(|r| PathBuf::from(&r.instance.root))
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<&RegisteredInstance> {
        self.by_id.get(id)
    }

    pub fn ids(&self) -> HashSet<String> {
        self.by_id.keys().cloned().collect()
    }

    pub fn instances(&self) -> Vec<Instance> {
        self.order.iter().filter_map(|id| self.by_id.get(id)).map(|r| r.instance.clone()).collect()
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// Remove one instance. Returns the roots no remaining instance needs (to unregister).
    pub fn remove(&mut self, id: &str) -> Option<(RegisteredInstance, Vec<PathBuf>)> {
        let gone = self.by_id.remove(id)?;
        self.order.retain(|i| i != id);
        let still: HashSet<&PathBuf> = self.by_id.values().flat_map(|r| r.roots.iter()).collect();
        let orphaned: Vec<PathBuf> = gone.roots.iter().filter(|r| !still.contains(r)).cloned().collect();
        self.roots.retain(|r| !orphaned.contains(r));
        Some((gone, orphaned))
    }
}

/// Root changes going from `old` to `new`: (to add, to remove). Pinned roots are never removed.
pub fn root_changes(old: &[PathBuf], new: &[PathBuf], pinned: &[PathBuf]) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let add = new.iter().filter(|r| !old.contains(r)).cloned().collect();
    let remove = old.iter().filter(|r| !new.contains(r) && !pinned.contains(r)).cloned().collect();
    (add, remove)
}

/// Replace `registry` with `next` and sync `guard`: new roots are added first, then roots no
/// instance needs any more are removed (pinned roots never are), then the read-only hs_err
/// dirs and the read-only pack files are replaced. A root that cannot be added (folder vanished since discovery) is logged
/// and skipped.
pub fn apply_registry(guard: &PathGuard, registry: &mut Registry, next: Registry, pinned: &[PathBuf]) {
    let (add, remove) = root_changes(&registry.roots, &next.roots, pinned);
    for r in &add {
        if let Err(e) = guard.add_root(r) {
            eprintln!("discovery: could not register {}: {e}", r.display());
        }
    }
    for r in &remove {
        guard.remove_root(r);
    }
    *registry = next;
    // Read-only hs_err rule for CurseForge's shared `Install` folder, only while a CurseForge
    // instance is discovered (CONTRACTS invariant 11).
    guard.set_hs_err_dirs(&crate::discovery::curseforge_hs_err_dirs(&registry.instances()));
    // Read-only exact-file rule for the opened `.mrpack`s (CONTRACTS invariant 15).
    guard.set_read_only_files(&registry.pack_files());
}

// ── In-flight scans ──────────────────────────────────────────────────────────

/// Instance ids currently being scanned. A second scan of the same instance is rejected;
/// different instances scan in parallel.
#[derive(Debug, Clone, Default)]
pub struct InFlight {
    ids: Arc<Mutex<HashSet<String>>>,
}

/// Held while a scan runs; releases the instance on drop (also on panic or error).
#[derive(Debug)]
pub struct ScanTicket {
    ids: Arc<Mutex<HashSet<String>>>,
    id: String,
}

impl InFlight {
    /// Claim `id`, or a Conflict error naming the instance (`label`) if it is already scanning.
    pub fn begin(&self, id: &str, label: &str) -> Result<ScanTicket> {
        let mut ids = self.ids.lock().unwrap_or_else(|p| p.into_inner());
        if !ids.insert(id.to_string()) {
            return Err(Error::Conflict(format!(
                "A scan of \"{label}\" is already running. Wait for it to finish, then try again."
            )));
        }
        Ok(ScanTicket { ids: self.ids.clone(), id: id.to_string() })
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.ids.lock().unwrap_or_else(|p| p.into_inner()).contains(id)
    }
}

impl Drop for ScanTicket {
    fn drop(&mut self) {
        self.ids.lock().unwrap_or_else(|p| p.into_inner()).remove(&self.id);
    }
}
