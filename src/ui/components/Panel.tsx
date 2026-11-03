/**
 * Ruled panel (DESIGN.md §4): a full-bleed region with an 11px uppercase legend in a 32px header
 * row and right-aligned mono meta. Panels share edges with neighbours; they never float.
 */
import type { HTMLAttributes, ReactNode } from 'react';

import { cx } from './cx';

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Silkscreen legend, e.g. `FINDINGS`. Rendered uppercase. */
  legend: ReactNode;
  /** Right-aligned meta: counts, timings. Mono. */
  meta?: ReactNode;
  /** Controls placed between the legend and the meta. */
  actions?: ReactNode;
  /** Remove the body's default padding (tables, grids and logs bring their own). */
  flush?: boolean;
  bodyClassName?: string;
  children?: ReactNode;
}

export function Panel({ legend, meta, actions, flush = false, className, bodyClassName, children, ...rest }: PanelProps) {
  return (
    <section className={cx('flex min-w-0 flex-col bg-panel', className)} {...rest}>
      <header className="flex h-8 shrink-0 items-center gap-4 border-b border-line px-4">
        <h2 className="t-label text-fg-faint">{legend}</h2>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        {meta !== undefined ? <div className="ml-auto truncate t-mono text-fg-faint">{meta}</div> : null}
      </header>
      <div className={cx('min-h-0 flex-1', !flush && 'p-4', bodyClassName)}>{children}</div>
    </section>
  );
}
