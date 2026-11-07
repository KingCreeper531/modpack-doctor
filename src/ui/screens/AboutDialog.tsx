/**
 * About host (DESIGN §6.8, M8): the data plate as a modal layer, opened from the rail footer's
 * About button or the palette ("About Modpack Doctor", "Check for updates").
 *
 * - Anchored 64px below the window top at the workspace's left edge (never centred, like the
 *   palette), over a transparent click-away layer (no scrim, no blur).
 * - Focus moves into the dialog when it opens, Tab and Shift+Tab stay inside it, Esc closes it,
 *   and focus returns to whatever had it before (the About button, or what the palette returned
 *   it to). While it is open, key presses never reach the window shortcuts underneath.
 * - Build rows: version and commit come from the bundle; Tauri version, data folder and cache
 *   folder from `app_info`, asked each time About opens (the browser mock answers with fixed
 *   values). Rows stay off the plate until they are known.
 * - Updates (CONTRACTS invariant 18): nothing is checked until "Check for updates" is pressed,
 *   and nothing is installed until "Install <version> and restart" is pressed for that version.
 * - The only link is the project's GitHub page, through the opener plugin (capability scope
 *   `https://github.com/KingCreeper531/modpack-doctor` and `…/modpack-doctor/*`); the browser mock
 *   opens a tab.
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { commands, type AppInfo } from '../../bindings';
import { AboutPlate, REPO_URL, UpdateSection, type AboutInfo } from '../components/AboutPlate';
import { suppressesDefault } from '../app/keyboard';
import type { AppCommands, Backend } from '../app/ipc';
import { createMockBackend } from '../app/mockIpc';
import { useActions, useApp } from '../app/StoreContext';
import { version } from '../../../package.json';

export const APP_VERSION: string = version;

/**
 * What this build can report about itself: the bundle's version and commit, plus `app_info` once
 * it has answered. Unknown values are left off the plate.
 */
export function aboutInfo(
  env: { DEV: boolean; VITE_BUILD_COMMIT?: string | undefined } = import.meta.env,
  app: AppInfo | null = null,
): AboutInfo {
  const commit = env.VITE_BUILD_COMMIT?.trim();
  const known = (v: string | undefined) => (v?.trim() ? v.trim() : null);
  return {
    version: APP_VERSION,
    commit: commit ? commit : env.DEV ? 'development build' : null,
    tauri: known(app?.tauriVersion),
    dataDir: known(app?.dataDir),
    cacheDir: known(app?.cacheDir),
    licence: 'TBD by the owner',
  };
}

/**
 * Asks for the Tauri version and the app's data and cache folders: the `app_info` command under
 * Tauri, fixed values from the browser mock. Without a backend, or when the command fails, the
 * answer is null and those rows are left off.
 */
export async function loadAppInfo(kind: Backend['kind'], cmds?: Pick<AppCommands, 'appInfo'>): Promise<AppInfo | null> {
  if (kind === 'none') return null;
  // `import.meta.env.DEV` is a compile-time constant, so production bundles drop the mock (ipc.ts).
  const source = cmds ?? (kind === 'tauri' ? commands : import.meta.env.DEV ? createMockBackend().commands : null);
  if (!source) return null;
  try {
    const r = await source.appInfo();
    return r.status === 'ok' ? r.data : null;
  } catch {
    return null;
  }
}

/** Only the project's own GitHub pages are opened from About. */
export function isRepoUrl(url: string): boolean {
  return url === REPO_URL || url.startsWith(`${REPO_URL}/`);
}

export async function openRepoUrl(url: string, kind: Backend['kind']): Promise<void> {
  if (!isRepoUrl(url)) return;
  if (kind === 'tauri') await openUrl(url).catch(() => undefined);
  else if (kind === 'mock' && typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

export function AboutDialog() {
  const open = useApp((s) => s.aboutOpen);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<AboutLayer />, document.body);
}

function AboutLayer() {
  const update = useApp((s) => s.update);
  const backendKind = useApp((s) => s.backendKind);
  const a = useActions();
  const dialog = useRef<HTMLElement>(null);
  const [app, setApp] = useState<AppInfo | null>(null);

  // Asked each time About opens (this layer mounts on open), never before.
  useEffect(() => {
    let live = true;
    void loadAppInfo(backendKind).then((info) => {
      if (live) setApp(info);
    });
    return () => {
      live = false;
    };
  }, [backendKind]);

  useEffect(() => {
    // Runs after the palette (if it opened us) gave focus back, so this is the element to return to.
    const returnTo = document.activeElement;
    dialog.current?.focus();
    return () => {
      const target =
        returnTo instanceof HTMLElement && returnTo.isConnected && returnTo !== document.body
          ? returnTo
          : document.querySelector<HTMLElement>('[data-about-trigger]');
      target?.focus();
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    // Modal: the window shortcuts (J/K, Enter, Ctrl+K, Ctrl+R) never act underneath.
    e.stopPropagation();
    if (suppressesDefault(e)) e.preventDefault();
    if (e.key === 'Escape') {
      e.preventDefault();
      a.setAboutOpen(false);
      return;
    }
    if (e.key !== 'Tab' || !dialog.current) return;
    const list = focusables(dialog.current);
    if (!list.length) {
      e.preventDefault();
      return;
    }
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialog.current || !dialog.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialog.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      {/* Click-away layer: transparent, no blur (DESIGN §11). */}
      <div aria-hidden className="fixed inset-0 z-40" onMouseDown={() => a.setAboutOpen(false)} />
      <div className="fixed top-16 left-[256px] z-50 max-h-[calc(100vh-96px)] max-w-[calc(100vw-272px)] overflow-y-auto">
        <AboutPlate
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby="about-title"
          tabIndex={-1}
          titleId="about-title"
          onKeyDown={onKeyDown}
          info={aboutInfo(import.meta.env, app)}
          onClose={() => a.setAboutOpen(false)}
          onOpenLink={(url) => void openRepoUrl(url, backendKind)}
          className="focus-visible:outline-none"
          updates={<UpdateSection view={update} onCheck={() => void a.checkUpdate()} onInstall={(v) => void a.installUpdate(v)} />}
        />
      </div>
    </>
  );
}
