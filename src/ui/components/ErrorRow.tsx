/**
 * Inline error row for an `AppError` from Rust (DESIGN.md §10): `err` rail, the kind code in
 * mono (`err-text`), the message, and the path concerned. Never a toast stack.
 *
 * `unavailable` is not a failure: the feature isn't in this build yet. It renders neutrally,
 * with an `info` rail, `fg-dim` text and `role="status"`, never the err rail.
 */
import type { ReactNode } from 'react';

import type { AppError } from '../../bindings';
import { cx } from './cx';

export interface ErrorRowProps {
  error: AppError;
  /** Optional trailing action, e.g. a Retry button. */
  action?: ReactNode;
  className?: string;
}

/** A feature this build doesn't have yet, as opposed to something that went wrong. */
export function isUnavailable(error: AppError | null | undefined): boolean {
  return error?.kind === 'unavailable';
}

export function ErrorRow({ error, action, className }: ErrorRowProps) {
  const neutral = isUnavailable(error);
  return (
    <div
      role={neutral ? 'status' : 'alert'}
      data-kind={error.kind}
      className={cx('flex min-h-8 items-stretch border-b border-line bg-panel', className)}
    >
      <span aria-hidden className={cx('w-1 shrink-0', neutral ? 'bg-info' : 'bg-err')} />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-4 py-1 pr-2 pl-4">
        <span className={cx('w-24 shrink-0 t-mono', neutral ? 'text-fg-dim' : 'text-err-text')}>{neutral ? 'not yet' : error.kind}</span>
        {/* The message never shrinks below half the row; a long path wraps under it instead. */}
        <span className={cx('min-w-[50%] flex-1 t-body', neutral ? 'text-fg-dim' : 'text-fg')}>{error.message}</span>
        {error.path ? (
          <span className="min-w-0 max-w-full truncate t-mono text-fg-dim" title={error.path}>
            {error.path}
          </span>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center pr-2">{action}</div> : null}
    </div>
  );
}
