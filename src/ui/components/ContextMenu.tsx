/**
 * DOM context menu (browser dev build; Tauri shows native menus). DESIGN §4/§6.5 overlay: `panel`
 * surface, hairline `shadow-overlay` (the one shadow overlays may use), r-2, 24px rows in
 * `t-body`, the shortcut right-aligned in mono `fg-faint`. The active row reads like the palette's:
 * `raised` plus a 2px `signal` left rule. Separators are `line` hairlines.
 *
 * Keyboard (WAI-ARIA menu): focus lands on the first enabled item; Up/Down move (wrapping,
 * skipping disabled items), Home/End jump, Enter/Space run the item, Esc and Tab close. A click
 * outside closes it. It stays inside the viewport.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { isAction, type MenuAction, type MenuEntry } from '../app/menus';
import { cx } from './cx';

export interface ContextMenuProps {
  label: string;
  items: readonly MenuEntry[];
  x: number;
  y: number;
  onClose: () => void;
  /** `fixed` (the real menu) or `contained` (the /design specimen, positioned by its parent). */
  placement?: 'fixed' | 'contained';
  autoFocus?: boolean;
  className?: string;
}

/** Next enabled action index from `from` in direction `dir` (wrapping), or -1. */
export function stepEnabled(items: readonly MenuEntry[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    const it = items[i];
    if (it && isAction(it) && !it.disabled) return i;
  }
  return -1;
}

export function ContextMenu({ label, items, x, y, onClose, placement = 'fixed', autoFocus = true, className }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(() => stepEnabled(items, -1, 1));
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu on screen: flip left/up when it would overflow the viewport.
  useLayoutEffect(() => {
    if (placement !== 'fixed') return;
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({ left: Math.max(8, x + w > vw - 8 ? x - w : x), top: Math.max(8, y + h > vh - 8 ? Math.max(8, y - h) : y) });
  }, [x, y, placement]);

  useLayoutEffect(() => {
    if (!autoFocus || active < 0) return;
    ref.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [active, autoFocus]);

  const run = (it: MenuAction) => {
    if (it.disabled) return;
    onClose();
    it.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (dir: 1 | -1, from = active) => {
      const i = stepEnabled(items, from, dir);
      if (i >= 0) setActive(i);
    };
    switch (e.key) {
      case 'ArrowDown':
        step(1);
        break;
      case 'ArrowUp':
        step(-1);
        break;
      case 'Home':
        step(1, -1);
        break;
      case 'End':
        step(-1, items.length);
        break;
      case 'Enter':
      case ' ': {
        const it = items[active];
        if (it && isAction(it)) run(it);
        break;
      }
      case 'Escape':
      case 'Tab':
        onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={placement === 'fixed' ? { left: pos.left, top: pos.top } : undefined}
      className={cx('z-50 flex min-w-[208px] max-w-[320px] flex-col rounded-2 bg-panel py-1 shadow-overlay', placement === 'fixed' && 'fixed', className)}
    >
      {items.map((it, i) =>
        isAction(it) ? (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            data-index={i}
            data-menu-id={it.id}
            tabIndex={i === active ? 0 : -1}
            aria-disabled={it.disabled || undefined}
            onMouseEnter={() => !it.disabled && setActive(i)}
            onClick={() => run(it)}
            className={cx(
              'flex h-6 shrink-0 items-center gap-4 border-l-2 pr-4 pl-[14px] text-left t-body focus-visible:outline-none',
              i === active ? 'border-signal bg-raised' : 'border-transparent',
              it.disabled ? 'cursor-not-allowed text-fg-faint' : 'cursor-default text-fg',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.shortcut ? <span className="shrink-0 t-mono text-fg-faint">{it.shortcut}</span> : null}
          </button>
        ) : (
          <div key={it.id} role="separator" className="my-1 h-px shrink-0 bg-line" />
        ),
      )}
    </div>
  );
}
