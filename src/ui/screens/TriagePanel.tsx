/**
 * FINDINGS panel (DESIGN.md §6.2), with three legends as tabs:
 * - FINDINGS: one triage row per static finding, sorted by the checks (severity, code, file).
 *   Click expands inline and shows the finding in the inspector; chips select the jar. Fix
 *   buttons go through `plan_work_order`; a refusal renders inline. Scan failures render as an
 *   error row with a Retry button (§10).
 * - CRASHES (M4): crash reports and logs and their crash findings (CrashesView.tsx).
 * - HISTORY (M6): backup snapshots of executed work orders and per-action undo (HistoryView.tsx).
 * Crash analysis lives here rather than in a fourth stacked panel so the workspace keeps the
 * §5 order (summary, scan grid, findings, mods) and still fits a 960×600 window.
 */
import { ArrowClockwise } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { FixAction } from '../../bindings';
import { Button } from '../components/Button';
import { cx } from '../components/cx';
import { ErrorRow, isUnavailable } from '../components/ErrorRow';
import { formatInt, plural } from '../components/format';
import { Panel, type PanelTab } from '../components/Panel';
import { Pip } from '../components/Severity';
import { TriageRow } from '../components/TriageRow';
import { severityCounts } from '../app/derive';
import { useActions, useApp, useAppShallow } from '../app/StoreContext';
import type { FindingsTab } from '../app/crashState';
import { CrashesView } from './CrashesView';
import { findingMenuFor } from '../app/rowMenus';
import { useFixBlock } from './fixHooks';
import { useFindingCursor, useRowMenu } from './hooks';
import { HistoryView, interruptedCount } from './HistoryView';
import { PackEditButtons } from './PackFix';
import { useFixVersions } from './modrinthHooks';

function StaticFindings({ instanceId }: { instanceId: string }) {
  const s = useAppShallow((st) => {
    const sc = st.scans[instanceId];
    return {
      status: sc?.status ?? 'idle',
      findings: sc?.findings,
      result: sc?.result ?? null,
      error: sc?.error ?? null,
      checksError: sc?.checksError ?? null,
    };
  });
  const selection = useApp((st) => st.selection);
  const fixErrors = useApp((st) => st.fixErrors);
  const fixErrorFrom = useApp((st) => st.fixErrorFrom);
  const fixPending = useApp((st) => st.fixPending);
  const orderOpen = useApp((st) => st.order !== null);
  const a = useActions();
  const expandRequest = useApp((st) => st.expandFindingId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(expandRequest ? [expandRequest] : []));
  const listRef = useRef<HTMLDivElement>(null);
  const versions = useFixVersions(instanceId);
  const blocked = useFixBlock(instanceId);
  // An opened .mrpack is read-only: its findings never offer a fix (CONTRACTS invariant 15).
  const pack = useApp((st) => st.discovery?.instances.find((i) => i.id === instanceId)?.launcher === 'mrpack');
  const rowMenu = useRowMenu();

  // A finding selected from outside the list (URL hook, later the palette) opens and scrolls in.
  useEffect(() => {
    if (!expandRequest) return;
    setExpanded((cur) => (cur.has(expandRequest) ? cur : new Set(cur).add(expandRequest)));
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-finding-id]') ?? [];
    const row = Array.from(rows).find((r) => r.dataset.findingId === expandRequest);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [expandRequest, s.findings]);

  const findings = useMemo(() => s.findings ?? [], [s.findings]);
  const jarNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const j of s.result?.jars ?? []) names[j.id] = j.fileName;
    return names;
  }, [s.result]);

  const toggle = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /** Click or Enter on the keyboard cursor: expand/collapse and show it in the inspector. */
  const open = (id: string) => {
    toggle(id);
    a.select({ kind: 'finding', id });
  };
  const ids = useMemo(() => findings.map((f) => f.id), [findings]);
  const cursor = useFindingCursor(listRef, ids, open);

  const topCount = s.result ? s.result.jars.filter((j) => j.depth === 0).length : 0;

  return (
    <>
      {s.error ? (
        <ErrorRow
          error={s.error}
          action={
            isUnavailable(s.error) ? undefined : (
              <Button size={24} onClick={() => void a.scan(instanceId)}>
                Retry
              </Button>
            )
          }
        />
      ) : null}
      {s.checksError ? <ErrorRow error={s.checksError} /> : null}
      {findings.length === 0 && !s.error ? (
        <p className="flex h-8 items-center px-4 t-small text-fg-faint" role="status">
          {s.status === 'done'
            ? `No problems found in ${plural(topCount, 'jar')}.`
            : s.status === 'scanning'
              ? 'Checks run when the scan finishes.'
              : 'Not scanned yet.'}
        </p>
      ) : null}
      {findings.length ? (
        <div ref={listRef} role="list" aria-label={`Findings, ${formatInt(findings.length)}`}>
          {findings.map((f) => (
            <div role="listitem" key={f.id} data-finding-id={f.id}>
              <TriageRow
                finding={f}
                expanded={expanded.has(f.id)}
                onToggle={() => {
                  a.setCursor(f.id);
                  open(f.id);
                }}
                focused={cursor === f.id}
                onContextMenu={(e) => rowMenu(e, `Finding ${f.code}`, (st) => findingMenuFor(st, f.id))}
                selected={selection?.kind === 'finding' && selection.id === f.id}
                jarNames={jarNames}
                fixVersions={versions}
                selectedJarId={selection?.kind === 'jar' ? selection.id : null}
                onJarClick={a.revealJar}
                {...(pack ? {} : { onFix: (fix: FixAction) => void a.fix(f.id, fix, 'triage') })}
                fixesDisabled={pack || orderOpen || !!fixPending[f.id] || blocked !== null}
                fixHint={blocked}
                // Shown once, next to the button that was pressed (the inspector shows its own).
                fixError={fixErrorFrom[f.id] === 'triage' ? (fixErrors[f.id] ?? null) : null}
                // An opened .mrpack: edits for its fixed copy instead (PackFix.tsx).
                packActions={pack && f.packEdits?.length ? <PackEditButtons instanceId={instanceId} finding={f} /> : null}
              />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

const TABS: readonly FindingsTab[] = ['findings', 'crashes', 'history'];

export function TriagePanel({ instanceId, className, compact = false }: { instanceId: string; className?: string; compact?: boolean }) {
  const stored = useApp((st) => st.findingsTab[instanceId] ?? 'findings');
  // A .mrpack is never changed, so it has no backups (no HISTORY legend); CRASHES stays and says
  // why a pack has no logs.
  const isPack = useApp((st) => st.discovery?.instances.find((i) => i.id === instanceId)?.launcher === 'mrpack');
  const tab: FindingsTab = isPack && stored === 'history' ? 'findings' : stored;
  const s = useAppShallow((st) => ({ status: st.scans[instanceId]?.status ?? 'idle', findings: st.scans[instanceId]?.findings }));
  const crash = useAppShallow((st) => {
    const c = st.crashes[instanceId];
    const sel = c?.selectedSourceId ? c.analyses[c.selectedSourceId] : undefined;
    return {
      status: c?.sourcesStatus ?? 'idle',
      count: c?.sources.length ?? 0,
      findings: sel?.status === 'done' ? sel.findings : undefined,
      alert: !!st.crashAlerts[instanceId],
    };
  });
  const history = useAppShallow((st) => ({
    status: st.history[instanceId]?.status ?? 'idle',
    count: st.history[instanceId]?.entries.length ?? 0,
    interrupted: interruptedCount(st.history[instanceId]?.entries),
  }));
  const a = useActions();
  const counts = useMemo(() => severityCounts(s.findings ?? []), [s.findings]);
  const crashCounts = useMemo(() => (crash.findings ? severityCounts(crash.findings) : null), [crash.findings]);
  const findingsMeta = s.status === 'done' || s.findings?.length ? `${counts.error} E · ${counts.warning} W · ${counts.info} I` : undefined;
  const historyMeta = history.status === 'done' ? plural(history.count, 'backup') : undefined;
  const crashMeta = crashCounts ? `${crashCounts.error} E · ${crashCounts.warning} W · ${crashCounts.info} I` : undefined;
  const allTabs: PanelTab[] = [
    { id: 'findings', label: 'Findings' },
    {
      id: 'crashes',
      label: 'Crashes',
      badge: (
        <>
          {crash.status === 'done' ? <span className={tab === 'crashes' ? 'text-fg-dim' : 'text-fg-faint'}>{formatInt(crash.count)}</span> : null}
          {crash.alert ? <Pip tone="error" label="new crash" /> : null}
        </>
      ),
    },
    {
      id: 'history',
      label: 'History',
      ...(history.status === 'done'
        ? {
            badge: (
              <>
                <span className={tab === 'history' ? 'text-fg-dim' : 'text-fg-faint'}>{formatInt(history.count)}</span>
                {history.interrupted ? <Pip tone="error" label="interrupted work order" /> : null}
              </>
            ),
          }
        : {}),
    },
  ];
  const tabs = isPack ? allTabs.filter((t) => t.id !== 'history') : allTabs;
  const panelId = `findings-panel-${instanceId}`;
  return (
    <Panel
      legend="Findings"
      tabs={tabs}
      tab={tab}
      onTab={(t) => a.setFindingsTab(instanceId, TABS.includes(t as FindingsTab) ? (t as FindingsTab) : 'findings')}
      tabPanelId={panelId}
      meta={tab === 'crashes' ? crashMeta : tab === 'history' ? historyMeta : findingsMeta}
      actions={
        tab === 'crashes' ? (
          <Button
            size={24}
            icon={<ArrowClockwise size={16} />}
            disabled={crash.status === 'loading'}
            onClick={() => void a.loadLogSources(instanceId)}
          >
            Refresh
          </Button>
        ) : tab === 'history' ? (
          <Button size={24} icon={<ArrowClockwise size={16} />} disabled={history.status === 'loading'} onClick={() => void a.loadBackups(instanceId)}>
            Refresh
          </Button>
        ) : undefined
      }
      flush
      className={cx(className, tab === 'crashes' ? (compact ? 'h-[30%]' : 'h-[45%]') : compact ? 'max-h-[30%]' : 'max-h-[45%]')}
      bodyClassName={tab === 'crashes' ? 'flex min-h-0 flex-col' : 'overflow-y-auto'}
    >
      {tab === 'crashes' ? (
        <CrashesView instanceId={instanceId} />
      ) : tab === 'history' ? (
        <HistoryView instanceId={instanceId} />
      ) : (
        <StaticFindings instanceId={instanceId} />
      )}
    </Panel>
  );
}
