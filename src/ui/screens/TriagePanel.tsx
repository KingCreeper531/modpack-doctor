/**
 * FINDINGS panel (DESIGN.md §6.2): one triage row per finding, sorted by the checks
 * (severity, code, file). Click expands inline and shows the finding in the inspector; chips
 * select the jar. Fix buttons go through `plan_work_order`; a refusal renders inline.
 * Scan failures render as an error row with a Retry button (§10).
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/Button';
import { ErrorRow, isUnavailable } from '../components/ErrorRow';
import { formatInt, plural } from '../components/format';
import { Panel } from '../components/Panel';
import { TriageRow } from '../components/TriageRow';
import { severityCounts } from '../app/derive';
import { useActions, useApp, useAppShallow } from '../app/StoreContext';

export function TriagePanel({ instanceId, className }: { instanceId: string; className?: string }) {
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

  // A finding selected from outside the list (URL hook, later the palette) opens and scrolls in.
  useEffect(() => {
    if (!expandRequest) return;
    setExpanded((cur) => (cur.has(expandRequest) ? cur : new Set(cur).add(expandRequest)));
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-finding-id]') ?? [];
    const row = Array.from(rows).find((r) => r.dataset.findingId === expandRequest);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [expandRequest, s.findings]);

  const findings = useMemo(() => s.findings ?? [], [s.findings]);
  const counts = useMemo(() => severityCounts(findings), [findings]);
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

  const topCount = s.result ? s.result.jars.filter((j) => j.depth === 0).length : 0;
  const meta = s.status === 'done' || findings.length ? `${counts.error} E · ${counts.warning} W · ${counts.info} I` : undefined;

  return (
    <Panel legend="Findings" meta={meta} flush className={className} bodyClassName="overflow-y-auto">
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
                  toggle(f.id);
                  a.select({ kind: 'finding', id: f.id });
                }}
                selected={selection?.kind === 'finding' && selection.id === f.id}
                jarNames={jarNames}
                selectedJarId={selection?.kind === 'jar' ? selection.id : null}
                onJarClick={a.revealJar}
                onFix={(fix) => void a.fix(f.id, fix, 'triage')}
                fixesDisabled={orderOpen || !!fixPending[f.id]}
                // Shown once, next to the button that was pressed (the inspector shows its own).
                fixError={fixErrorFrom[f.id] === 'triage' ? (fixErrors[f.id] ?? null) : null}
              />
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
