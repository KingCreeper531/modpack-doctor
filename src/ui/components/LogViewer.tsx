/**
 * Evidence / log viewer (DESIGN.md §6.3). Mono `t-log`; right-aligned line numbers in a gutter
 * with a 1px `line` rule; culprit lines on the `hl-line` wash with a 2px `signal` marker.
 * Per §2, on a culprit row the number is `fg-dim` and the text `fg` (`fg-faint` and `err-text`
 * fail on the wash); context rows are `fg-faint` / `fg-dim`. Frames mapped to a jar get a chip.
 *
 * Long logs (a whole digest is up to 6,000 lines) are virtualised: past `VIRTUAL_ROWS` rows only
 * the visible window (plus overscan) is in the DOM. Every row, gap rows included, is exactly
 * 18px (`t-log` line height), so positions are arithmetic. The scroll width is fixed from the
 * longest line so it doesn't change while scrolling.
 */
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef } from 'react';

import type { FrameRef, LogLine } from '../../core/model';
import { Chip } from './Chip';
import { cx } from './cx';
import { formatInt } from './format';
import { buildLogRows, gutterChars, type LogRow } from './logModel';

/** Row count above which the viewer renders only the visible window. */
export const VIRTUAL_ROWS = 400;
const ROW_PX = 18;

export interface LogViewerProps {
  lines: readonly LogLine[];
  frames?: readonly FrameRef[];
  /** When known, elided head/tail ranges show as dividers too. */
  totalLines?: number;
  /** Chip text for a jar id (mod name or file name). */
  jarLabel?: (jarId: string) => string;
  onJarClick?: (jarId: string) => void;
  /** Cap the viewer height; it scrolls inside. */
  maxHeight?: number;
  /**
   * Bring this line number into view (centred) when the request changes: a new line, or a new
   * `scrollRequest` for the same line. New `lines` alone (a re-analysis) never scroll.
   */
  scrollToLine?: number | null;
  /** Bump to ask for `scrollToLine` again (e.g. every "Show in log" click). */
  scrollRequest?: number;
  label?: string;
  className?: string;
}

interface RowProps {
  row: LogRow;
  gutter: { width: string };
  jarLabel?: ((jarId: string) => string) | undefined;
  onJarClick?: ((jarId: string) => void) | undefined;
  fixed: boolean;
}

function Row({ row: r, gutter, jarLabel, onJarClick, fixed }: RowProps) {
  if (r.kind === 'gap') {
    return (
      <div className={cx('flex border-y border-line', fixed && 'h-[18px]')}>
        <span aria-hidden className="shrink-0 border-r border-line" style={gutter} />
        <span className={cx('px-2 text-fg-faint', fixed && 'leading-4')}>
          ⋯ {formatInt(r.count)} {r.count === 1 ? 'line' : 'lines'}
        </span>
      </div>
    );
  }
  return (
    <div className={cx('relative flex', r.culprit && 'bg-hl-line', fixed && 'h-[18px]')} data-line={r.n}>
      {r.culprit ? <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-signal" /> : null}
      <span
        className={cx('shrink-0 border-r border-line pr-2 text-right select-none', r.culprit ? 'text-fg-dim' : 'text-fg-faint')}
        style={gutter}
      >
        {r.n}
      </span>
      <span className={cx('flex items-center gap-2 pr-4 pl-2 whitespace-pre', r.culprit ? 'text-fg' : 'text-fg-dim')}>
        <span>{r.text || ' '}</span>
        {r.jarIds.map((id) => (
          <Chip key={id} title={id} {...(onJarClick ? { onClick: () => onJarClick(id) } : {})}>
            {jarLabel ? jarLabel(id) : id}
          </Chip>
        ))}
      </span>
      {r.culprit ? <span className="sr-only">(culprit line)</span> : null}
    </div>
  );
}

/**
 * Runs `scroll` once per scroll request (`line` + `request`), not when the rows change. A
 * request whose line is not among the rows yet stays pending until it is (`scroll` → false).
 */
function useScrollRequest(line: number | null | undefined, request: number | undefined, scroll: (line: number) => boolean) {
  const handled = useRef<string | null>(null);
  const key = line === null || line === undefined ? null : `${request ?? 0}:${line}`;
  // No dependency list on purpose: a cheap key comparison after each render, so the request is
  // honoured as soon as its line is rendered, and only once.
  useEffect(() => {
    if (key === null || line === null || line === undefined || handled.current === key) return;
    if (scroll(line)) handled.current = key;
  });
}

function VirtualRows({ rows, gutter, gutterWidth, jarLabel, onJarClick, maxHeight, scrollToLine, scrollRequest, label, className }: {
  rows: LogRow[];
  gutter: { width: string };
  gutterWidth: number;
  jarLabel?: ((jarId: string) => string) | undefined;
  onJarClick?: ((jarId: string) => void) | undefined;
  maxHeight?: number | undefined;
  scrollToLine?: number | null | undefined;
  scrollRequest?: number | undefined;
  label: string;
  className?: string | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fallback = maxHeight ?? 720;
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => ROW_PX,
    overscan: 24,
    // Render a screenful before the virtualizer's own observer reports the real size, and keep
    // one while the viewer has no layout yet (a collapsed row, a hidden pane): never zero rows.
    initialRect: { width: 0, height: fallback },
    observeElementRect: (instance, cb) => observeElementRect(instance, (rect) => cb(rect.height > 0 ? rect : { width: rect.width, height: fallback })),
  });
  // Widest row in characters (+ chips, roughly) fixes the scroll width.
  const widthCh = useMemo(() => {
    let max = 0;
    for (const r of rows) if (r.kind === 'line') max = Math.max(max, r.text.length + r.jarIds.reduce((n, id) => n + (jarLabel ? jarLabel(id) : id).length + 3, 0));
    return max + gutterWidth + 6;
  }, [rows, gutterWidth, jarLabel]);
  useScrollRequest(scrollToLine, scrollRequest, (line) => {
    const i = rows.findIndex((r) => r.kind === 'line' && r.n >= line);
    if (i < 0) return false;
    virtual.scrollToIndex(i, { align: 'center' });
    return true;
  });
  const items = virtual.getVirtualItems();
  return (
    <div
      ref={ref}
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cx('overflow-auto border border-line bg-bg t-log', className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <div className="relative" style={{ height: virtual.getTotalSize(), minWidth: `max(100%, ${widthCh}ch)` }}>
        <div style={{ transform: `translateY(${items[0]?.start ?? 0}px)` }}>
          {items.map((v) => (
            <Row key={v.key} row={rows[v.index]!} gutter={gutter} jarLabel={jarLabel} onJarClick={onJarClick} fixed />
          ))}
        </div>
      </div>
    </div>
  );
}

export function LogViewer({ lines, frames = [], totalLines, jarLabel, onJarClick, maxHeight, scrollToLine, scrollRequest, label, className }: LogViewerProps) {
  const rows = useMemo(() => buildLogRows(lines, frames, totalLines), [lines, frames, totalLines]);
  const chars = gutterChars(rows) + 2;
  const gutter = { width: `${chars}ch` };
  const name = label ?? 'Log excerpt';
  const ref = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUAL_ROWS;
  useScrollRequest(virtual ? null : scrollToLine, scrollRequest, (line) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (!el) return false;
    el.scrollIntoView?.({ block: 'center' });
    return true;
  });
  if (virtual) {
    return (
      <VirtualRows
        rows={rows}
        gutter={gutter}
        gutterWidth={chars}
        jarLabel={jarLabel}
        onJarClick={onJarClick}
        maxHeight={maxHeight}
        scrollToLine={scrollToLine}
        scrollRequest={scrollRequest}
        label={name}
        className={className}
      />
    );
  }
  return (
    <div
      ref={ref}
      role="region"
      aria-label={name}
      tabIndex={0}
      className={cx('overflow-auto border border-line bg-bg t-log', className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <div className="w-max min-w-full py-1">
        {rows.map((r, i) => (
          <Row key={r.kind === 'gap' ? `gap-${i}` : r.n} row={r} gutter={gutter} jarLabel={jarLabel} onJarClick={onJarClick} fixed={false} />
        ))}
      </div>
    </div>
  );
}
