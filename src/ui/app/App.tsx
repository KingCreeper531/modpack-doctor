/**
 * App root: creates the backend (real Tauri or the browser mock, ipc.ts) and the store once,
 * follows the theme preference from settings (DESIGN.md §9), and renders the shell.
 */
import { useEffect, useState } from 'react';

import { Shell } from '../screens/Shell';
import { createBackend } from './ipc';
import { createAppStore, type AppStore } from './store';
import { StoreProvider, useApp, useAppStore } from './StoreContext';
import { followTheme } from './theme';

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

export interface AppProps {
  /** Injected in tests; otherwise created from the environment. */
  store?: AppStore;
}

export function App({ store: injected }: AppProps) {
  const [store] = useState(() => injected ?? createAppStore({ backend: createBackend() }));
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
