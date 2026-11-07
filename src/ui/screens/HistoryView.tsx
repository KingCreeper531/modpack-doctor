/**
 * HISTORY (M6): the instance's backup snapshots (`list_backups`), newest first, as ruled rows in
 * the findings panel's third legend. Each snapshot is a header row (local time, the order's
 * title, age, "Undo all remaining") over its actions: number, label, the file operations it ran
 * in mono, and per action either an `undone` mark or an Undo button. Undo plans a work order
 * (`plan_undo`) that opens in the work-order panel below like any fix; a refusal (the file changed
 * since the fix) renders inline under the action it was asked for.
 *
 * Placement: a tab next to FINDINGS and CRASHES rather than a fourth stacked panel or a part of
 * the mods panel. The work-order panel replaces the mods panel (§6.4), so history placed there
 * would vanish exactly when an undo opens; as a legend of the findings panel it stays visible
 * above the undo order it started, keeps the §5 order of the workspace and fits 960×600.
 */
import { useMemo } from 'react';

import type { BackupEntry } from '../../bindings';
import { Button } from '../components/Button';
import { cx } from '../components/cx';
import { ErrorRow } from '../components/ErrorRow';
import { formatAgo, formatStamp, opNumber } from '../components/format';
import { appliedActionLabel } from '../components/labels';
import { describeOp } from '../components/workOrderModel';
import { undoKey } from '../app/store';
import { useActions, useApp } from '../app/StoreContext';
import { useNow } from './hooks';

/** An undo refusal scrolls into view when it appears (it may sit below the panel's fold). */
const reveal = (el: HTMLElement | null) => el?.scrollIntoView?.({ block: 'nearest' });

/** Actions of an entry not undone yet. */
export function remainingActions(entry: Pick<BackupEntry, 'actions' | 'undoneActions'>): number[] {
  return entry.actions.map((_, i) => i).filter((i) => !entry.undoneActions.includes(i));
}

function Entry({ entry, now }: { entry: BackupEntry; now: number }) {
  const undoErrors = useApp((s) => s.undoErrors);
  const undoPending = useApp((s) => s.undoPending);
  const orderOpen = useApp((s) => s.order !== null);
  const a = useActions();
  const remaining = remainingActions(entry);
  const allKey = undoKey(entry.id, null);
  const allError = undoErrors[allKey];
  const busy = orderOpen || Object.keys(undoPending).some((k) => k.startsWith(`${entry.id}#`));

  return (
    <div role="listitem" aria-label={`${formatStamp(entry.createdAtMs)} ${entry.title}`} className="border-b border-line">
      <div className="grid min-h-8 grid-cols-[144px_minmax(0,1fr)_auto] items-center gap-x-4 bg-raised px-4">
        <time className="t-mono text-fg-dim" dateTime={new Date(entry.createdAtMs).toISOString()} title={`backup ${entry.id}`}>
          {formatStamp(entry.createdAtMs)}
        </time>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate t-body text-fg" title={entry.title}>
            {entry.title}
          </span>
          <span className="shrink-0 t-mono text-fg-faint">{formatAgo(now - entry.createdAtMs)}</span>
        </span>
        {remaining.length > 1 ? (
          <Button size={24} disabled={busy} onClick={() => void a.undo(entry.id, null)}>
            Undo all remaining
          </Button>
        ) : remaining.length === 0 ? (
          <span className="t-mono text-fg-faint">all undone</span>
        ) : (
          <span />
        )}
      </div>
      {allError ? (
        <ErrorRow
          ref={reveal}
          error={allError}
          action={
            <Button size={24} onClick={() => a.dismissUndoError(allKey)}>
              Dismiss
            </Button>
          }
        />
      ) : null}
      <ol aria-label="Actions">
        {entry.actions.map((action, i) => {
          const ops = entry.ops.filter((o) => o.actionIndex === i).map((o) => o.op);
          const undone = entry.undoneActions.includes(i);
          const key = undoKey(entry.id, [i]);
          const error = undoErrors[key];
          return (
            <li key={i} className="border-t border-line">
              <div className="grid min-h-6 grid-cols-[144px_minmax(0,1fr)_auto] items-start gap-x-4 px-4 py-1">
                <span className="t-mono text-fg-faint">{opNumber(i)}</span>
                <span className="min-w-0">
                  <span className={cx('block t-body', undone ? 'text-fg-dim' : 'text-fg')}>{appliedActionLabel(action, ops)}</span>
                  {ops.map((op, k) => {
                    const line = describeOp(op);
                    const text = `${line.verb} ${line.subject}${line.target ? ` → ${line.target}` : ''}`;
                    return (
                      <span key={k} className="block truncate t-mono text-fg-faint" title={text}>
                        {text}
                      </span>
                    );
                  })}
                </span>
                {undone ? (
                  <span className="t-mono text-fg-faint">undone</span>
                ) : action.kind === 'manual' ? (
                  <span />
                ) : (
                  <Button size={24} disabled={busy} onClick={() => void a.undo(entry.id, [i])}>
                    Undo
                  </Button>
                )}
              </div>
              {error ? (
                <ErrorRow
                  ref={reveal}
                  error={error}
                  className="border-t"
                  action={
                    <Button size={24} onClick={() => a.dismissUndoError(key)}>
                      Dismiss
                    </Button>
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function HistoryView({ instanceId }: { instanceId: string }) {
  const h = useApp((s) => s.history[instanceId]);
  const a = useActions();
  const entries = useMemo(() => h?.entries ?? [], [h]);
  const now = useNow(60_000, entries.length > 0);

  if (h?.status === 'error' && h.error) {
    return (
      <ErrorRow
        error={h.error}
        action={
          <Button size={24} onClick={() => void a.loadBackups(instanceId)}>
            Retry
          </Button>
        }
      />
    );
  }
  if (!entries.length) {
    const loading = !h || h.status === 'idle' || h.status === 'loading';
    return (
      <p className="flex min-h-8 items-center px-4 py-1 t-small text-fg-faint" role="status">
        {loading
          ? 'Loading the backup history…'
          : 'No work order has run for this instance yet. Each one that runs is listed here with its backup, and every action can be undone.'}
      </p>
    );
  }
  return (
    <div role="list" aria-label="Backup history">
      {entries.map((e) => (
        <Entry key={e.id} entry={e} now={now} />
      ))}
    </div>
  );
}
