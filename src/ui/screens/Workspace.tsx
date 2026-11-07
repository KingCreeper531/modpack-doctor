/**
 * Workspace (DESIGN.md §5): instance heading + summary strip, then the scan grid, the triage
 * list and the mod table (or an open work order in its place, §6.4).
 */
import { ArrowClockwise, SidebarSimple } from '@phosphor-icons/react';
import { useMemo } from 'react';

import type { Instance } from '../../bindings';
import { Button } from '../components/Button';
import { ErrorRow } from '../components/ErrorRow';
import { SummaryStrip } from '../components/SummaryStrip';
import { Toggle } from '../components/Toggle';
import { WorkOrderPanel } from '../components/WorkOrderPanel';
import { severityCounts } from '../app/derive';
import { noticeParts } from '../app/modrinthState';
import { useActions, useApp, useAppShallow } from '../app/StoreContext';
import { useInspectorIsDrawer } from './drawer';
import { useNow } from './hooks';
import { ModsPanel } from './ModsPanel';
import { ScanPanel } from './ScanPanel';
import { TriagePanel } from './TriagePanel';

function Summary({ instance }: { instance: Instance }) {
  const s = useAppShallow((st) => {
    const sc = st.scans[instance.id];
    return {
      status: sc?.status ?? 'idle',
      done: sc?.done ?? 0,
      total: sc?.total ?? 0,
      findings: sc?.findings,
      pack: sc?.pack ?? null,
      finishedAt: sc?.finishedAt ?? null,
      result: sc?.result ?? null,
      stubCount: sc?.stubs.length ?? 0,
      unavailable: sc?.error?.kind === 'unavailable',
    };
  });
  const modrinthEnabled = useApp((st) => st.settings.modrinthEnabled);
  const notice = useApp((st) => st.modrinth[instance.id]?.notice ?? null);
  const retryAt = notice?.kind === 'rateLimited' ? notice.retryAt : null;
  const now = useNow(1000, s.status === 'done' || retryAt !== null, retryAt);
  const noticeLine = modrinthEnabled ? noticeParts(notice, now) : null;
  const counts = useMemo(() => severityCounts(s.findings ?? []), [s.findings]);
  const modCount = s.result ? s.result.jars.filter((j) => j.depth === 0).length : s.stubCount || instance.modCount;
  return (
    <SummaryStrip
      mcVersion={s.pack?.mcVersion ?? instance.mcVersion}
      loader={s.pack?.loader ?? instance.loader}
      modCount={modCount}
      {...(s.status === 'done' ? { counts } : {})}
      {...(s.status === 'done' && s.finishedAt !== null ? { scannedAgoMs: now - s.finishedAt } : {})}
      scanning={s.status === 'scanning' ? { done: s.done, total: s.total } : null}
      failed={s.status === 'error' && !s.unavailable}
      offline={noticeLine !== null}
      {...(noticeLine ? { offlineNotice: noticeLine } : {})}
      modrinthOff={!modrinthEnabled}
    />
  );
}

function Header({ instance }: { instance: Instance }) {
  const scanning = useApp((s) => s.scans[instance.id]?.status === 'scanning');
  const queued = useApp((s) => !!s.rescanQueued[instance.id]);
  const drawer = useInspectorIsDrawer();
  const inspectorOpen = useApp((s) => s.inspectorOpen);
  const a = useActions();
  return (
    <header className="shrink-0 border-b border-line bg-panel px-4 pt-2">
      <div className="flex h-6 min-w-0 items-center gap-4">
        <h1 className="min-w-0 shrink truncate t-head text-fg">{instance.name}</h1>
        <span className="min-w-0 flex-1 truncate t-mono text-fg-faint" title={instance.root}>
          {instance.root}
        </span>
        {/* A .mrpack file has no game folder: nothing runs, so there is nothing to watch. */}
        {instance.launcher === 'mrpack' ? null : <WatchToggle instanceId={instance.id} />}
        {/* While a scan runs, a click queues exactly one more (it would otherwise be dropped). */}
        <Button size={24} icon={<ArrowClockwise size={16} />} disabled={queued} onClick={() => void a.scan(instance.id)}>
          {queued ? 'Rescan queued' : scanning ? 'Rescan after this' : 'Rescan'}
        </Button>
        {drawer ? (
          <Button
            size={24}
            icon={<SidebarSimple size={16} mirrored />}
            aria-expanded={inspectorOpen}
            onClick={() => a.setInspectorOpen(!inspectorOpen)}
          >
            Inspector
          </Button>
        ) : null}
      </div>
      <Summary instance={instance} />
    </header>
  );
}

/**
 * Live watch mode (M4): `set_watch` with the tiered crash anchors; Rust persists it in
 * `Settings.watched`. Small and labelled, in the instance header. Not shown for a .mrpack.
 */
function WatchToggle({ instanceId }: { instanceId: string }) {
  const on = useApp((s) => s.settings.watched.includes(instanceId));
  const pending = useApp((s) => !!s.watchPending[instanceId]);
  const a = useActions();
  return (
    <Toggle
      on={on}
      text="Watch for crashes"
      label="Watch for crashes"
      disabled={pending}
      onChange={(next) => void a.setWatch(instanceId, next)}
      className="shrink-0"
    />
  );
}

function WatchError({ instanceId }: { instanceId: string }) {
  const error = useApp((s) => s.watchErrors[instanceId] ?? null);
  if (!error) return null;
  return <ErrorRow error={error} className="shrink-0" />;
}

/** The open work order in place of the mod table (§6.4); it stays until Cancel or Close. */
function OrderPanel() {
  const order = useApp((s) => s.order);
  const a = useActions();
  if (!order) return null;
  return (
    <div className="flex min-h-40 flex-1 flex-col">
      <WorkOrderPanel
        className="min-h-0 flex-1"
        order={order.order}
        statuses={order.statuses}
        phase={order.phase}
        rolledBack={order.rolledBack}
        game={order.game}
        error={order.error}
        expired={order.expired}
        replanning={order.replanning}
        onPlanAgain={() => void a.planAgain()}
        autoFocus
        onExecute={() => void a.executeOrder()}
        onCancel={() => void a.cancelOrder()}
      />
    </div>
  );
}

export function Workspace({ instanceId }: { instanceId: string }) {
  const instance = useApp((s) => s.discovery?.instances.find((i) => i.id === instanceId) ?? null);
  const orderOpen = useApp((s) => s.order?.instanceId === instanceId);
  if (!instance) return null;
  return (
    <>
      <Header instance={instance} />
      <WatchError instanceId={instanceId} />
      <ScanPanel instanceId={instanceId} className="shrink-0 border-b border-line" />
      {/* An open work order is the task at hand: the findings panel gives it room (a third). */}
      <TriagePanel key={instanceId} instanceId={instanceId} compact={orderOpen} className="min-h-24 shrink border-b border-line" />
      {orderOpen ? <OrderPanel /> : <ModsPanel instanceId={instanceId} className="min-h-40 flex-1" />}
    </>
  );
}
