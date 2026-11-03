/**
 * Severity marks (DESIGN.md §6.2). Rails use the fill tokens (`err` / `signal` / `info`);
 * text uses the matching text tokens (`err-text` / `signal` / `info`). Never `err` under text.
 */
import type { ReactNode } from 'react';

import type { Severity } from '../../core/model';
import { cx } from './cx';
import { SEVERITY_WORD } from './labels';

export const RAIL_BG: Record<Severity, string> = { error: 'bg-err', warning: 'bg-signal', info: 'bg-info' };
export const SEVERITY_TEXT: Record<Severity, string> = { error: 'text-err-text', warning: 'text-signal', info: 'text-info' };

export interface SeverityRailProps {
  severity: Severity | null;
  /** Rail width in px: 4 for triage rows and the mod table, 2 for compact marks. */
  width?: 2 | 4;
  className?: string;
}

/** A vertical bar that stretches to its row's height. `null` reserves the space, uncoloured. */
export function SeverityRail({ severity, width = 4, className }: SeverityRailProps) {
  return (
    <span
      aria-hidden
      className={cx('block shrink-0 self-stretch', width === 4 ? 'w-1' : 'w-[2px]', severity ? RAIL_BG[severity] : 'bg-transparent', className)}
    />
  );
}

export interface SeverityTextProps {
  severity: Severity;
  children?: ReactNode;
  mono?: boolean;
  className?: string;
}

/** Text in the severity's text token. Defaults to the short word (`ERR`, `WARN`, `INFO`). */
export function SeverityText({ severity, children, mono = true, className }: SeverityTextProps) {
  return <span className={cx(mono ? 't-mono' : 't-body', SEVERITY_TEXT[severity], className)}>{children ?? SEVERITY_WORD[severity]}</span>;
}

/** Status pip (DESIGN.md §5, §10): a 4px square. `none` is hollow so it still reads at ≥ 3:1. */
export type PipTone = 'ok' | 'warning' | 'error' | 'info' | 'none';

const PIP: Record<PipTone, string> = {
  ok: 'bg-ok',
  warning: 'bg-signal',
  error: 'bg-err',
  info: 'bg-info',
  none: 'border border-fg-faint bg-tile-empty',
};

export function Pip({ tone, label, className }: { tone: PipTone; label?: string; className?: string }) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx('inline-block size-1 shrink-0', PIP[tone], className)}
    />
  );
}
