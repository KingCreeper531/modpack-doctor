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
import { jarMatch, planQueries } from '../../core/modrinth';
import { deriveModRows, derivePackRows } from '../app/derive';
import { modMenuFor } from '../app/rowMenus';
import { iconConverter } from '../app/external';
import { modrinthRowView, viewContext } from '../app/modrinthState';
import { emptyScan } from '../app/scanState';
import { useActions, useApp, useAppShallow } from '../app/StoreContext';
import { useRowMenu } from './hooks';

/** The most recent enable/disable refusal, if any. */
function toggleError(errors: Readonly<Record<string, AppError>>): [string, AppError] | null {
  const keys = Object.keys(errors).filter((k) => k.startsWith('jar:'));
  const last = keys[keys.length - 1];
  return last ? [last.slice(4), errors[last]!] : null;
}

export function ModsPanel({ instanceId, className }: { instanceId: string; className?: string }) {
  const s = useAppShallow((st) => {
    const sc = st.scans[instanceId];
    return { stubs: sc?.stubs, result: sc?.result ?? null, pack: sc?.pack ?? null, findings: sc?.findings, status: sc?.status ?? 'idle' };
  });
  const sort = useApp((st) => st.modSort[instanceId] ?? null);
  const selection = useApp((st) => st.selection);
  const reveal = useApp((st) => st.revealJarId);
  const fixErrors = useApp((st) => st.fixErrors);
  const mr = useApp((st) => st.modrinth[instanceId]);
  const modrinthOn = useApp((st) => st.settings.modrinthEnabled);
  const backendKind = useApp((st) => st.backendKind);
  // An opened .mrpack: override jars plus the index's declared files, read-only (no toggles).
  const pack = useApp((st) => st.discovery?.instances.find((i) => i.id === instanceId)?.launcher === 'mrpack');
  const a = useActions();
  const rowMenu = useRowMenu();

  const ctx = viewContext(mr, s.result);
  const icons = mr?.icons;
  const rows = useMemo(() => {
    const scan = { ...emptyScan(), stubs: s.stubs ?? [], result: s.result, findings: s.findings ?? [], status: s.status };
    const view = modrinthRowView({ jarMatch }, ctx, iconConverter(backendKind), icons);
    if (!pack) return deriveModRows(scan, view);
    // Which hashes the Modrinth lookup asked about: a declared file it never asked about is unknown.
    let queried: Set<string> | undefined;
    try {
      queried = s.result && s.pack ? new Set(planQueries(s.result, s.pack).identify) : undefined;
    } catch {
      queried = undefined;
    }
    return derivePackRows(scan, ctx, view, queried);
  }, [s.stubs, s.result, s.pack, s.findings, s.status, ctx, backendKind, icons, pack]);
  const declaredCount = pack ? (s.result?.declared.length ?? 0) : 0;
  const looking = mr?.status === 'loading';
  const disabled = rows.filter((r) => !r.enabled).length;
  const err = toggleError(fixErrors);

  return (
    <Panel
      legend="Mods"
      meta={
        rows.length
          ? pack
            ? `${formatInt(rows.length - declaredCount)} in zip · ${formatInt(declaredCount)} declared`
            : `${formatInt(rows.length)} jars · ${formatInt(disabled)} disabled`
          : undefined
      }
      actions={
        modrinthOn && s.status === 'done' ? (
          // Never disabled: a click while a lookup runs starts it over (bypassing every cache).
          <span className="flex items-center gap-2">
            {looking ? (
              <span role="status" className="t-small whitespace-nowrap text-fg-faint">
                looking up…
              </span>
            ) : null}
            <Button size={24} icon={<ArrowClockwise size={16} />} onClick={() => void a.refreshModrinth(instanceId)}>
              Refresh Modrinth
            </Button>
          </span>
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
          // Declared files are not in the zip: there is no jar to inspect.
          onSelect={(id) => (rows.some((r) => r.id === id && r.declared) ? undefined : a.select({ kind: 'jar', id }))}
          {...(pack ? {} : { onToggleEnabled: (id: string, next: boolean) => void a.setJarEnabled(id, next) })}
          onRowContextMenu={(id, e) => rowMenu(e, 'Mod', (st) => modMenuFor(st, id))}
          variant={pack ? 'pack' : 'instance'}
          scrollToId={reveal}
          height="fill"
        />
      </div>
    </Panel>
  );
}
