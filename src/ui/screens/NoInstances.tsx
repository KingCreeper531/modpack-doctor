/**
 * No instances found (DESIGN.md §10): the probes table (every launcher location checked and
 * the result), Add folder, and a launcher data-folder picker for portable installs.
 */
import type { Launcher, LauncherProbe } from '../../bindings';
import { Button } from '../components/Button';
import { cx } from '../components/cx';
import { EmptyState } from '../components/EmptyState';
import { LAUNCHER_NAME } from '../components/labels';
import { useActions, useApp } from '../app/StoreContext';

const ROOT_LAUNCHERS: readonly Launcher[] = ['prism', 'multimc', 'curseforge', 'modrinth'];
const NONE: readonly LauncherProbe[] = [];

export function NoInstances({ className }: { className?: string }) {
  const probes = useApp((s) => s.discovery?.probes ?? NONE);
  const a = useActions();
  return (
    <main aria-label="No instances" className={cx('flex min-h-0 flex-col overflow-y-auto bg-panel', className)}>
      <EmptyState probes={probes} onAddFolder={() => void a.addFolder()} className="shrink-0" />
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2">
        <span className="t-small text-fg-dim">Launcher installed somewhere else? Pick its data folder:</span>
        {ROOT_LAUNCHERS.map((l) => (
          <Button key={l} size={24} onClick={() => void a.addLauncherRoot(l)}>
            {LAUNCHER_NAME[l]}…
          </Button>
        ))}
      </div>
    </main>
  );
}
