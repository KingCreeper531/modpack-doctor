/**
 * Tooltip (DESIGN.md §6.5): raised, 1px line-strong border, mono 11px, no arrow.
 * 400ms show delay on DOM elements; the canvas grid uses `TooltipBox` directly with 0ms.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { cx } from './cx';

export interface TooltipBoxProps {
  children: ReactNode;
  id?: string;
  className?: string;
  style?: CSSProperties;
}

/** The visual box only. Overlays are the one place `shadow-overlay` is allowed. */
export function TooltipBox({ children, id, className, style }: TooltipBoxProps) {
  return (
    <div
      id={id}
      role="tooltip"
      style={style}
      className={cx(
        'pointer-events-none z-20 w-max max-w-[480px] border border-line-strong bg-raised px-2 py-1 font-mono text-[11px] leading-4 whitespace-pre text-fg tabular-nums shadow-overlay',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /** ms before showing; DOM default 400. */
  delay?: number;
  /** Where the box sits relative to the trigger. */
  side?: 'bottom' | 'top';
  className?: string;
}

/** Wraps an inline trigger; shows on hover and on keyboard focus, hides on Escape. */
export function Tooltip({ content, children, delay = 400, side = 'bottom', className }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <span
      className={cx('relative inline-flex', className)}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === 'Escape') hide();
      }}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open ? (
        <TooltipBox id={id} className={cx('absolute left-0', side === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1')}>
          {content}
        </TooltipBox>
      ) : null}
    </span>
  );
}
