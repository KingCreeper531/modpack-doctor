/**
 * The two places the UI reaches outside the webview for Modrinth (M5): cached icon files through
 * Tauri's asset protocol, and project pages in the user's browser through the opener plugin
 * (capability scoped to `https://modrinth.com/*`). Neither runs outside Tauri: the browser
 * mock's icons are inline `data:` images, and its links open in a new tab.
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

import type { Backend } from './ipc';

/** `convertFileSrc` inside Tauri; null elsewhere (no icon files to show). */
export function iconConverter(kind: Backend['kind']): ((path: string) => string) | null {
  return kind === 'tauri' ? (p) => convertFileSrc(p) : null;
}

/** Only Modrinth project pages are ever opened. */
export function isModrinthPage(url: string): boolean {
  return /^https:\/\/modrinth\.com\/[^\s]*$/.test(url);
}

export async function openExternal(url: string, kind: Backend['kind']): Promise<void> {
  if (!isModrinthPage(url)) return;
  if (kind === 'tauri') await openUrl(url);
  else if (kind === 'mock' && typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
}
