/**
 * Work order (DESIGN.md §6.4): a panel that replaces the workspace bottom section, never a modal.
 * A numbered mono checklist of the exact file operations with a live status column, then a footer
 * with the backup location, Cancel and Execute (ink). Never a generic "Are you sure?".
 *
 * Keyboard: Esc cancels. Enter executes only for an undo of exactly one rename (`enterExecutes`),
 * and Execute then shows a `↵` hint. Everything else needs a click or Tab + Space on Execute.
 */
import './motion.css';

import type { OpState, OpStatus, WorkOrder } from '../../bindings';
import { Button } from './Button';
import { cx } from './cx';
import { opNumber, plural } from './format';
import { Panel } from './Panel';
import { describeOp, enterExecutes } from './workOrderModel';

export type WorkOrderPhase = 'review' | 'running' | 'finished';

export interface WorkOrderPanelProps {
  order: WorkOrder;
  /** Latest status per op (by `index`); missing ops are `pending`. */
  statuses?: readonly OpStatus[];
  phase?: WorkOrderPhase;
  /** A failure triggered automatic rollback of completed ops. */
  rolledBack?: boolean;
  onExecute: () => void;
  onCancel: () => void;
  className?: string;
}

const STATE_TEXT: Record<OpState, string> = {
  pending: 'text-fg-faint',
  running: 'text-signal',
  done: 'text-ok',
  failed: 'text-err-text',
  skipped: 'text-fg-faint',
};

function StatusCell({ state }: { state: OpState }) {
  return (
    <span className={cx('flex items-center justify-end gap-2 t-mono', STATE_TEXT[state])}>
      {state === 'running' ? (
        <span aria-hidden className="md-op-bar">
          <span />
        </span>
      ) : null}
      {state}
    </span>
  );
}

export function WorkOrderPanel({ order, statuses = [], phase = 'review', rolledBack = false, onExecute, onCancel, className }: WorkOrderPanelProps) {
  const byIndex = new Map(statuses.map((s) => [s.index, s]));
  const enter = enterExecutes(order);
  const counts = { done: 0, failed: 0, skipped: 0 };
  for (const s of statuses) if (s.state in counts) counts[s.state as keyof typeof counts]++;

  return (
    <Panel
      legend={`Work order #${order.id}`}
      meta={`${order.kind} · ${plural(order.ops.length, 'op')}`}
      flush
      className={className}
      aria-label={`Work order ${order.id}: ${order.title}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && phase !== 'running') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter' && enter && phase === 'review' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          onExecute();
        }
      }}
    >
      <div className="flex h-8 items-center border-b border-line px-4 t-body text-fg">{order.title}</div>
      <ol className="t-mono">
        {order.ops.map((planned, i) => {
          const line = describeOp(planned.op);
          const status = byIndex.get(i);
          const state = status?.state ?? 'pending';
          return (
            <li
              key={i}
              className={cx(
                'grid min-h-6 grid-cols-[32px_72px_minmax(0,1fr)_112px] items-start border-b border-line px-4 py-1',
                state === 'running' && 'bg-raised',
              )}
            >
              <span className="text-fg-faint">{opNumber(i)}</span>
              <span className="text-fg-dim">{line.verb}</span>
              <span className="min-w-0">
                <span className="break-all text-fg">{line.subject}</span>
                {line.target ? (
                  <>
                    <span className="text-fg-faint"> → </span>
                    <span className="break-all text-fg">{line.target}</span>
                  </>
                ) : null}
                {line.detail ? <span className="block text-fg-faint">{line.detail}</span> : null}
                {state === 'failed' && status?.message ? <span className="block text-err-text">{status.message}</span> : null}
              </span>
              <StatusCell state={state} />
            </li>
          );
        })}
      </ol>
      {order.notes.map((n, i) => (
        <div key={i} className="flex min-h-6 items-baseline gap-4 border-b border-line px-4 py-1 t-mono">
          <span className="w-[104px] shrink-0 t-label text-fg-faint">note</span>
          <span className="text-fg-dim">{n}</span>
        </div>
      ))}
      <footer className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
        <span className="t-label text-fg-faint">backup</span>
        <span className="min-w-0 flex-1 truncate t-mono text-fg-dim" title={order.backupDir}>
          {order.backupDir}
        </span>
        {phase === 'finished' ? (
          <>
            <span className="t-mono text-fg-dim">
              <span className="text-ok">{counts.done} done</span>
              {counts.failed ? <span className="text-err-text"> · {counts.failed} failed</span> : null}
              {counts.skipped ? <span> · {counts.skipped} skipped</span> : null}
              {rolledBack ? <span className="text-signal"> · rolled back</span> : null}
            </span>
            <Button onClick={onCancel}>Close</Button>
          </>
        ) : (
          <>
            <Button onClick={onCancel} disabled={phase === 'running'}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onExecute} disabled={phase === 'running'} {...(enter ? { hint: '↵' } : {})}>
              {phase === 'running' ? 'Executing' : 'Execute'}
            </Button>
          </>
        )}
      </footer>
    </Panel>
  );
}
