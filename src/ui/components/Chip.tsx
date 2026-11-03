/**
 * Jar chip (DESIGN.md §6.3, §6.5): mono 11px, 16px tall, r-1, 1px line-strong border.
 * Clickable when `onClick` is given (selects the mod); otherwise a static label.
 */
import type { ReactNode } from 'react';

import { cx } from './cx';

export interface ChipProps {
  children: ReactNode;
  onClick?: () => void;
  /** Accessible name / native tooltip, e.g. the full jar path. */
  title?: string;
  /** Selected chip (its mod is open in the inspector). */
  selected?: boolean;
  /** Let the chip shrink and ellipsize in a crowded row instead of keeping its full width. */
  shrinkable?: boolean;
  className?: string;
}

const BASE =
  'inline-flex h-4 max-w-full items-center rounded-1 border px-1 font-mono text-[11px] leading-4 whitespace-nowrap tabular-nums';

export function Chip({ children, onClick, title, selected = false, shrinkable = false, className }: ChipProps) {
  const fit = shrinkable ? 'min-w-0 shrink' : 'shrink-0';
  const tone = selected ? 'border-signal bg-raised text-fg' : 'border-line-strong bg-panel text-fg-dim';
  if (!onClick) {
    return (
      <span className={cx(BASE, fit, tone, className)} title={title}>
        <span className="truncate">{children}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      title={title}
      aria-pressed={selected || undefined}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cx(BASE, fit, tone, 'cursor-pointer hover:border-fg-faint hover:bg-raised hover:text-fg', className)}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}
