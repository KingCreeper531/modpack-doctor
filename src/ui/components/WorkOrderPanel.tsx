/**
 * Work order (DESIGN.md §6.4): a panel that replaces the workspace bottom section, never a modal.
 * A numbered mono checklist of the exact file operations with a live status column, then a footer
 * with the backup location, Cancel and Execute (ink). Never a generic "Are you sure?".
 *
 * Keyboard: Esc cancels (or closes a finished order). Enter executes only for an undo of exactly
 * one rename (`enterExecutes`), and Execute then shows a `↵` hint. Everything else needs a click
 * or Tab + Space on Execute. With `autoFocus`, focus moves into the panel when it opens and
 * whenever the focused control goes away (Execute disables while running, Close replaces it), so
 * the keyboard rules apply without a click.
 *
 * Around the checklist: a warning line when `game_running` said Minecraft runs (Execute stays
 * enabled: Rust checks again and refuses), the execute refusal (`gameRunning` reads "Close
 * Minecraft first: …"; an expired order offers Plan again), and once finished the outcome line
 * (done, or the failed op's message and whether the completed ops were rolled back).
 */
import './motion.css';

import { useEffect, useRef, type ReactNode } from 'react';

import type { AppError, GameStatus, OpState, OpStatus, WorkOrder } from '../../bindings';
import { Button } from './Button';
import { cx } from './cx';
import { ErrorRow } from './ErrorRow';
import { opNumber, plural } from './format';
import { Panel } from './Panel';
import { RAIL_BG } from './Severity';
import { describeOp, enterExecutes, orderOutcome, refusalText } from './workOrderModel';

export type WorkOrderPhase = 'review' | 'running' | 'finished';

export interface WorkOrderPanelProps {
  order: WorkOrder;
  /** Latest status per op (by `index`); missing ops are `pending`. */
  statuses?: readonly OpStatus[];
  phase?: WorkOrderPhase;
  /** A failure triggered automatic rollback of completed ops. */
  rolledBack?: boolean;
  /** `game_running` before Execute was shown (null: unknown). */
  game?: GameStatus | null;
  /** Why the last Execute was refused. */
  error?: AppError | null;
  /** The order expired in Rust: Execute is gone for good, Plan again replaces it. */
  expired?: boolean;
  /** A Plan again is in flight. */
  replanning?: boolean;
  onPlanAgain?: () => void;
  /** Move focus into the panel (see the module docs). */
  autoFocus?: boolean;
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

function StatusCell({ state, reversed }: { state: OpState; reversed: boolean }) {
  return (
    <span className={cx('flex items-center justify-end gap-2 t-mono', reversed ? 'text-fg-dim' : STATE_TEXT[state])}>
      {state === 'running' ? (
        <span aria-hidden className="md-op-bar">
          <span />
        </span>
      ) : null}
      {reversed ? 'rolled back' : state}
    </span>
  );
}

/** A one-line reading with a 4px rail (warning or outcome), aligned with the error rows. */
function Line({ tone, code, children, role }: { tone: 'warning' | 'ok' | 'error'; code: string; children: ReactNode; role: 'status' | 'alert' }) {
  return (
    <div role={role} className="flex min-h-8 shrink-0 items-stretch border-b border-line bg-panel">
      <span aria-hidden className={cx('w-1 shrink-0', tone === 'ok' ? 'bg-ok-fill' : RAIL_BG[tone])} />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-4 py-1 pr-2 pl-4">
        <span className={cx('w-24 shrink-0 t-mono', tone === 'ok' ? 'text-ok' : tone === 'warning' ? 'text-signal' : 'text-err-text')}>{code}</span>
        <span className="min-w-[50%] flex-1 t-body text-fg">{children}</span>
      </div>
    </div>
  );
}

export function WorkOrderPanel({
  order,
  statuses = [],
  phase = 'review',
  rolledBack = false,
  game = null,
  error = null,
  expired = false,
  replanning = false,
  onPlanAgain,
  autoFocus = false,
  onExecute,
  onCancel,
  className,
}: WorkOrderPanelProps) {
  const byIndex = new Map(statuses.map((s) => [s.index, s]));
  const enter = enterExecutes(order) && !expired;
  const counts = { done: 0, failed: 0, skipped: 0 };
  for (const s of statuses) if (s.state in counts) counts[s.state as keyof typeof counts]++;
  const finished = phase === 'finished';
  const outcome = finished ? orderOutcome(order, statuses, rolledBack) : null;
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const lost = !active || !el?.contains(active) || (active instanceof HTMLButtonElement && active.disabled);
    if (el && lost) el.focus({ preventScroll: true });
  }, [autoFocus, order.id, phase, expired]);

  return (
    <Panel
      ref={ref}
      legend={`Work order #${order.id}`}
      meta={`${order.kind} · ${plural(order.ops.length, 'op')}`}
      flush
      className={cx('focus-visible:outline-1 focus-visible:-outline-offset-1', className)}
      bodyClassName="flex min-h-0 flex-col"
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
      <div className="flex h-8 shrink-0 items-center border-b border-line px-4 t-body text-fg">{order.title}</div>
      {game?.running && !finished && error?.kind !== 'gameRunning' ? (
        <Line tone="warning" code="game running" role="status">
          Minecraft is running{game.reason ? ` (${game.reason})` : ''}. Close it before you execute: Modpack Doctor changes no file while the
          game runs.
        </Line>
      ) : null}
      {error && !finished ? (
        <ErrorRow
          error={refusalText(error)}
          action={
            expired && onPlanAgain ? (
              <Button size={24} onClick={onPlanAgain} disabled={replanning}>
                {replanning ? 'Planning…' : 'Plan again'}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {/* Only the checklist scrolls: the refusal above and the outcome and buttons below stay in view. */}
      <div className="-mb-px min-h-0 flex-1 overflow-y-auto">
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
                <StatusCell state={state} reversed={finished && rolledBack && state === 'done'} />
              </li>
            );
          })}
        </ol>
        {order.notes.map((n, i) => (
          <div key={i} className="grid min-h-6 grid-cols-[104px_minmax(0,1fr)_112px] items-baseline border-b border-line px-4 py-1 t-mono">
            <span className="t-label text-fg-faint">note</span>
            <span className="text-fg-dim">{n}</span>
          </div>
        ))}
      </div>
      <div className="relative shrink-0 border-t border-line bg-panel">
        {outcome ? (
          <Line tone={outcome.ok ? 'ok' : 'error'} code={outcome.ok ? 'done' : rolledBack ? 'rolled back' : 'failed'} role={outcome.ok ? 'status' : 'alert'}>
            {outcome.text}
          </Line>
        ) : null}
        <footer className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <span className="t-label text-fg-faint">backup</span>
          <span className="min-w-0 flex-1 truncate t-mono text-fg-dim" title={order.backupDir}>
            {order.backupDir}
          </span>
          {finished ? (
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
              <Button
                variant="primary"
                onClick={onExecute}
                // A focused native button turns Enter into a click. Only the single-rename undo may
                // run that way (§6.4); every other order needs a click or Space.
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !enter) e.preventDefault();
                }}
                disabled={phase === 'running' || expired || replanning}
                {...(enter ? { hint: '↵' } : {})}
              >
                {phase === 'running' ? 'Executing' : 'Execute'}
              </Button>
            </>
          )}
        </footer>
      </div>
    </Panel>
  );
}
