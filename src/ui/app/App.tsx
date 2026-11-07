/**
 * App root: creates the backend (real Tauri or the browser mock, ipc.ts) and the store once,
 * follows the theme preference from settings (DESIGN.md §9), and renders the shell.
 */
import { useEffect, useState } from 'react';

import { Shell } from '../screens/Shell';
import { applyDevHooks } from './devHooks';
import { createBackend } from './ipc';
import { browserNotifier, deniedNotifier, tauriNotifier } from './notify';
import { createAppStore, type AppStore } from './store';
import { StoreProvider, useApp, useAppStore } from './StoreContext';
import { followTheme } from './theme';
import { version } from '../../../package.json';

function ThemeSync() {
  const pref = useApp((s) => s.settings.theme);
  const store = useAppStore();
  useEffect(
    () =>
      followTheme(pref, {
        media: window.matchMedia('(prefers-color-scheme: dark)'),
        apply: (theme) => document.documentElement.setAttribute('data-theme', theme),
        setWindowTheme: (theme) => store.getState().setWindowTheme(theme),
      }),
    [pref, store],
  );
  return null;
}

/**
 * Tauri backend inside the app; in a browser the mock, with `?select=` honoured for screenshots.
 * Crash notifications: the Tauri plugin in the app, the Web Notification API in the browser
 * preview, none without a backend.
 */
function createDefaultStore(): AppStore {
  const backend = createBackend();
  const initialSelect = backend.kind === 'mock' ? new URLSearchParams(window.location.search).get('select') : null;
  const notifier = backend.kind === 'tauri' ? tauriNotifier() : backend.kind === 'mock' ? browserNotifier() : deniedNotifier();
  const store = createAppStore({ backend, initialSelect, notifier, appVersion: version });
  // `?order=` / `?tab=` screenshot hooks (devHooks.ts); dead code, and dropped, in production.
  if (import.meta.env.DEV && backend.kind === 'mock') applyDevHooks(store, window.location.search);
  return store;
}

export interface AppProps {
  /** Injected in tests; otherwise created from the environment. */
  store?: AppStore;
}

export function App({ store: injected }: AppProps) {
  const [store] = useState(() => injected ?? createDefaultStore());
  // `init` is idempotent, so StrictMode's double effect is harmless. Listeners live as long as
  // the app does; tests call `dispose()` themselves.
  useEffect(() => {
    void store.getState().init();
  }, [store]);
  return (
    <StoreProvider store={store}>
      <ThemeSync />
      <Shell />
    </StoreProvider>
  );
}
