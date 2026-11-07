/**
 * MODS panel (DESIGN.md §6.6): the virtualised mod table filling the rest of the workspace.
 * Sorting is per instance (in memory). The enable toggle plans a work order like any fix; a
 * refusal renders as an inline error row above the table. The Modrinth column and icons come
 * from the instance's Modrinth context (M5); "Refresh Modrinth" looks every jar up again.
 */
import { ArrowClockwise } from '@phosphor-icons/react';
import { useMemo } from 'react';

import type { AppError } from '../../bindings';
import { Button } from '../components/Button';
import { ErrorRow } from '../components/ErrorRow';
import { basename, formatInt } from '../components/format';
import { ModTable } from '../components/ModTable';
import { Panel } from '../components/Panel';
import { jarMatch } from '../../core/modrinth';
import { deriveModRows } from '../app/derive';
import { iconConverter } from '../app/external';
import { modrinthRowView, viewContext } from '../app/modrinthState';
import { emptyScan } from '../app/scanState';
import { useActions, useApp, useAppShallow } from '../app/StoreContext';

/** The most recent enable/disable refusal, if any. */
function toggleError(errors: Readonly<Record<string, AppError>>): [string, AppError] | null {
  const keys = Object.keys(errors).filter((k) => k.startsWith('jar:'));
  const last = keys[keys.length - 1];
  return last ? [last.slice(4), errors[last]!] : null;
}

export function ModsPanel({ instanceId, className }: { instanceId: string; className?: string }) {
  const s = useAppShallow((st) => {
    const sc = st.scans[instanceId];
    return { stubs: sc?.stubs, result: sc?.result ?? null, findings: sc?.findings, status: sc?.status ?? 'idle' };
  });
  const sort = useApp((st) => st.modSort[instanceId] ?? null);
  const selection = useApp((st) => st.selection);
  const reveal = useApp((st) => st.revealJarId);
  const fixErrors = useApp((st) => st.fixErrors);
  const mr = useApp((st) => st.modrinth[instanceId]);
  const modrinthOn = useApp((st) => st.settings.modrinthEnabled);
  const backendKind = useApp((st) => st.backendKind);
  const a = useActions();

  const ctx = viewContext(mr, s.result);
  const rows = useMemo(
    () =>
      deriveModRows(
        { ...emptyScan(), stubs: s.stubs ?? [], result: s.result, findings: s.findings ?? [], status: s.status },
        modrinthRowView({ jarMatch }, ctx, iconConverter(backendKind)),
      ),
    [s.stubs, s.result, s.findings, s.status, ctx, backendKind],
  );
  const looking = mr?.status === 'loading';
  const disabled = rows.filter((r) => !r.enabled).length;
  const err = toggleError(fixErrors);

  return (
    <Panel
      legend="Mods"
      meta={rows.length ? `${formatInt(rows.length)} jars · ${formatInt(disabled)} disabled` : undefined}
      actions={
        modrinthOn && s.status === 'done' ? (
          <Button size={24} icon={<ArrowClockwise size={16} />} disabled={looking} onClick={() => void a.refreshModrinth(instanceId)}>
            {looking ? 'Looking up on Modrinth…' : 'Refresh Modrinth'}
          </Button>
        ) : undefined
      }
      flush
      className={className}
      bodyClassName="flex min-h-0 flex-col"
    >
      {err ? (
        <ErrorRow
          error={{ ...err[1], path: err[1].path ?? basename(err[0]) }}
          action={
            <Button size={24} onClick={() => a.dismissFixError(`jar:${err[0]}`)}>
              Dismiss
            </Button>
          }
        />
      ) : null}
      <div className="min-h-0 flex-1">
        <ModTable
          rows={rows}
          sort={sort}
          onSort={(next) => a.setModSort(instanceId, next)}
          selectedId={selection?.kind === 'jar' ? selection.id : null}
          onSelect={(id) => a.select({ kind: 'jar', id })}
          onToggleEnabled={(id, next) => void a.setJarEnabled(id, next)}
          scrollToId={reveal}
          height="fill"
        />
      </div>
    </Panel>
  );
}
