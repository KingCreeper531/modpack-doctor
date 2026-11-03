/**
 * No instances found (DESIGN.md §10): a ruled table of every launcher location the app checked,
 * its OS path (mono) and the result, plus Add folder. No illustration, no "Get started".
 */
import { FolderPlus } from '@phosphor-icons/react';

import type { LauncherProbe } from '../../bindings';
import { Button } from './Button';
import { cx } from './cx';
import { LAUNCHER_NAME, probeResult, type ProbeTone } from './labels';
import { Panel } from './Panel';
import { Table, type Column } from './Table';

const TONE: Record<ProbeTone, string> = {
  faint: 'text-fg-faint',
  dim: 'text-fg-dim',
  ok: 'text-ok',
  err: 'text-err-text',
};

export interface EmptyStateProps {
  probes: readonly LauncherProbe[];
  onAddFolder: () => void;
  /** Optional: pick a portable launcher root / custom CurseForge folder. */
  onAddLauncherRoot?: () => void;
  className?: string;
}

const COLUMNS: ReadonlyArray<Column<LauncherProbe>> = [
  { key: 'launcher', label: 'Launcher', width: '160px', render: (p) => <span className="truncate text-fg">{LAUNCHER_NAME[p.launcher]}</span> },
  {
    key: 'path',
    label: 'Location checked',
    width: 'minmax(0,1fr)',
    render: (p) => (
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate t-mono text-fg-dim" title={p.path}>
          {p.path}
        </span>
        {p.notes.length ? (
          <span className="truncate t-small text-fg-faint" title={p.notes.join('\n')}>
            {p.notes[0]}
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: 'result',
    label: 'Result',
    width: '160px',
    render: (p) => {
      const r = probeResult(p.result);
      return (
        <span className={cx('truncate t-mono', TONE[r.tone])} title={r.text}>
          {r.text}
        </span>
      );
    },
  },
];

export function EmptyState({ probes, onAddFolder, onAddLauncherRoot, className }: EmptyStateProps) {
  return (
    <Panel legend="No instances found" meta={`checked ${probes.length} locations`} flush className={className}>
      <p className="flex h-8 items-center border-b border-line px-4 t-body text-fg-dim">
        No Minecraft instances in the places below. Add the folder that contains your mods folder.
      </p>
      <Table label="Launcher locations checked" columns={COLUMNS} rows={probes} rowKey={(p) => `${p.launcher}:${p.path}`} />
      <div className="flex items-center gap-2 px-4 py-4">
        <Button variant="primary" icon={<FolderPlus size={16} />} onClick={onAddFolder}>
          Add folder
        </Button>
        {onAddLauncherRoot ? <Button onClick={onAddLauncherRoot}>Add launcher folder</Button> : null}
      </div>
    </Panel>
  );
}
