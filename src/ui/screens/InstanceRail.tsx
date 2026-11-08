/**
 * Instance rail (DESIGN.md §5): one 48px row per discovered instance with its last-scan pip,
 * then the footer: Add folder, add a launcher's data folder, the Modrinth settings, the theme
 * control, and the About entry (with the app version, or the quiet "Update <version> available"
 * notice, UpdateNotice.tsx) that opens the About dialog.
 */
import { CaretDown, CaretRight, FilePlus, FolderPlus, Info } from '@phosphor-icons/react';
import { useState } from 'react';

import type { Launcher } from '../../bindings';
import { Button } from '../components/Button';
import { cx } from '../components/cx';
import { ErrorRow } from '../components/ErrorRow';
import { InstanceRailRow } from '../components/InstanceRailRow';
import { LAUNCHER_NAME } from '../components/labels';
import { Panel } from '../components/Panel';
import { instanceStatus } from '../app/derive';
import { instanceMenuFor } from '../app/rowMenus';
import { useActions, useApp } from '../app/StoreContext';
import { AboutDialog } from './AboutDialog';
import { useRowMenu } from './hooks';
import { ModrinthControl } from './ModrinthControl';
import { ThemeControl } from './ThemeControl';
import { UpdateNotice } from './UpdateNotice';

/** Launchers whose data folder can live somewhere custom (portable installs, moved folders). */
const ROOT_LAUNCHERS: readonly Launcher[] = ['prism', 'multimc', 'curseforge', 'modrinth'];

function RailRow({ id }: { id: string }) {
  const instance = useApp((s) => s.discovery?.instances.find((i) => i.id === id));
  const status = useApp((s) => instanceStatus(s.scans[id]));
  const selected = useApp((s) => s.selectedInstanceId === id);
  const crash = useApp((s) => s.crashAlerts[id]?.summary.headline ?? null);
  const watching = useApp((s) => s.settings.watched.includes(id));
  const a = useActions();
  const rowMenu = useRowMenu();
  if (!instance) return null;
  return (
    <InstanceRailRow
      instance={instance}
      status={status}
      selected={selected}
      onSelect={a.selectInstance}
      crash={crash}
      watching={watching}
      onContextMenu={(e) => rowMenu(e, `Instance ${instance.name}`, (st) => instanceMenuFor(st, id))}
    />
  );
}

/** A file dropped on the window that Rust refused (`DropRejected`): inline, never a toast. */
function DropRejectedRow() {
  const d = useApp((s) => s.dropRejected);
  const a = useActions();
  if (!d) return null;
  return (
    <ErrorRow
      // Rust's reason completes the sentence "<name> was not added: <reason>".
      error={{ kind: 'invalid', message: `${d.name} was not added: ${d.reason}`, path: null }}
      action={
        <Button size={24} onClick={a.dismissDropRejected}>
          Dismiss
        </Button>
      }
    />
  );
}

export function InstanceRail({ className }: { className?: string }) {
  const ids = useApp((s) => s.discovery?.instances.map((i) => i.id).join('\n') ?? '');
  const phase = useApp((s) => s.phase);
  const railError = useApp((s) => s.railError);
  const discoveryError = useApp((s) => s.discoveryError);
  const a = useActions();
  const [rootsOpen, setRootsOpen] = useState(false);
  const list = ids ? ids.split('\n') : [];

  return (
    <Panel
      legend="Instances"
      meta={phase === 'ready' ? list.length : undefined}
      flush
      className={cx('min-h-0', className)}
      bodyClassName="flex min-h-0 flex-col"
      aria-label="Instances"
    >
      <nav aria-label="Instance list" className="min-h-0 flex-1 overflow-y-auto">
        {phase === 'loading' ? (
          <p className="flex h-12 items-center px-4 t-small text-fg-faint" role="status">
            Looking for instances…
          </p>
        ) : null}
        {discoveryError ? <ErrorRow error={discoveryError} /> : null}
        {phase === 'ready' && !list.length && !discoveryError ? (
          <p className="flex h-12 items-center px-4 t-small text-fg-faint">No instances found yet.</p>
        ) : null}
        {list.map((id) => (
          <RailRow key={id} id={id} />
        ))}
      </nav>
      <div className="shrink-0 border-t border-line">
        {railError ? (
          <ErrorRow
            error={railError}
            action={
              <Button size={24} onClick={a.clearRailError}>
                Dismiss
              </Button>
            }
          />
        ) : null}
        <DropRejectedRow />
        <div className="flex flex-col gap-2 p-2">
          <div className="flex gap-2">
            <Button size={24} icon={<FolderPlus size={16} />} className="min-w-0 flex-1 justify-start" onClick={() => void a.addFolder()}>
              Add folder
            </Button>
            <Button size={24} icon={<FilePlus size={16} />} className="min-w-0 flex-1 justify-start" onClick={() => void a.openMrpack()}>
              Open .mrpack
            </Button>
          </div>
          <button
            type="button"
            aria-expanded={rootsOpen}
            aria-controls="rail-launcher-roots"
            onClick={() => setRootsOpen((o) => !o)}
            className="flex h-6 items-center gap-1 px-1 t-small text-fg-dim hover:text-fg"
          >
            {rootsOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
            Add a launcher's data folder
          </button>
          {rootsOpen ? (
            <ul id="rail-launcher-roots" className="flex flex-col border-y border-line">
              {ROOT_LAUNCHERS.map((l) => (
                <li key={l}>
                  <button
                    type="button"
                    onClick={() => void a.addLauncherRoot(l)}
                    className="flex h-6 w-full items-center px-4 t-small text-fg-dim hover:bg-raised hover:text-fg focus-visible:bg-raised focus-visible:outline-1 focus-visible:-outline-offset-1"
                  >
                    {LAUNCHER_NAME[l]}…
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <ModrinthControl className="border-t border-line px-2 py-2" />
        <ThemeControl className="border-t border-line px-2 py-2" />
        <div className="flex h-8 items-center gap-2 border-t border-line px-2">
          <button
            type="button"
            data-about-trigger
            aria-haspopup="dialog"
            onClick={() => a.setAboutOpen(true)}
            className="flex h-6 items-center gap-1 px-1 t-small text-fg-dim hover:text-fg"
          >
            <Info size={16} aria-hidden />
            About
          </button>
          <UpdateNotice className="ml-auto" />
        </div>
      </div>
      <AboutDialog />
    </Panel>
  );
}
