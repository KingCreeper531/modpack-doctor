/** #mod-table, #palette, #about and #empty. */
import { ArrowClockwise, Copy, FolderPlus, Info } from '@phosphor-icons/react';
import { useMemo, useState, type ReactNode } from 'react';

import { AboutPlate } from '../components/AboutPlate';
import { CommandPalette, type PaletteGroup } from '../components/CommandPalette';
import { EmptyState } from '../components/EmptyState';
import { ModTable, type ModRow, type ModSortKey } from '../components/ModTable';
import { Panel } from '../components/Panel';
import type { SortState } from '../components/sort';
import { ABOUT, MOD_ROWS, PALETTE_GROUPS, PROBES } from './fixtures';
import type { JarSelection } from './DiagnosisSections';
import { Section, Spec, SpecRow } from './Section';

const NO_FINDINGS = { error: 0, warning: 0, info: 0 };

/** One row per state the mod table must show (DESIGN.md §6.6). */
const STATE_ROWS: ModRow[] = [
  { id: 'mods/sodium-0.5.8.jar', name: 'Sodium', modId: 'sodium', version: '0.5.8', loader: 'forge', modrinth: { state: 'update', version: '0.5.11' }, findings: { error: 0, warning: 1, info: 0 }, enabled: true },
  { id: 'mods/rubidium-0.7.1.jar#disabled', name: 'Rubidium', modId: 'rubidium', version: '0.7.1', loader: 'forge', modrinth: { state: 'matched' }, findings: NO_FINDINGS, enabled: false },
  {
    id: 'mods/create-1.20.1-0.5.1.f.jar',
    name: 'Create',
    modId: 'create',
    version: '0.5.1.f',
    loader: 'forge',
    modrinth: { state: 'matched' },
    findings: { error: 1, warning: 0, info: 0 },
    enabled: true,
    children: [
      { id: 'mods/create-1.20.1-0.5.1.f.jar!/META-INF/jarjar/flywheel-forge-0.6.10.jar', name: 'Flywheel', modId: 'flywheel', version: '0.6.10', loader: 'forge', modrinth: { state: 'matched' }, findings: NO_FINDINGS, enabled: true },
      { id: 'mods/create-1.20.1-0.5.1.f.jar!/META-INF/jarjar/registrate-1.3.3.jar', name: 'Registrate', modId: 'registrate', version: 'MC1.20-1.3.3', loader: 'forge', modrinth: { state: 'missing' }, findings: { error: 0, warning: 0, info: 1 }, enabled: true },
    ],
  },
  { id: 'mods/ae2-15.2.1.jar', name: 'Applied Energistics 2', modId: 'ae2', version: '15.2.1', loader: 'forge', modrinth: { state: 'offline' }, findings: NO_FINDINGS, enabled: true },
  { id: 'mods/OptiFine_1.20.1_HD_U_I6.jar', name: 'OptiFine_1.20.1_HD_U_I6.jar', modId: null, version: null, loader: null, modrinth: { state: 'missing' }, findings: { error: 2, warning: 1, info: 0 }, enabled: true },
  { id: 'mods/jei-1.20.1-forge-15.2.0.27.jar', name: 'Just Enough Items', modId: 'jei', version: '15.2.0.27', loader: 'forge', modrinth: { state: 'matched' }, findings: NO_FINDINGS, enabled: true },
];

export function ModTableSection({ selectedJar, onSelectJar }: JarSelection) {
  const [sort, setSort] = useState<SortState<ModSortKey> | null>({ key: 'status', dir: 'asc' });
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set(MOD_ROWS.filter((r) => !r.enabled).map((r) => r.id)));
  const rows = useMemo<ModRow[]>(() => MOD_ROWS.map((r) => ({ ...r, enabled: !off.has(r.id) })), [off]);
  const create = MOD_ROWS.find((r) => r.modId === 'create');
  return (
    <Section id="mod-table" title="Mod table" spec="§6.6" meta="500 rows · virtualised · nested jars · sort persists per instance">
      <Panel legend="Row states" meta="selected · disabled · nested expanded · update · not on Modrinth · offline · errors" flush className="border-b border-line">
        <ModTable rows={STATE_ROWS} sort={null} onSort={() => undefined} selectedId="mods/sodium-0.5.8.jar" defaultExpanded={['mods/create-1.20.1-0.5.1.f.jar']} height={9 * 24} />
      </Panel>
      <Panel legend="Mods" meta={`${rows.length} jars · sorted by ${sort ? `${sort.key} ${sort.dir}` : 'file name'}`} flush>
        <ModTable
          rows={rows}
          sort={sort}
          onSort={setSort}
          selectedId={selectedJar}
          onSelect={onSelectJar}
          scrollToId={selectedJar}
          defaultExpanded={create ? [create.id] : []}
          onToggleEnabled={(id, next) =>
            setOff((s) => {
              const n = new Set(s);
              if (next) n.delete(id);
              else n.add(id);
              return n;
            })
          }
          height={480}
        />
      </Panel>
    </Section>
  );
}

const ICONS: Record<string, ReactNode> = {
  'act:rescan': <ArrowClockwise size={16} />,
  'act:copy': <Copy size={16} />,
  'act:add': <FolderPlus size={16} />,
  'act:about': <Info size={16} />,
};

export function PaletteSection() {
  const [picked, setPicked] = useState<string | null>(null);
  const groups: PaletteGroup[] = PALETTE_GROUPS.map((g) => ({ ...g, items: g.items.map((it) => ({ ...it, icon: ICONS[it.id] })) }));
  return (
    <Section id="palette" title="Command palette" spec="§6.7" meta={picked ? `selected ${picked}` : 'Ctrl/Cmd+K · 560px · 64px from top'}>
      <SpecRow>
        <Spec label="Open" note="window frame, palette 64px below its top" className="min-w-0 flex-1">
          <div className="relative h-[400px] overflow-hidden border border-line bg-bg">
            <CommandPalette groups={groups} onSelect={setPicked} onClose={() => setPicked('closed')} placement="contained" className="absolute top-16 left-4" />
          </div>
        </Spec>
        <Spec label="Filtered" note={'query "re" · matched characters fg, rest fg-dim'} className="min-w-0 flex-1">
          <div className="relative h-[400px] overflow-hidden border border-line bg-bg">
            <CommandPalette groups={groups} onSelect={setPicked} onClose={() => setPicked('closed')} placement="contained" initialQuery="re" className="absolute top-16 left-4" />
          </div>
        </Spec>
      </SpecRow>
    </Section>
  );
}

export function AboutSection() {
  return (
    <Section id="about" title="About" spec="§6.8" meta="data plate · no third-party logos">
      <SpecRow>
        <div className="border border-line bg-bg p-8">
          <AboutPlate info={ABOUT} onClose={() => undefined} />
        </div>
      </SpecRow>
    </Section>
  );
}

export function EmptySection() {
  return (
    <Section id="empty" title="No instances found" spec="§10" meta="every location checked · no illustration">
      <EmptyState probes={PROBES} onAddFolder={() => undefined} onAddLauncherRoot={() => undefined} />
    </Section>
  );
}
