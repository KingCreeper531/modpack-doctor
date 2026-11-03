/**
 * Summary strip (DESIGN.md §5, §10): one 32px line of mono segments separated by ` · `.
 * `1.20.1 · Forge 47.3.0 · 214 mods · 3 errors · 5 warnings · scanned 2.1s ago`.
 * Error / warning counts are coloured only when non-zero; the age is `fg-faint`.
 * Variants: `scanning 132/214` while a scan runs; the offline notice with an `info` pip.
 */
import { Fragment, type ReactNode } from 'react';

import type { LoaderInfo } from '../../bindings';
import { LOADER_NAME } from '../glyphs/loaders';
import { cx } from './cx';
import { formatAgo, formatInt, plural } from './format';
import { Pip } from './Severity';

export interface SummaryStripProps {
  mcVersion: string | null;
  loader: LoaderInfo | null;
  modCount: number;
  counts?: { error: number; warning: number; info: number };
  /** ms since the last scan finished; omitted when never scanned. */
  scannedAgoMs?: number;
  /** The last scan failed (its error row explains why). */
  failed?: boolean;
  scanning?: { done: number; total: number } | null;
  /** Modrinth unreachable: static checks only. */
  offline?: boolean;
  /** Replaces the offline notice text, e.g. when Modrinth is switched off in settings. */
  offlineNotice?: string;
  className?: string;
}

export function SummaryStrip({
  mcVersion,
  loader,
  modCount,
  counts,
  scannedAgoMs,
  failed = false,
  scanning = null,
  offline = false,
  offlineNotice = 'Modrinth unreachable — static checks only',
  className,
}: SummaryStripProps) {
  const segments: Array<{ key: string; node: ReactNode }> = [
    { key: 'mc', node: <span className="text-fg">{mcVersion ?? 'MC unknown'}</span> },
    {
      key: 'loader',
      node: <span className="text-fg">{loader ? `${LOADER_NAME[loader.kind]} ${loader.version ?? ''}`.trim() : 'loader unknown'}</span>,
    },
    { key: 'mods', node: <span className="text-fg-dim">{plural(modCount, 'mod')}</span> },
  ];
  if (counts && !scanning) {
    segments.push(
      { key: 'err', node: <span className={counts.error ? 'text-err-text' : 'text-fg-dim'}>{plural(counts.error, 'error')}</span> },
      { key: 'warn', node: <span className={counts.warning ? 'text-signal' : 'text-fg-dim'}>{plural(counts.warning, 'warning')}</span> },
    );
    if (counts.info) segments.push({ key: 'info', node: <span className="text-info">{formatInt(counts.info)} info</span> });
  }
  if (scanning) {
    segments.push({
      key: 'scan',
      node: (
        <span className="text-signal" role="status">
          scanning {formatInt(scanning.done)}/{formatInt(scanning.total)}
        </span>
      ),
    });
  } else if (scannedAgoMs !== undefined) {
    segments.push({ key: 'ago', node: <span className="text-fg-faint">scanned {formatAgo(scannedAgoMs)}</span> });
  } else {
    segments.push({
      key: 'ago',
      node: failed ? <span className="text-err-text">scan failed</span> : <span className="text-fg-faint">not scanned</span>,
    });
  }

  return (
    <div className={cx('flex h-8 min-w-0 items-center gap-4 t-mono', className)}>
      <p className="min-w-0 truncate">
        {segments.map((s, i) => (
          <Fragment key={s.key}>
            {i > 0 ? <span className="text-fg-faint"> · </span> : null}
            {s.node}
          </Fragment>
        ))}
      </p>
      {offline ? (
        <p className="flex shrink-0 items-center gap-2 text-fg-dim" role="status">
          <Pip tone="info" />
          {offlineNotice}
        </p>
      ) : null}
    </div>
  );
}
