/** Data-plate rows for the inspector (DESIGN.md §6.8 style): a label column and a mono value. */
import type { ReactNode } from 'react';

import type { RawRange } from '../../../bindings';
import { cx } from '../../components/cx';

export function Plate({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <dl aria-label={label} className={cx('flex flex-col', className)}>
      {children}
    </dl>
  );
}

export function PlateRow({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex min-h-6 items-baseline gap-2 border-b border-line px-4 py-1', className)}>
      <dt className="w-24 shrink-0 t-label text-fg-faint">{label}</dt>
      <dd className="min-w-0 flex-1 t-mono break-all text-fg">{children}</dd>
    </div>
  );
}

/** A sub-legend inside a panel body (`MODS`, `DEPENDENCIES`). */
export function SubLegend({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex h-6 items-center gap-2 border-b border-line bg-raised px-4">
      <span className="t-label text-fg-faint">{children}</span>
      {meta !== undefined ? <span className="ml-auto truncate t-mono text-fg-faint">{meta}</span> : null}
    </div>
  );
}

/** A declared range as written (`[47,)`, `>=0.15 <0.16`), or `any`. */
export function rangeText(r: RawRange | null): string {
  if (!r) return '—';
  if (r.unrepresentable) return r.unrepresentable;
  if (!r.raw.length || r.raw.includes('*')) return 'any';
  return r.raw.join(' || ');
}
