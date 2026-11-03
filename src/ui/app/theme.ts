/**
 * Theme resolution (DESIGN.md §9). The UI always writes a *resolved* theme to `data-theme` and
 * mirrors it to the native title bar via `set_window_theme`, at startup and on every change:
 * the user's preference changing, or the OS theme flipping at runtime while preference = system.
 */
import type { ResolvedTheme, ThemePref } from '../../bindings';

export interface ThemeDeps {
  /** `window.matchMedia('(prefers-color-scheme: dark)')` */
  media: Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  /** Writes `data-theme` on the root element. */
  apply: (theme: ResolvedTheme) => void;
  /** `commands.setWindowTheme` */
  setWindowTheme: (theme: ResolvedTheme) => Promise<unknown>;
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

/**
 * Apply `pref` now and keep following the OS while it is `system`.
 * Returns an unsubscribe function; call it before switching preference.
 */
export function followTheme(pref: ThemePref, deps: ThemeDeps): () => void {
  let current: ResolvedTheme | null = null;
  const sync = () => {
    const next = resolveTheme(pref, deps.media.matches);
    if (next === current) return;
    current = next;
    deps.apply(next);
    // Outside Tauri (browser preview) the IPC call throws synchronously; never let it break theming.
    void Promise.resolve()
      .then(() => deps.setWindowTheme(next))
      .catch(() => undefined);
  };
  sync();
  if (pref !== 'system') return () => undefined;
  deps.media.addEventListener('change', sync);
  return () => deps.media.removeEventListener('change', sync);
}
