/**
 * Evidence / log viewer (DESIGN.md §6.3). Mono `t-log`; right-aligned line numbers in a gutter
 * with a 1px `line` rule; culprit lines on the `hl-line` wash with a 2px `signal` marker.
 * Per §2, on a culprit row the number is `fg-dim` and the text `fg` (`fg-faint` and `err-text`
 * fail on the wash); context rows are `fg-faint` / `fg-dim`. Frames mapped to a jar get a chip.
 */
import type { FrameRef, LogLine } from '../../core/model';
import { Chip } from './Chip';
import { cx } from './cx';
import { formatInt } from './format';
import { buildLogRows, gutterChars } from './logModel';

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
  label?: string;
  className?: string;
}

export function LogViewer({ lines, frames = [], totalLines, jarLabel, onJarClick, maxHeight, label, className }: LogViewerProps) {
  const rows = buildLogRows(lines, frames, totalLines);
  const gutter = { width: `${gutterChars(rows) + 2}ch` };
  return (
    <div
      role="region"
      aria-label={label ?? 'Log excerpt'}
      tabIndex={0}
      className={cx('overflow-auto border border-line bg-bg t-log', className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <div className="w-max min-w-full py-1">
        {rows.map((r, i) =>
          r.kind === 'gap' ? (
            <div key={`gap-${i}`} className="flex border-y border-line">
              <span aria-hidden className="shrink-0 border-r border-line" style={gutter} />
              <span className="px-2 text-fg-faint">
                ⋯ {formatInt(r.count)} {r.count === 1 ? 'line' : 'lines'}
              </span>
            </div>
          ) : (
            <div key={r.n} className={cx('relative flex', r.culprit && 'bg-hl-line')}>
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
          ),
        )}
      </div>
    </div>
  );
}
