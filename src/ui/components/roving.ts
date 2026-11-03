/**
 * Keyboard pattern shared by radio groups and tab lists (WAI-ARIA APG): one tab stop (the checked
 * or selected item gets `tabIndex` 0, the rest -1); arrows move and select, wrapping at the ends;
 * Home and End jump to the first and last item. Radio groups take all four arrows, a horizontal
 * tab list only Left and Right.
 */
import type { KeyboardEvent } from 'react';

export type RovingKeys = 'radio' | 'tabs';

/** The index a key moves to, or null when the key is not one of the group's. */
export function rovingIndex(key: string, current: number, count: number, keys: RovingKeys = 'radio'): number | null {
  if (count <= 0) return null;
  const cur = current < 0 ? 0 : current;
  const next = keys === 'radio' ? ['ArrowRight', 'ArrowDown'] : ['ArrowRight'];
  const prev = keys === 'radio' ? ['ArrowLeft', 'ArrowUp'] : ['ArrowLeft'];
  if (next.includes(key)) return (cur + 1) % count;
  if (prev.includes(key)) return (cur + count - 1) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * `onKeyDown` for the group's container. Items carry `data-roving="<value>"`; the new one is
 * chosen (`onChange`) and focused.
 */
export function onRovingKeyDown<T extends string>(
  e: KeyboardEvent<HTMLElement>,
  values: readonly T[],
  value: T | undefined,
  onChange: ((v: T) => void) | undefined,
  keys: RovingKeys = 'radio',
): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const i = rovingIndex(e.key, value === undefined ? -1 : values.indexOf(value), values.length, keys);
  const next = i === null ? undefined : values[i];
  if (next === undefined) return;
  e.preventDefault();
  if (next !== value) onChange?.(next);
  e.currentTarget.querySelector<HTMLElement>(`[data-roving="${next}"]`)?.focus();
}
