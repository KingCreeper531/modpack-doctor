/** Split-pane resizing maths (DESIGN.md §5: inspector 360px, resizable 280–640). Pure. */

export const INSPECTOR_DEFAULT = 360;
export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 640;
/** Arrow-key step; Shift multiplies by 4. Both on the 8px grid. */
export const RESIZE_STEP = 8;

export function clampSize(size: number, min: number, max: number): number {
  if (Number.isNaN(size)) return min;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.round(Math.min(hi, Math.max(lo, size)));
}

/**
 * Size after dragging the handle from `startX` to `x`. `edge` is the side of the resized pane
 * the handle sits on: an inspector on the right has its handle on its `start` edge, so dragging
 * left (negative dx) grows it.
 */
export function sizeFromDrag(
  startSize: number,
  startX: number,
  x: number,
  edge: 'start' | 'end',
  min: number,
  max: number,
): number {
  const dx = x - startX;
  return clampSize(edge === 'start' ? startSize - dx : startSize + dx, min, max);
}

/**
 * Keyboard resizing for a `role="separator"` handle. Arrow keys move the handle; Home/End jump
 * to the limits. Returns null for keys the handle does not handle.
 */
export function sizeFromKey(
  size: number,
  key: string,
  shift: boolean,
  edge: 'start' | 'end',
  min: number,
  max: number,
): number | null {
  const step = RESIZE_STEP * (shift ? 4 : 1);
  const grow = edge === 'start' ? 'ArrowLeft' : 'ArrowRight';
  const shrink = edge === 'start' ? 'ArrowRight' : 'ArrowLeft';
  if (key === grow) return clampSize(size + step, min, max);
  if (key === shrink) return clampSize(size - step, min, max);
  if (key === 'Home') return clampSize(min, min, max);
  if (key === 'End') return clampSize(max, min, max);
  return null;
}
