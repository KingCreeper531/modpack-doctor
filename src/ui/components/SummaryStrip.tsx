/**
 * Summary strip (DESIGN.md §5, §10): one 32px line of mono segments separated by ` · `.
 * `1.20.1 · Forge 47.3.0 · 214 mods · 3 errors · 5 warnings · scanned 2.1s ago`.
 * Error / warning counts are coloured only when non-zero; the age is `fg-faint`.
 * Variants: `scanning 132/214` while a scan runs; the Modrinth notice (`Modrinth unreachable —
 * static checks only`, or the rate-limit countdown) in `fg-dim` with an `info` pip. When the user
 * switched Modrinth off, a quiet `Modrinth off` segment in `fg-faint` instead: a choice, not a
 * degraded state, so it gets no pip.
 * An interrupted work order (a backup listed `incomplete`) adds `interrupted work order — recover
 * in History` with an `err` pip: one line, never a toast; a click opens the History tab.
 */
import { Fragment, type ReactNode } from 'react';

import type { LoaderInfo } from '../../bindings';
import { LOADER_NAME } from '../glyphs/loaders';
import { cx } from './cx';
import { formatAgo, formatInt, plural } from './format';
import { Pip } from './Severity';

/** One piece of the notice; `optional` pieces show only when the strip has room. */
export interface NoticePiece {
  text: string;
  optional?: boolean;
}

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
  /**
   * Replaces the offline notice text. A string drops what follows ` — ` on a narrow strip; parts
   * drop their `optional` pieces instead (the rate-limit countdown is never optional).
   */
  offlineNotice?: string | readonly NoticePiece[];
  /** Modrinth is switched off in settings: a `Modrinth off` segment, no notice. */
  modrinthOff?: boolean;
  /** Backups of this instance left `incomplete`; the notice opens History. */
  interrupted?: { count: number; onOpen: () => void } | null;
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
  modrinthOff = false,
  interrupted = null,
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

  if (modrinthOff) segments.push({ key: 'mr-off', node: <span className="text-fg-faint">Modrinth off</span> });

  return (
    <div className={cx('@container flex h-8 min-w-0 items-center gap-4 t-mono', className)}>
      <p className="min-w-0 truncate">
        {segments.map((s, i) => (
          <Fragment key={s.key}>
            {i > 0 ? <span className="text-fg-faint"> · </span> : null}
            {s.node}
          </Fragment>
        ))}
      </p>
      {offline && !modrinthOff ? (
        // The pack's own counts matter more: a narrow strip shows only the essential pieces
        // ("Modrinth unreachable", "Modrinth · retrying in 42 s"); the optional ones appear when
        // there is room, and the whole line is always in the title.
        <p className="flex shrink-0 items-center gap-2 text-fg-dim" role="status" title={noticeTitle(offlineNotice)}>
          <Pip tone="info" />
          <NoticeText pieces={noticePieces(offlineNotice)} />
        </p>
      ) : null}
      {interrupted && interrupted.count > 0 ? (
        <button
          type="button"
          className="flex shrink-0 items-center gap-2 text-fg hover:underline"
          title="A work order was interrupted: some files are in its backup. Open History to recover them."
          onClick={interrupted.onOpen}
        >
          <Pip tone="error" />
          <NoticeText
            pieces={[
              { text: interrupted.count === 1 ? 'interrupted work order' : `${formatInt(interrupted.count)} interrupted work orders` },
              { text: ' — recover in History', optional: true },
            ]}
          />
        </button>
      ) : null}
    </div>
  );
}

function noticeTitle(n: string | readonly NoticePiece[]): string {
  return typeof n === 'string' ? n : n.map((p) => p.text).join('');
}

/** A string notice: what follows ` — ` is optional. */
function noticePieces(n: string | readonly NoticePiece[]): readonly NoticePiece[] {
  if (typeof n !== 'string') return n;
  const cut = n.indexOf(' — ');
  return cut < 0 ? [{ text: n }] : [{ text: n.slice(0, cut) }, { text: n.slice(cut), optional: true }];
}

function NoticeText({ pieces }: { pieces: readonly NoticePiece[] }) {
  return (
    <span className="whitespace-nowrap">
      {pieces.map((p, i) =>
        p.optional ? (
          <span key={i} className="hidden @min-[860px]:inline">
            {p.text}
          </span>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </span>
  );
}
