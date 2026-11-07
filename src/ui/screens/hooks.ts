/** Small view hooks shared by the screens. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';

import { anchorOf, showMenu } from '../app/menuHost';
import type { MenuEntry } from '../app/menus';
import type { AppStore } from '../app/store';
import { useApp, useAppStore } from '../app/StoreContext';

/**
 * Wall clock that re-renders the caller every `intervalMs` while `active`. A change of `restart`
 * (e.g. a new countdown target) reads the clock again at once.
 */
export function useNow(intervalMs: number, active = true, restart?: unknown): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active, restart]);
  return now;
}

/** `window.innerWidth`, updated on resize. */
export function useViewportWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

/** Content-box height of an element, tracked with a ResizeObserver. */
/**
 * Uses a callback ref so the observer re-binds whenever React swaps the DOM node; a
 * mount-only `useRef` + effect kept observing a detached node after the workspace re-rendered,
 * which froze the mod table at its pre-scan height (M3 visual review).
 */
export function useElementHeight<T extends HTMLElement>(fallback: number): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [height, setHeight] = useState(fallback);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = (h: number) => setHeight(h > 0 ? Math.floor(h) : fallback);
    measure(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => measure(entries[0]?.contentRect.height ?? el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, fallback]);
  return [setEl, height];
}

/**
 * `onContextMenu` for a row: builds the row's menu when asked and shows it (native under Tauri,
 * the DOM menu in the browser). An empty menu leaves the event alone.
 */
export function useRowMenu(): (e: MouseEvent<HTMLElement>, label: string, build: (store: AppStore) => MenuEntry[]) => void {
  const store = useAppStore();
  const kind = useApp((s) => s.backendKind);
  return useCallback(
    (e, label, build) => {
      const items = build(store);
      if (!items.length) return;
      e.preventDefault();
      e.stopPropagation();
      showMenu(store, kind, label, items, anchorOf(e));
    },
    [store, kind],
  );
}

/**
 * The keyboard cursor (J/K) over a findings list: the row under it scrolls into view, and an
 * Enter request (`cursorToggle`) for one of `ids` toggles that row like a click. Returns the
 * cursor id. A request made before this list mounted is ignored.
 */
export function useFindingCursor(list: RefObject<HTMLElement | null>, ids: readonly string[], toggle: (id: string) => void): string | null {
  const cursor = useApp((s) => s.cursor);
  const request = useApp((s) => s.cursorToggle);
  const handled = useRef(request?.n ?? 0);
  const latest = useRef({ ids, toggle });
  latest.current = { ids, toggle };
  useEffect(() => {
    if (!request || request.n === handled.current) return;
    handled.current = request.n;
    if (latest.current.ids.includes(request.id)) latest.current.toggle(request.id);
  }, [request]);
  useEffect(() => {
    if (!cursor) return;
    const rows = list.current?.querySelectorAll<HTMLElement>('[data-finding-id]') ?? [];
    Array.from(rows)
      .find((r) => r.dataset.findingId === cursor)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor, list]);
  return cursor;
}
