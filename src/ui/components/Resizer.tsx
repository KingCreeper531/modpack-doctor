/**
 * Split handle (DESIGN.md §5): a 1px `line` that thickens to 2px `signal` on hover or drag.
 * An 8px transparent hit area keeps it easy to grab; arrow keys resize in 8px steps (Shift ×4),
 * Home/End jump to the limits. Width persistence belongs to the owner (settings).
 */
import { useRef, useState, type PointerEvent } from 'react';

import { cx } from './cx';
import { sizeFromDrag, sizeFromKey } from './resize';

export interface ResizerProps {
  size: number;
  min: number;
  max: number;
  onResize: (size: number) => void;
  /** Called once when a drag or key press ends, e.g. to persist the width. */
  onCommit?: (size: number) => void;
  /** Which edge of the resized pane the handle sits on (inspector on the right → `start`). */
  edge?: 'start' | 'end';
  label: string;
  className?: string;
}

export function Resizer({ size, min, max, onResize, onCommit, edge = 'start', label, className }: ResizerProps) {
  const drag = useRef<{ x: number; size: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, size, last: size };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const next = sizeFromDrag(d.size, d.x, e.clientX, edge, min, max);
    if (next !== d.last) {
      d.last = next;
      onResize(next);
    }
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit?.(d.last);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(e) => {
        const next = sizeFromKey(size, e.key, e.shiftKey, edge, min, max);
        if (next === null) return;
        e.preventDefault();
        onResize(next);
        onCommit?.(next);
      }}
      className={cx('group relative w-2 shrink-0 cursor-col-resize touch-none select-none', className)}
    >
      <span
        aria-hidden
        className={cx(
          'absolute inset-y-0 left-1/2 block -translate-x-1/2',
          'w-px bg-line group-hover:w-[2px] group-hover:bg-signal group-focus-visible:w-[2px] group-focus-visible:bg-signal',
          dragging && 'w-[2px] bg-signal',
        )}
      />
    </div>
  );
}
