//! Process-wide state managed by Tauri. Owned by the integrator; agents propose additions.

use crate::guard::PathGuard;

#[derive(Debug, Default)]
pub struct AppState {
    pub guard: PathGuard,
}
