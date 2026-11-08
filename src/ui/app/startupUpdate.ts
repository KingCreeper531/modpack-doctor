/**
 * The opt-in startup update check (CONTRACTS invariant 18, `Settings.autoCheckUpdates`).
 *
 * - Off by default. When on, the store runs its own `checkUpdate` (the same action, and the same
 *   `check_update` command, as About → "Check for updates") once per app start,
 *   `STARTUP_UPDATE_DELAY_MS` after the first screen is ready, so startup never waits on GitHub.
 * - It only reports. A newer release shows as a quiet notice in the rail footer
 *   (`UpdateNotice`), which opens About; nothing is downloaded or installed until the user presses
 *   Install there. A failed check stays silent: no toast, no banner. About shows the error the
 *   next time it is opened, as after a click.
 * - Skipped when the setting was turned off meanwhile, or the user already checked (or is
 *   checking). While a work order executes it waits until the order has finished, and it never
 *   touches the install state (`checkUpdate` itself refuses while an install is under way).
 * - Where it may run at all (`startupCheckAllowed`): under Tauri; in the browser dev build only
 *   when the mock scenario asks for it (`?scenario=autoupdate` / `autoupdatefail`); never
 *   without a backend.
 */
import type { StoreApi } from 'zustand/vanilla';

import type { Backend } from './ipc';
import type { AppState } from './store';

/** "A few seconds after launch". */
export const STARTUP_UPDATE_DELAY_MS = 5000;

/** Under Tauri; the browser mock only when its scenario asks (`MockBackend.startupUpdateCheck`). */
export function startupCheckAllowed(backend: Backend): boolean {
  if (backend.kind === 'tauri') return true;
  if (backend.kind === 'mock') return 'startupUpdateCheck' in backend && backend.startupUpdateCheck === true;
  return false;
}

type Host = Pick<StoreApi<Pick<AppState, 'settings' | 'update' | 'order' | 'checkUpdate'>>, 'getState' | 'subscribe'>;

/**
 * Schedule the one startup check, if the stored settings ask for it. Call once, after the
 * settings have loaded (the store's `init` runs once per app start).
 */
export function scheduleStartupUpdateCheck(
  store: Host,
  setTimer: (cb: () => void, ms: number) => void,
  delayMs: number = STARTUP_UPDATE_DELAY_MS,
): void {
  if (!store.getState().settings.autoCheckUpdates) return;
  setTimer(() => {
    const run = () => {
      const s = store.getState();
      // Turned off since start, or the user checked already: nothing more to ask.
      if (!s.settings.autoCheckUpdates || s.update.status !== 'idle') return;
      void s.checkUpdate();
    };
    const orderRunning = () => store.getState().order?.phase === 'running';
    if (!orderRunning()) {
      run();
      return;
    }
    // Never during a fix: wait for the order to finish, then check once.
    const off = store.subscribe(() => {
      if (orderRunning()) return;
      off();
      run();
    });
  }, delayMs);
}
