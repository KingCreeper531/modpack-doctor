//! The fix engine (M6, CONTRACTS.md invariants 8 and 14). Safety-critical: it renames, moves and
//! downloads files inside users' Minecraft instances. On any doubt it refuses with a readable
//! error.
//!
//! - [`plan`] turns `FixAction` intents into a stored [`WorkOrder`]: every jar id is resolved
//!   against a fresh stat of `mods/`, every source file is fingerprinted (size + mtime + sha1),
//!   every destination must be absent, and every Modrinth version is re-fetched and re-validated.
//!   Planning never mutates anything.
//! - [`undo`] plans the reverse of a backup snapshot, per action, as a `kind: undo` order. It
//!   checks every file against the manifest's "after" state first.
//! - [`exec`] runs a stored order: game guard → manifest → ops (re-checking each op's
//!   preconditions right before it runs) → rollback of every completed op on the first failure.
//! - [`manifest`] is the on-disk snapshot record: `<backups>/<instanceId>/<ms>/manifest.json`
//!   plus `files/` (moved-out jars) and `created/` (files a fix created, moved out by rollback or
//!   undo). Nothing is ever deleted: "remove" and rollback move files into the snapshot.
//!
//! Orders live only in memory ([`FixState`]), are single-use and expire after
//! [`ORDER_TTL`]. At most one order per instance executes at a time.

pub mod exec;
pub(crate) mod fsops;
pub mod manifest;
pub mod plan;
pub mod remote;
pub mod undo;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::{Error, Result};
use crate::model::WorkOrder;

pub use exec::{execute_order, ExecEnv};
pub use manifest::list_backups;
pub use plan::plan_order;
pub use remote::{ClientRemote, Remote};
pub use undo::plan_undo;

/// How long a planned order may wait for `execute_work_order`.
pub const ORDER_TTL: Duration = Duration::from_secs(15 * 60);

/// What one file must look like when an op runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Expect {
    /// Nothing (not even a dangling link) at that path.
    Absent,
    /// A regular file with exactly this fingerprint.
    File(fsops::Stamp),
}

/// Where a checked path lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Loc {
    /// Relative to the instance's game dir.
    Game,
    /// Relative to the order's snapshot dir.
    Snapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Check {
    pub loc: Loc,
    pub rel: String,
    pub expect: Expect,
}

/// The private half of a planned op: what must hold right before it runs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct OpPlan {
    pub checks: Vec<Check>,
    /// Downloads: the new jar must declare at least one of these mod ids (incl. `provides`).
    pub expect_mod_ids: Vec<String>,
}

/// An undo order's link to the backup it reverses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UndoOf {
    /// `order.actions[i]` is the original order's action `original_actions[i]`.
    pub original_actions: Vec<u32>,
}

/// A planned order with its private preconditions.
#[derive(Debug, Clone)]
pub(crate) struct StoredOrder {
    pub order: WorkOrder,
    /// Parallel to `order.ops`.
    pub plans: Vec<OpPlan>,
    pub game_dir: PathBuf,
    pub snapshot_dir: PathBuf,
    pub backup_id: String,
    pub created_ms: u64,
    pub undo: Option<UndoOf>,
    pub expires: Instant,
}

#[derive(Debug)]
struct FixInner {
    orders: Mutex<HashMap<String, StoredOrder>>,
    executing: Mutex<HashSet<String>>,
    backups_root: Mutex<Option<PathBuf>>,
    last_ms: Mutex<u64>,
    ttl: Mutex<Duration>,
}

/// Work orders in memory, the per-instance execution lock, and the backups root
/// (`<app data>/backups`, set at startup). Cheap to clone.
#[derive(Debug, Clone)]
pub struct FixState {
    inner: Arc<FixInner>,
}

impl Default for FixState {
    fn default() -> Self {
        FixState {
            inner: Arc::new(FixInner {
                orders: Mutex::new(HashMap::new()),
                executing: Mutex::new(HashSet::new()),
                backups_root: Mutex::new(None),
                last_ms: Mutex::new(0),
                ttl: Mutex::new(ORDER_TTL),
            }),
        }
    }
}

/// Held while an order executes; frees the instance on drop (also on error or panic).
#[derive(Debug)]
pub struct ExecTicket {
    inner: Arc<FixInner>,
    instance_id: String,
}

impl Drop for ExecTicket {
    fn drop(&mut self) {
        lock(&self.inner.executing).remove(&self.instance_id);
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub(crate) fn expired_error() -> Error {
    Error::NotFound {
        path: "this work order: it expired or was already used — review the fixes again".into(),
    }
}

impl FixState {
    /// `<app data>/backups` (need not exist yet; created on the first execution).
    pub fn set_backups_root(&self, root: PathBuf) {
        *lock(&self.inner.backups_root) = Some(root);
    }

    pub fn backups_root(&self) -> Result<PathBuf> {
        lock(&self.inner.backups_root).clone().ok_or_else(|| {
            Error::Internal("the backup folder is unavailable because the app data folder could not be resolved".into())
        })
    }

    /// Tests: shorten the order lifetime.
    #[cfg(test)]
    pub(crate) fn set_ttl(&self, ttl: Duration) {
        *lock(&self.inner.ttl) = ttl;
    }

    pub(crate) fn ttl(&self) -> Duration {
        *lock(&self.inner.ttl)
    }

    /// A snapshot timestamp unique within this process (strictly increasing).
    pub(crate) fn next_ms(&self) -> u64 {
        let mut last = lock(&self.inner.last_ms);
        let ms = fsops::now_ms().max(*last + 1);
        *last = ms;
        ms
    }

    pub(crate) fn store(&self, stored: StoredOrder) {
        let mut orders = lock(&self.inner.orders);
        let now = Instant::now();
        orders.retain(|_, o| o.expires > now);
        orders.insert(stored.order.id.clone(), stored);
    }

    /// The instance a live order belongs to (expired orders are dropped and reported).
    pub(crate) fn peek_instance(&self, order_id: &str) -> Result<String> {
        let mut orders = lock(&self.inner.orders);
        match orders.get(order_id) {
            Some(o) if o.expires > Instant::now() => Ok(o.order.instance_id.clone()),
            Some(_) => {
                orders.remove(order_id);
                Err(expired_error())
            }
            None => Err(expired_error()),
        }
    }

    /// Remove and return a live order (single use).
    pub(crate) fn take(&self, order_id: &str) -> Result<StoredOrder> {
        let o = lock(&self.inner.orders).remove(order_id).ok_or_else(expired_error)?;
        if o.expires <= Instant::now() {
            return Err(expired_error());
        }
        Ok(o)
    }

    /// Drop an order; unknown ids are ignored.
    pub fn discard(&self, order_id: &str) {
        lock(&self.inner.orders).remove(order_id);
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, order_id: &str) -> bool {
        lock(&self.inner.orders).contains_key(order_id)
    }

    /// Claim the instance for one executing order, or a Conflict naming it (`label`).
    pub fn claim(&self, instance_id: &str, label: &str) -> Result<ExecTicket> {
        let mut ex = lock(&self.inner.executing);
        if !ex.insert(instance_id.to_string()) {
            return Err(Error::Conflict(format!(
                "Fixes for \"{label}\" are already being applied. Wait for them to finish, then try again."
            )));
        }
        Ok(ExecTicket { inner: Arc::clone(&self.inner), instance_id: instance_id.to_string() })
    }

    pub fn is_executing(&self, instance_id: &str) -> bool {
        lock(&self.inner.executing).contains(instance_id)
    }
}

/// `^[0-9a-f]{16}$`.
pub(crate) fn is_instance_id(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Order ids are 32 lower-case hex characters.
pub(crate) fn is_order_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `<backups root>/<instanceId>/<ms>`.
pub(crate) fn snapshot_dir(root: &Path, instance_id: &str, ms: u64) -> PathBuf {
    root.join(instance_id).join(ms.to_string())
}
