/** Inspector: one finding. Code, diagnosis, full explanation, culprits, evidence and fixes. */
import { useMemo, type ReactNode } from 'react';

import type { Finding } from '../../../core/model';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { cx } from '../../components/cx';
import { ErrorRow } from '../../components/ErrorRow';
import { EvidenceView } from '../../components/EvidenceView';
import { fixLabel } from '../../components/labels';
import { FindingCode, RAIL_BG } from '../../components/Severity';
import { useActions, useApp } from '../../app/StoreContext';
import { useFixVersions } from '../modrinthHooks';
import { SubLegend } from './Plate';

export function FindingDetails({ instanceId, findingId }: { instanceId: string; findingId: string }) {
  const finding = useApp((s) => s.scans[instanceId]?.findings.find((f) => f.id === findingId) ?? null);
  if (!finding) return <p className="px-4 py-2 t-small text-fg-faint">This finding is gone after the last scan.</p>;
  return <FindingBody instanceId={instanceId} finding={finding} />;
}

/**
 * The shared body for static and crash findings. `afterHeader` goes between the title and the
 * explanation (crash findings put their log source there).
 */
export function FindingBody({ instanceId, finding, afterHeader }: { instanceId: string; finding: Finding; afterHeader?: ReactNode }) {
  const findingId = finding.id;
  const result = useApp((s) => s.scans[instanceId]?.result ?? null);
  // Only errors from the inspector's own buttons; the triage row shows the ones it triggered.
  const fixError = useApp((s) => (s.fixErrorFrom[findingId] === 'inspector' ? (s.fixErrors[findingId] ?? null) : null));
  const pending = useApp((s) => !!s.fixPending[findingId]);
  const orderOpen = useApp((s) => s.order !== null);
  const selectedJar = useApp((s) => (s.selection?.kind === 'jar' ? s.selection.id : null));
  const a = useActions();
  const versions = useFixVersions(instanceId);
  const names = useMemo(() => {
    const n: Record<string, string> = {};
    for (const j of result?.jars ?? []) n[j.id] = j.fileName;
    return n;
  }, [result]);

  const label = (id: string) => names[id] ?? id;
  const steps = finding.fixes.flatMap((f) => (f.kind === 'manual' ? f.steps : []));
  const plannable = finding.fixes.filter((f) => f.kind !== 'manual');

  return (
    <div className="flex flex-col">
      <div className="relative flex flex-col gap-1 py-2 pr-4 pl-4">
        <span aria-hidden className={cx('absolute inset-y-0 left-0 w-1', RAIL_BG[finding.severity])} />
        <FindingCode code={finding.code} severity={finding.severity} />
        <h3 className="t-title text-fg">{finding.title}</h3>
      </div>
      {afterHeader}
      <p className="border-t border-line px-4 py-2 t-body text-fg">{finding.explanation}</p>
      {finding.culprits.length ? (
        <>
          <SubLegend meta={finding.culprits.length}>Culprits</SubLegend>
          <div className="flex flex-wrap gap-1 px-4 py-2">
            {finding.culprits.map((c) => (
              <Chip key={c.jarId} title={c.jarId} selected={selectedJar === c.jarId} onClick={() => a.revealJar(c.jarId)}>
                {c.fileName}
              </Chip>
            ))}
          </div>
        </>
      ) : null}
      {finding.evidence.length ? (
        <>
          <SubLegend meta={finding.evidence.length}>Evidence</SubLegend>
          <div className="flex flex-col gap-2 px-4 py-2">
            {finding.evidence.map((ev, i) => (
              <EvidenceView key={i} evidence={ev} jarLabel={label} onJarClick={a.revealJar} maxHeight={384} />
            ))}
          </div>
        </>
      ) : null}
      {finding.fixes.length ? (
        <>
          <SubLegend>Fixes</SubLegend>
          {plannable.length ? (
            <div className="flex flex-wrap gap-2 px-4 py-2">
              {plannable.map((fix, i) => (
                <Button key={i} size={24} variant={i === 0 ? 'primary' : 'default'} disabled={pending || orderOpen} onClick={() => void a.fix(findingId, fix, 'inspector')}>
                  {fixLabel(fix, names, versions)}
                </Button>
              ))}
            </div>
          ) : null}
          {fixError ? <ErrorRow error={fixError} className="border-t" /> : null}
          {steps.length ? (
            <ol className="flex flex-col gap-1 px-4 py-2 t-mono text-fg-dim">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-fg-faint">{String(i + 1).padStart(2, '0')}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
