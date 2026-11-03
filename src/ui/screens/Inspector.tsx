/**
 * Inspector (DESIGN.md §5): the selected jar or finding, then the pack identity panel with
 * its override editor. Ruled data-plate rows; every fact is mono.
 */
import type { CSSProperties } from 'react';

import { cx } from '../components/cx';
import { Panel } from '../components/Panel';
import { useApp } from '../app/StoreContext';
import { FindingDetails } from './inspector/FindingDetails';
import { JarDetails } from './inspector/JarDetails';
import { PackPanel } from './inspector/PackPanel';

export function Inspector({ className, style }: { className?: string; style?: CSSProperties }) {
  const instanceId = useApp((s) => s.selectedInstanceId);
  const selection = useApp((s) => s.selection);
  const legend = selection?.kind === 'jar' ? 'Mod' : selection?.kind === 'finding' ? 'Finding' : 'Inspector';
  return (
    <aside aria-label="Inspector" style={style} className={cx('flex min-h-0 flex-col overflow-y-auto bg-panel', className)}>
      <Panel legend={legend} flush className="shrink-0 border-b border-line">
        {instanceId && selection?.kind === 'jar' ? <JarDetails instanceId={instanceId} jarId={selection.id} /> : null}
        {instanceId && selection?.kind === 'finding' ? <FindingDetails instanceId={instanceId} findingId={selection.id} /> : null}
        {!selection ? (
          <p className="px-4 py-2 t-small text-fg-faint">Select a tile, a finding or a mod to see its details here.</p>
        ) : null}
      </Panel>
      {instanceId ? <PackPanel key={instanceId} instanceId={instanceId} /> : null}
    </aside>
  );
}
