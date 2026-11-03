/**
 * FINDINGS panel (DESIGN.md §6.2): one triage row per finding, sorted by the checks
 * (severity, code, file). Click expands inline and shows the finding in the inspector; chips
 * select the jar. Fix buttons go through `plan_work_order`; a refusal renders inline.
 * Scan failures render as an error row with a Retry button (§10).
 */
import { useMemo, useState } from 'react';

import { Button } from '../components/Button';
import { ErrorRow } from '../components/ErrorRow';
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
  const fixPending = useApp((st) => st.fixPending);
  const orderOpen = useApp((st) => st.order !== null);
  const a = useActions();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

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
            <Button size={24} onClick={() => void a.scan(instanceId)}>
              Retry
            </Button>
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
        <div role="list" aria-label={`Findings, ${formatInt(findings.length)}`}>
          {findings.map((f) => (
            <div role="listitem" key={f.id}>
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
                onFix={(fix) => void a.fix(f.id, fix)}
                fixesDisabled={orderOpen || !!fixPending[f.id]}
                fixError={fixErrors[f.id] ?? null}
              />
            </div>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
