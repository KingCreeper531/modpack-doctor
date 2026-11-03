/**
 * Dev-only component sheet at /design (DESIGN.md §12 review target). Every component in every
 * state, laid out like a parts catalogue: dense, ruled, left-aligned. Each section has an anchor
 * id so screenshots can target it (#tiles, #triage, #log, #work-order, #mod-table, #rail,
 * #summary, #controls, #palette, #about, #empty).
 */
import { Moon, Play, Sun } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useState } from 'react';

import type { ResolvedTheme } from '../../bindings';
import { Button } from '../components/Button';
import { formatInt } from '../components/format';
import { AboutSection, EmptySection, ModTableSection, PaletteSection } from './CatalogueSections';
import { ControlsSection } from './ControlsSection';
import { LogSection, TilesSection, TriageSection } from './DiagnosisSections';
import { RailSection, SummarySection } from './RailSummarySections';
import { useScanSim } from './scanSim';
import { WorkOrderSection } from './WorkOrderSection';

const NAV: Array<[string, string]> = [
  ['controls', 'Controls'],
  ['rail', 'Rail'],
  ['summary', 'Summary'],
  ['tiles', 'Tiles'],
  ['triage', 'Triage'],
  ['log', 'Log'],
  ['work-order', 'Work order'],
  ['mod-table', 'Mods'],
  ['palette', 'Palette'],
  ['about', 'About'],
  ['empty', 'Empty'],
];

/** Screenshot hooks: `?theme=dark|light` forces a theme, `?only=<section id>` renders one section. */
const params = new URLSearchParams(window.location.search);

function initialTheme(): ResolvedTheme {
  const forced = params.get('theme');
  if (forced === 'dark' || forced === 'light') return forced;
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'dark' || set === 'light') return set;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function TopBar() {
  const [theme, setTheme] = useState<ResolvedTheme>(initialTheme);
  const { running, done, tiles, start } = useScanSim();
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <header className="sticky top-0 z-30 flex h-8 items-center gap-4 border-b border-line-strong bg-bg px-4">
      <span className="t-label text-fg">Modpack Doctor</span>
      <span className="t-mono text-fg-faint">/design</span>
      <nav aria-label="Sections" className="flex min-w-0 items-center gap-4 overflow-x-auto">
        {NAV.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="shrink-0 t-label text-fg-faint hover:text-fg">
            {label}
          </a>
        ))}
      </nav>
      <span className="ml-auto shrink-0 t-mono text-fg-faint" role="status">
        {running ? `scanning ${formatInt(done)}/${formatInt(tiles.length)}` : `${formatInt(tiles.length)} tiles`}
      </span>
      <Button size={24} icon={<Play size={16} />} onClick={() => start(600)} disabled={running}>
        Simulate scan
      </Button>
      <Button
        size={24}
        icon={theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
        aria-label={`Theme: ${theme}. Switch to ${theme === 'dark' ? 'light' : 'dark'}`}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        {theme}
      </Button>
    </header>
  );
}

export default function DesignSheet() {
  const [selectedJar, setSelectedJar] = useState<string | null>(null);
  const sel = { selectedJar, onSelectJar: setSelectedJar };
  const only = params.get('only');
  // cmdk scrolls its active item into view on mount, which drags the whole sheet down to the
  // palette specimens. Restore the requested anchor (or the top) once that has happened.
  useEffect(() => {
    const id = window.setTimeout(() => {
      const target = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
      if (target) target.scrollIntoView({ block: 'start' });
      else window.scrollTo(0, 0);
    }, 50);
    return () => window.clearTimeout(id);
  }, []);
  const sections: Array<[string, ReactNode]> = [
    ['controls', <ControlsSection key="controls" />],
    ['rail', <RailSection key="rail" />],
    ['summary', <SummarySection key="summary" />],
    ['tiles', <TilesSection key="tiles" {...sel} />],
    ['triage', <TriageSection key="triage" {...sel} />],
    ['log', <LogSection key="log" onSelectJar={setSelectedJar} />],
    ['work-order', <WorkOrderSection key="work-order" />],
    ['mod-table', <ModTableSection key="mod-table" {...sel} />],
    ['palette', <PaletteSection key="palette" />],
    ['about', <AboutSection key="about" />],
    ['empty', <EmptySection key="empty" />],
  ];
  return (
    <div className="min-h-screen bg-bg text-fg">
      <TopBar />
      <main className="pb-16">{sections.filter(([id]) => !only || id === only).map(([, node]) => node)}</main>
    </div>
  );
}
