/**
 * The window-level layers (M7): the command palette (Ctrl/Cmd+K, DESIGN §6.7), the DOM context
 * menu of the browser dev build, the file-drop overlay, and the single keyboard listener
 * (app/keyboard.ts). Rendered once by the shell.
 *
 * Focus: the palette and the DOM menu each return focus to the element that had it when they
 * opened (if it is still on the page).
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { CommandPalette, type PaletteGroup } from '../components/CommandPalette';
import { ContextMenu } from '../components/ContextMenu';
import { LoaderGlyph } from '../glyphs/LoaderGlyph';
import { shortcutOf, suppressesDefault } from '../app/keyboard';
import { paletteGroups, runPaletteCommand } from '../app/paletteCommands';
import type { AppStore } from '../app/store';
import { useActions, useApp, useAppShallow, useAppStore } from '../app/StoreContext';
import { LogDialogs } from './LogDialogs';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

function restoreFocus(el: Element | null) {
  if (el && el instanceof HTMLElement && el.isConnected && el !== document.body) el.focus();
}

/** Applies one key press to the store (exported for tests). */
export function handleKey(store: AppStore, e: KeyboardEvent): void {
  const sc = shortcutOf(e);
  if (suppressesDefault(e)) e.preventDefault();
  if (!sc) return;
  const st = store.getState();
  switch (sc) {
    case 'palette':
      e.preventDefault();
      st.setPaletteOpen(!st.paletteOpen);
      return;
    case 'rescan':
      if (st.selectedInstanceId) void st.scan(st.selectedInstanceId);
      return;
    case 'next':
    case 'previous':
      if (st.paletteOpen || st.menu) return;
      e.preventDefault();
      st.moveCursor(sc === 'next' ? 1 : -1);
      return;
    case 'toggle':
      if (st.paletteOpen || st.menu || !st.cursor) return;
      e.preventDefault();
      st.toggleCursor();
      return;
    case 'escape':
      // Top-most layer first. An open work order is left to its own panel (§6.4): a running one
      // is never discarded, and nothing here cancels one.
      if (st.paletteOpen) st.setPaletteOpen(false);
      else if (st.aboutOpen) st.setAboutOpen(false);
      else if (st.menu) st.closeMenu();
      else if (st.order) return;
      else if (st.selection) st.select(null);
      else return;
      e.preventDefault();
      return;
  }
}

function Shortcuts() {
  const store = useAppStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleKey(store, e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
  return null;
}

function Palette() {
  const open = useApp((s) => s.paletteOpen);
  const returnTo = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  // Remember who had focus before the palette's input takes it (render runs before autofocus).
  if (open && !wasOpen.current && typeof document !== 'undefined') returnTo.current = document.activeElement;
  useEffect(() => {
    if (wasOpen.current && !open) restoreFocus(returnTo.current);
    wasOpen.current = open;
  }, [open]);
  return open ? <PaletteOverlay /> : null;
}

function PaletteOverlay() {
  const s = useAppShallow((st) => ({
    discovery: st.discovery,
    selectedInstanceId: st.selectedInstanceId,
    scans: st.scans,
    settings: st.settings,
    crashes: st.crashes,
  }));
  const a = useActions();
  const groups = useMemo((): PaletteGroup[] => {
    const byId = new Map((s.discovery?.instances ?? []).map((i) => [i.id, i]));
    return paletteGroups(s).map((g) => ({
      heading: g.heading,
      items: g.items.map((it) => {
        const inst = it.id.startsWith('instance:') ? byId.get(it.id.slice('instance:'.length)) : undefined;
        return {
          id: it.id,
          label: it.label,
          ...(it.detail ? { detail: it.detail } : {}),
          ...(it.code ? { code: it.code } : {}),
          ...(it.keywords ? { keywords: it.keywords } : {}),
          ...(it.shortcut ? { shortcut: it.shortcut } : {}),
          ...(inst ? { icon: <LoaderGlyph kind={inst.loader?.kind ?? null} size={12} /> } : {}),
        };
      }),
    }));
  }, [s]);
  return (
    <>
      {/* Click-away layer: transparent, no blur (DESIGN §11). */}
      <div aria-hidden className="fixed inset-0 z-40" onMouseDown={() => a.setPaletteOpen(false)} />
      <CommandPalette
        groups={groups}
        onClose={() => a.setPaletteOpen(false)}
        onSelect={(id) => {
          a.setPaletteOpen(false);
          runPaletteCommand(id, s, a);
        }}
      />
    </>
  );
}

function MenuLayer() {
  const menu = useApp((s) => s.menu);
  const a = useActions();
  if (!menu) return null;
  const close = () => {
    a.closeMenu();
    restoreFocus(menu.returnFocus);
  };
  return (
    <>
      <div
        aria-hidden
        className="fixed inset-0 z-40"
        onMouseDown={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <ContextMenu key={`${menu.x},${menu.y},${menu.label}`} label={menu.label} items={menu.items} x={menu.x} y={menu.y} onClose={close} />
    </>
  );
}

/** True when a drag carries files (not text or a link dragged inside the page). */
function hasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
}

/**
 * A quiet frame while a file is dragged over the window. Visual only: the DOM drag events never
 * open anything. The actual open is Rust's (`WindowEvent::DragDrop` → `InstanceAdded` /
 * `DropRejected`); the DOM drop is only cancelled so the webview never navigates to the file.
 */
export function DropOverlay({ forceShow = false }: { forceShow?: boolean }) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
      depth = 0;
      setOver(false);
    };
    // Under Tauri the OS file drag goes to Rust (dragDropEnabled) and WebView2 may not fire DOM
    // drag events: mirror Tauri's webview drag events for the overlay only (paths are ignored;
    // opening stays Rust's InstanceAdded / DropRejected).
    let unlistenTauri: (() => void) | null = null;
    let disposed = false;
    if (isTauri()) {
      void getCurrentWebview()
        .onDragDropEvent((e) => {
          const t = e.payload.type;
          setOver(t === 'enter' || t === 'over');
        })
        .then((u) => {
          if (disposed) u();
          else unlistenTauri = u;
        })
        .catch(() => {});
    }
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
      disposed = true;
      unlistenTauri?.();
    };
  }, []);
  if (!over && !forceShow) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50" data-testid="drop-overlay">
      <div aria-hidden className="absolute inset-2 rounded-2 border-2 border-dashed border-signal" />
      <div role="status" className="absolute top-16 left-1/2 flex h-8 -translate-x-1/2 items-center gap-4 rounded-2 bg-panel px-4 shadow-overlay">
        <span className="t-label text-signal">Drop</span>
        <span className="t-body whitespace-nowrap text-fg">Release to open a .mrpack file</span>
        <span className="t-mono whitespace-nowrap text-fg-faint">read-only</span>
      </div>
    </div>
  );
}

export function Overlays({ dragPreview = false }: { dragPreview?: boolean }) {
  return (
    <>
      <Shortcuts />
      <DropOverlay forceShow={dragPreview} />
      <MenuLayer />
      <Palette />
      <LogDialogs />
    </>
  );
}
