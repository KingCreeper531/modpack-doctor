/**
 * Shows a context menu (CONTRACTS invariant 17): a native menu (`@tauri-apps/api/menu`, permission
 * `core:menu:default`) inside Tauri, the DESIGN-styled DOM menu (components/ContextMenu.tsx, via
 * the store) in the browser dev build. Items come from menus.ts.
 *
 * Also the clipboard helper the menus use: `navigator.clipboard`, falling back to a hidden
 * textarea + `execCommand('copy')` where the async clipboard is refused.
 */
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';

import type { Backend } from './ipc';
import { isAction, type MenuEntry } from './menus';
import type { AppStore } from './store';

export interface MenuAnchor {
  x: number;
  y: number;
  /** The element the menu is about; focus returns to it when a DOM menu closes. */
  origin: HTMLElement | null;
}

/**
 * Where a `contextmenu` event opens its menu: the pointer, or, from the keyboard (Shift+F10, the
 * Menu key: no pointer position), the bottom-left of the element.
 */
export function anchorOf(e: { clientX: number; clientY: number; currentTarget: EventTarget | null }): MenuAnchor {
  const el = (e.currentTarget as HTMLElement | null) ?? null;
  if ((e.clientX !== 0 || e.clientY !== 0) || !el?.getBoundingClientRect) return { x: e.clientX, y: e.clientY, origin: el };
  const r = el.getBoundingClientRect();
  return { x: r.left + 16, y: r.bottom, origin: el };
}

/** The native menu shown last; closed (its resources freed) when the next one opens. */
let lastNative: Menu | null = null;

async function nativeMenu(items: readonly MenuEntry[], at: MenuAnchor): Promise<void> {
  const built = await Promise.all(
    items.map((e) =>
      isAction(e)
        ? MenuItem.new({ id: e.id, text: e.label, enabled: !e.disabled, action: () => e.run() })
        : PredefinedMenuItem.new({ item: 'Separator' }),
    ),
  );
  const menu = await Menu.new({ items: built });
  const prev = lastNative;
  lastNative = menu;
  void prev?.close().catch(() => undefined);
  await menu.popup(new LogicalPosition(at.x, at.y));
}

/** Show `items` as a context menu: native under Tauri, the DOM menu otherwise. */
export function showMenu(store: AppStore, kind: Backend['kind'], label: string, items: readonly MenuEntry[], at: MenuAnchor): void {
  if (!items.length) return;
  if (kind === 'tauri') {
    // A native menu that cannot be built falls back to the DOM one rather than showing nothing.
    void nativeMenu(items, at).catch(() => store.getState().openMenu({ label, items: [...items], x: at.x, y: at.y, returnFocus: at.origin }));
    return;
  }
  store.getState().openMenu({ label, items: [...items], x: at.x, y: at.y, returnFocus: at.origin });
}

/** Copy text to the clipboard; resolves false when every way was refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea route.
  }
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  const prev = document.activeElement as HTMLElement | null;
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand?.('copy') ?? false;
  } catch {
    ok = false;
  }
  ta.remove();
  prev?.focus?.();
  return ok;
}
