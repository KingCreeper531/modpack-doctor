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

export function ModTableSection({ selectedJar, onSelectJar }: JarSelection) {
  const [sort, setSort] = useState<SortState<ModSortKey> | null>({ key: 'status', dir: 'asc' });
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set(MOD_ROWS.filter((r) => !r.enabled).map((r) => r.id)));
  const rows = useMemo<ModRow[]>(() => MOD_ROWS.map((r) => ({ ...r, enabled: !off.has(r.id) })), [off]);
  const create = MOD_ROWS.find((r) => r.modId === 'create');
  return (
    <Section id="mod-table" title="Mod table" spec="§6.6" meta="500 rows · virtualised · nested jars · sort persists per instance">
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
