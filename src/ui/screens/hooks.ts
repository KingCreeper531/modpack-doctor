/** Small view hooks shared by the screens. */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Wall clock that re-renders the caller every `intervalMs` while `active`. */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active]);
  return now;
}

/** Content-box height of an element, tracked with a ResizeObserver. */
export function useElementHeight<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = (h: number) => setHeight(h > 0 ? Math.floor(h) : fallback);
    measure(el.clientHeight);
    const ro = new ResizeObserver((entries) => measure(entries[0]?.contentRect.height ?? el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, height];
}
