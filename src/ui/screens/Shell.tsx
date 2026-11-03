/**
 * App shell (DESIGN.md §5): instance rail (240px) | workspace (flex) | resizable inspector
 * (280–640px, width persisted in settings). Full-bleed regions split by hairlines; native window
 * decorations, so there is no title bar component.
 */
import { INSPECTOR_MAX, INSPECTOR_MIN } from '../components/resize';
import { Resizer } from '../components/Resizer';
import { useActions, useApp } from '../app/StoreContext';
import { InstanceRail } from './InstanceRail';
import { Inspector } from './Inspector';
import { NoInstances } from './NoInstances';
import { Workspace } from './Workspace';

export function Shell() {
  const width = useApp((s) => s.inspectorWidth);
  const ready = useApp((s) => s.phase === 'ready');
  const hasInstances = useApp((s) => (s.discovery?.instances.length ?? 0) > 0);
  const selected = useApp((s) => s.selectedInstanceId);
  const a = useActions();

  return (
    <div className="flex h-screen min-h-0 overflow-hidden bg-bg text-fg">
      <InstanceRail className="w-[240px] shrink-0 border-r border-line" />
      {ready && !hasInstances ? (
        <NoInstances className="min-w-0 flex-1" />
      ) : (
        <>
          <main className="flex min-w-0 flex-1 flex-col" aria-label="Workspace">
            {selected ? <Workspace instanceId={selected} /> : null}
          </main>
          <Resizer
            size={width}
            min={INSPECTOR_MIN}
            max={INSPECTOR_MAX}
            onResize={a.setInspectorWidth}
            onCommit={a.commitInspectorWidth}
            label="Resize inspector"
            className="-mx-1 z-10"
          />
          <Inspector style={{ width }} className="shrink-0" />
        </>
      )}
    </div>
  );
}
