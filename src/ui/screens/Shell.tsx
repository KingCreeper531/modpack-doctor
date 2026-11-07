/**
 * App shell (DESIGN.md §5): instance rail (240px) | workspace (flex) | resizable inspector
 * (280–640px, width persisted in settings). Full-bleed regions split by hairlines; native window
 * decorations, so there is no title bar component.
 *
 * Narrow windows (below ~1170px, down to the 960px minimum): the docked inspector first
 * shrinks toward 280px; past that it becomes a drawer overlaying the workspace from the right,
 * toggled from the workspace header and opened by any selection (app/layout.ts).
 */
import { X } from '@phosphor-icons/react';

import { Button } from '../components/Button';
import { ErrorRow } from '../components/ErrorRow';
import { INSPECTOR_MAX, INSPECTOR_MIN } from '../components/resize';
import { Resizer } from '../components/Resizer';
import { inspectorLayout, MIN_WORKSPACE, RAIL_WIDTH } from '../app/layout';
import { NO_BACKEND } from '../app/ipc';
import { useActions, useApp } from '../app/StoreContext';
import { CrashBanner } from './CrashBanner';
import { DrawerContext } from './drawer';
import { useViewportWidth } from './hooks';
import { InstanceRail } from './InstanceRail';
import { Inspector } from './Inspector';
import { NoInstances } from './NoInstances';
import { Overlays } from './Overlays';
import { Workspace } from './Workspace';


export function Shell() {
  const preferred = useApp((s) => s.inspectorWidth);
  const ready = useApp((s) => s.phase === 'ready');
  const hasInstances = useApp((s) => (s.discovery?.instances.length ?? 0) > 0);
  const selected = useApp((s) => s.selectedInstanceId);
  const backendKind = useApp((s) => s.backendKind);
  const open = useApp((s) => s.inspectorOpen);
  const a = useActions();
  const viewport = useViewportWidth();
  const layout = inspectorLayout(viewport, preferred);
  const drawer = layout.mode === 'drawer';
  // `?drag=1` screenshot hook (browser mock only; dead code in production builds).
  const dragPreview = import.meta.env.DEV && backendKind === 'mock' && new URLSearchParams(window.location.search).get('drag') === '1';

  if (backendKind === 'none') {
    return (
      <div className="flex h-screen min-h-0 flex-col bg-bg text-fg">
        <ErrorRow error={NO_BACKEND} />
      </div>
    );
  }

  return (
    <DrawerContext.Provider value={drawer}>
      <div className="relative flex h-screen min-h-0 overflow-hidden bg-bg text-fg">
        <Overlays dragPreview={dragPreview} />
        <InstanceRail className="w-[240px] shrink-0 border-r border-line" />
        {ready && !hasInstances ? (
          <NoInstances className="min-w-0 flex-1" />
        ) : (
          <>
            <main className="flex min-w-0 flex-1 flex-col" aria-label="Workspace">
              <CrashBanner />
              {selected ? <Workspace instanceId={selected} /> : null}
            </main>
            {drawer ? (
              open ? (
                <Inspector
                  style={{ width: layout.width }}
                  className="absolute inset-y-0 right-0 z-20 border-l border-line-strong shadow-overlay"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') a.setInspectorOpen(false);
                  }}
                  close={
                    <Button size={24} icon={<X size={16} />} aria-label="Close inspector" onClick={() => a.setInspectorOpen(false)}>
                      Close
                    </Button>
                  }
                />
              ) : null
            ) : (
              <>
                <Resizer
                  size={layout.width}
                  min={INSPECTOR_MIN}
                  max={Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, viewport - RAIL_WIDTH - MIN_WORKSPACE))}
                  onResize={a.setInspectorWidth}
                  onCommit={a.commitInspectorWidth}
                  label="Resize inspector"
                  className="-mx-1 z-10"
                />
                <Inspector style={{ width: layout.width }} className="shrink-0" />
              </>
            )}
          </>
        )}
      </div>
    </DrawerContext.Provider>
  );
}
