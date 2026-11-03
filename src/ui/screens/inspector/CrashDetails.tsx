/**
 * Inspector: one crash finding (M4). The log source as a data plate (kind, path, modified, size,
 * lines read), then the finding body shared with static findings (full explanation, culprits,
 * the full log evidence with jar chips, fixes). "Show in log" opens the source's whole digest in
 * the crash view, scrolled to the culprit line.
 */
import { Button } from '../../components/Button';
import { formatBytes, formatInt } from '../../components/format';
import { firstCulpritLine, LOG_KIND_LABEL } from '../../app/crashState';
import { useActions, useApp } from '../../app/StoreContext';
import { FindingBody } from './FindingDetails';
import { Plate, PlateRow, SubLegend } from './Plate';

export function CrashDetails({ instanceId, sourceId, findingId }: { instanceId: string; sourceId: string; findingId: string }) {
  const source = useApp((s) => s.crashes[instanceId]?.sources.find((x) => x.id === sourceId) ?? null);
  const analysis = useApp((s) => s.crashes[instanceId]?.analyses[sourceId]);
  const finding = analysis?.findings.find((f) => f.id === findingId) ?? null;
  const a = useActions();
  if (!finding || !source) {
    return <p className="px-4 py-2 t-small text-fg-faint">This crash finding is gone after the last analysis.</p>;
  }
  const line = firstCulpritLine(finding);
  return (
    <FindingBody
      instanceId={instanceId}
      finding={finding}
      afterHeader={
        <>
          <SubLegend
            meta={
              line !== null ? (
                <Button
                  size={24}
                  onClick={() => {
                    a.selectCrash(instanceId, sourceId, findingId);
                    a.setCrashPane(instanceId, 'log', line);
                  }}
                >
                  Show in log
                </Button>
              ) : undefined
            }
          >
            Source
          </SubLegend>
          <Plate label="Log source">
            <PlateRow label="Kind">{LOG_KIND_LABEL[source.kind]}</PlateRow>
            <PlateRow label="Path">{source.id}</PlateRow>
            <PlateRow label="Modified">{new Date(source.modifiedMs).toLocaleString()}</PlateRow>
            <PlateRow label="Size">{formatBytes(source.size)}</PlateRow>
            {analysis?.digest ? (
              <PlateRow label="Lines">
                {formatInt(analysis.digest.totalLines)}
                {analysis.digest.truncated ? <span className="text-fg-dim"> (digest: start, end and crash markers)</span> : null}
              </PlateRow>
            ) : null}
          </Plate>
        </>
      }
    />
  );
}
