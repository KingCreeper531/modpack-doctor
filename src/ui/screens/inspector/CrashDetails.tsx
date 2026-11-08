/**
 * Inspector: one crash finding (M4). The log source as a data plate (kind, path, modified, size,
 * lines read), then the finding body shared with static findings (full explanation, culprits,
 * the full log evidence with jar chips, fixes). "Show in log" opens the source's whole digest in
 * the crash view, scrolled to the culprit line.
 */
import { Button } from '../../components/Button';
import { formatBytes, formatInt, logPath } from '../../components/format';
import { firstCulpritLine, LOG_KIND_LABEL } from '../../app/crashState';
import { isPastedSource } from '../../app/logTools';
import { useActions, useApp } from '../../app/StoreContext';
import { FindingBody } from './FindingDetails';
import { Plate, PlateRow, SubLegend } from './Plate';

export function CrashDetails({ instanceId, sourceId, findingId }: { instanceId: string; sourceId: string; findingId: string }) {
  const source = useApp((s) => s.crashes[instanceId]?.sources.find((x) => x.id === sourceId) ?? null);
  const analysis = useApp((s) => s.crashes[instanceId]?.analyses[sourceId]);
  const finding = analysis?.findings.find((f) => f.id === findingId) ?? null;
  const a = useActions();
  const pack = useApp((s) => s.discovery?.instances.find((i) => i.id === instanceId)?.launcher === 'mrpack');
  if (!finding || !source) {
    return <p className="px-4 py-2 t-small text-fg-faint">This crash finding is gone after the last analysis.</p>;
  }
  const line = firstCulpritLine(finding);
  const pasted = isPastedSource(sourceId);
  return (
    <FindingBody
      instanceId={instanceId}
      finding={finding}
      afterHeader={
        <>
          <SubLegend
            meta={
              <span className="flex items-center gap-2">
                {!pasted && !pack ? (
                  <Button size={24} onClick={() => a.setLogDialog({ kind: 'share', instanceId, sourceId })}>
                    Share on mclo.gs
                  </Button>
                ) : null}
                {line !== null ? (
                  <Button
                    size={24}
                    onClick={() => {
                      a.selectCrash(instanceId, sourceId, findingId);
                      a.setCrashPane(instanceId, 'log', line);
                    }}
                  >
                    Show in log
                  </Button>
                ) : null}
              </span>
            }
          >
            Source
          </SubLegend>
          <Plate label="Log source">
            <PlateRow label="Kind">{pasted ? 'pasted text (not saved)' : LOG_KIND_LABEL[source.kind]}</PlateRow>
            {pasted ? null : <PlateRow label="Path">{logPath(source.id)}</PlateRow>}
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
