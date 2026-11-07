/** Small view hooks shared by the screens. */
import { useEffect, useLayoutEffect, useState } from 'react';

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
