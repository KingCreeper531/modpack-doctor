/**
 * SCAN panel (DESIGN.md §6.1): the tile grid filling in live from `ScanProgress`, a grid-sort
 * switch (name / severity, persisted in settings) and `done/total · duration` meta.
 * Clicking a tile selects the jar and scrolls the mod table to it.
 */
import { useMemo } from 'react';

import type { GridSort } from '../../bindings';
import { cx } from '../components/cx';
import { formatDuration, formatInt } from '../components/format';
import { Panel } from '../components/Panel';
import { TileGrid } from '../components/TileGrid';
import { deriveTiles, topLevelId } from '../app/derive';
import { useActions, useApp } from '../app/StoreContext';

const SORTS: ReadonlyArray<[GridSort, string]> = [
  ['name', 'Name'],
  ['severity', 'Severity'],
];

function SortSwitch({ value, disabled }: { value: GridSort; disabled: boolean }) {
  const a = useActions();
  return (
    <div role="radiogroup" aria-label="Tile order" className="flex items-center gap-2">
      <span className="t-small text-fg-faint">order</span>
      <div className="flex overflow-hidden rounded-2 border border-line-strong">
        {SORTS.map(([v, label], i) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            disabled={disabled}
            onClick={() => a.setGridSort(v)}
            className={cx(
              'h-[22px] px-2 t-small focus-visible:outline-1 focus-visible:-outline-offset-1 disabled:text-fg-faint',
              i > 0 && 'border-l border-line-strong',
              value === v ? 'bg-raised font-medium text-fg' : 'bg-panel text-fg-dim enabled:hover:bg-raised enabled:hover:text-fg',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ScanPanel({ instanceId, className }: { instanceId: string; className?: string }) {
  const scan = useApp((s) => s.scans[instanceId]);
  const gridSort = useApp((s) => s.settings.gridSort);
  const selectedJar = useApp((s) => (s.selection?.kind === 'jar' ? topLevelId(s.selection.id) : null));
  const a = useActions();
  const tiles = useMemo(() => (scan ? deriveTiles(scan, gridSort) : []), [scan, gridSort]);

  const status = scan?.status ?? 'idle';
  const counts = { error: 0, warning: 0, disabled: 0 };
  for (const t of tiles) if (t.state in counts) counts[t.state as keyof typeof counts]++;
  let meta: string;
  if (status === 'scanning') meta = `${formatInt(scan?.done ?? 0)}/${formatInt(scan?.total ?? 0)}`;
  else if (status === 'done' && scan?.result) meta = `${formatInt(tiles.length)}/${formatInt(tiles.length)}  ${formatDuration(scan.result.durationMs)}`;
  else meta = status === 'error' ? (scan?.error?.kind === 'unavailable' ? 'not available' : 'failed') : '—';

  return (
    <Panel
      legend="Scan"
      meta={meta}
      actions={
        <>
          <SortSwitch value={gridSort} disabled={status === 'scanning'} />
          {status === 'done' ? (
            // Tile counts are jars (a jar with two findings is one red tile), unlike the summary
            // strip's finding counts, so say "jars" to keep the two from looking inconsistent.
            <span className="t-mono text-fg-faint">{`jars: ${counts.error} error · ${counts.warning} warning · ${counts.disabled} disabled`}</span>
          ) : null}
        </>
      }
      className={className}
      bodyClassName="max-h-[240px] overflow-y-auto px-4 py-2"
      flush
    >
      {tiles.length ? (
        <TileGrid tiles={tiles} selectedId={selectedJar} onSelect={a.revealJar} label={`Scan grid, ${tiles.length} jars`} />
      ) : (
        <p className="flex h-6 items-center t-small text-fg-faint">
          {status === 'scanning' ? 'Listing jars…' : status === 'done' ? 'No jars in the mods folder.' : status === 'error' ? (scan?.error?.kind === 'unavailable' ? 'This instance cannot be scanned in this version yet.' : 'The scan did not finish.') : 'Not scanned yet.'}
        </p>
      )}
    </Panel>
  );
}
