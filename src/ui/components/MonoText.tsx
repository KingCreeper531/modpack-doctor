/**
 * Mono text (DESIGN.md §1, §3): anything you could paste into a bug report — versions, hashes,
 * paths, mod ids. Tabular numerals; truncates with the full value as a native title.
 */
import type { ReactNode } from 'react';

import { cx } from './cx';

export type TextTone = 'fg' | 'dim' | 'faint' | 'ok' | 'signal' | 'err' | 'info';

export const TONE: Record<TextTone, string> = {
  fg: 'text-fg',
  dim: 'text-fg-dim',
  faint: 'text-fg-faint',
  ok: 'text-ok',
  signal: 'text-signal',
  err: 'text-err-text',
  info: 'text-info',
};

export interface MonoTextProps {
  children: ReactNode;
  tone?: TextTone;
  /** Ellipsis on overflow; the string value becomes the title. */
  truncate?: boolean;
  /** Middle-ellipsis is not attempted; long paths keep their head and lose the tail. */
  title?: string;
  className?: string;
}

export function MonoText({ children, tone = 'fg', truncate = false, title, className }: MonoTextProps) {
  const t = title ?? (truncate && typeof children === 'string' ? children : undefined);
  return (
    <span className={cx('t-mono', TONE[tone], truncate && 'block min-w-0 truncate', className)} title={t}>
      {children}
    </span>
  );
}
