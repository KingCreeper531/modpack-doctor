/** #tiles, #triage and #log: the scan grid, the triage list and the log viewer. */
import { useState } from 'react';

import type { FrameRef, LogLine } from '../../core/model';
import { Button } from '../components/Button';
import { formatDuration, formatInt } from '../components/format';
import { LogViewer } from '../components/LogViewer';
import { Panel } from '../components/Panel';
import { TileGrid } from '../components/TileGrid';
import type { TileState } from '../components/tileGridModel';
import { TriageRow } from '../components/TriageRow';
import { FINDINGS, JAR_NAMES } from './fixtures';
import { useScanSim } from './scanSim';
import { Section, Spec, SpecRow } from './Section';

/** A short run of tiles around one warning tile, for the interaction-state specimens. */
const STATE_RUN: Array<[string, TileState]> = [
  ['a', 'ok'],
  ['b', 'error'],
  ['c', 'warning'],
  ['d', 'warning'],
  ['e', 'ok'],
  ['f', 'disabled'],
  ['g', 'unscanned'],
];
const runTiles = (prefix: string) => STATE_RUN.map(([id, state]) => ({ id: `${prefix}-${id}`, label: `mod_${id}`, version: '1.4.2', state, count: 2 }));

const LEGEND: Array<[TileState, string]> = [
  ['unscanned', 'tile-empty + 1px fg-faint outline'],
  ['ok', 'ok-fill'],
  ['warning', 'signal-fill'],
  ['error', 'err + 2px top-right notch'],
  ['disabled', 'tile-off + 45° fg-faint hatch'],
];

export interface JarSelection {
  selectedJar: string | null;
  onSelectJar: (id: string) => void;
}

export function TilesSection({ selectedJar, onSelectJar }: JarSelection) {
  const { tiles, done, running, startedAt, finishedAt, start } = useScanSim();
  const meta = running
    ? `${formatInt(done)}/${formatInt(tiles.length)}`
    : `${formatInt(tiles.length)}/${formatInt(tiles.length)}  ${formatDuration(Math.max(0, finishedAt - startedAt) || 2100)}`;
  const counts = { error: 0, warning: 0, disabled: 0 };
  for (const t of tiles) if (t.state in counts) counts[t.state as keyof typeof counts]++;
  return (
    <Section id="tiles" title="Scan grid" spec="§6.1" meta="canvas · 12px tiles · 2px gap · hover, click, arrow keys">
      <Panel legend="Scan" meta={meta} actions={<span className="t-mono text-fg-faint">{`${counts.error} err · ${counts.warning} warn · ${counts.disabled} off`}</span>}>
        <TileGrid tiles={tiles} selectedId={selectedJar} onSelect={onSelectJar} label={`Scan grid, ${tiles.length} jars`} />
      </Panel>
      <SpecRow className="border-t">
        <Spec label="Hover" note="1px fg + panel keyline · 0ms tooltip">
          <div className="h-12">
            <TileGrid className="w-26" tiles={runTiles('h')} previewHoverId="h-c" label="Hover specimen" />
          </div>
        </Spec>
        <Spec label="Keyboard focus" note="2px signal + panel keyline">
          <TileGrid className="w-26" tiles={runTiles('f')} previewFocusId="f-d" label="Focus specimen" />
        </Spec>
        <Spec label="Selected" note="1px signal + panel keyline">
          <TileGrid className="w-26" tiles={runTiles('s')} selectedId="s-c" label="Selected specimen" />
        </Spec>
      </SpecRow>
      <SpecRow>
        {LEGEND.map(([state, note]) => (
          <Spec key={state} label={state} note={note}>
            <TileGrid className="w-4" tiles={[{ id: state, label: 'example', version: '1.0.0', state, count: 1 }]} label={`${state} tile`} />
          </Spec>
        ))}
        <Spec label="Stress" note="one draw per frame at most">
          <div className="flex gap-2">
            <Button size={24} onClick={() => start(600)} disabled={running}>
              Scan 600
            </Button>
            <Button size={24} onClick={() => start(1000)} disabled={running}>
              Scan 1,000
            </Button>
          </div>
        </Spec>
      </SpecRow>
    </Section>
  );
}

export function TriageSection({ selectedJar, onSelectJar }: JarSelection) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['f-split-01', 'f-dep-03']));
  const [focus, setFocus] = useState(1);
  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const sev = { error: 0, warning: 0, info: 0 };
  for (const f of FINDINGS) sev[f.severity]++;
  return (
    <Section id="triage" title="Triage list" spec="§6.2" meta="J / K move · Enter expands · 160ms height · W-JAVA-CLASS selected">
      <Panel legend="Findings" meta={`${sev.error} E · ${sev.warning} W · ${sev.info} I`} flush>
        <div
          role="list"
          tabIndex={0}
          aria-label="Findings"
          className="focus-visible:outline-1 focus-visible:-outline-offset-1"
          onKeyDown={(e) => {
            if (e.key === 'j' || e.key === 'J') setFocus((i) => Math.min(FINDINGS.length - 1, i + 1));
            else if (e.key === 'k' || e.key === 'K') setFocus((i) => Math.max(0, i - 1));
            else if (e.key === 'Enter' && e.target === e.currentTarget) toggle(FINDINGS[focus]!.id);
            else return;
            e.preventDefault();
          }}
        >
          {FINDINGS.map((f, i) => (
            <div role="listitem" key={f.id}>
              <TriageRow
                finding={f}
                expanded={expanded.has(f.id)}
                onToggle={() => {
                  setFocus(i);
                  toggle(f.id);
                }}
                focused={focus === i}
                selected={f.id === 'f-java-04'}
                jarNames={JAR_NAMES}
                selectedJarId={selectedJar}
                onJarClick={onSelectJar}
                onFix={() => {
                  window.location.hash = 'work-order';
                }}
              />
            </div>
          ))}
        </div>
      </Panel>
    </Section>
  );
}

const STACK: Array<[string, string | null]> = [
  ['java.lang.NullPointerException: Cannot invoke "net.minecraft.world.level.Level.getBlockState(BlockPos)" because "level" is null', null],
  ['\tat com.simibubi.create.content.kinetics.belt.BeltBlockEntity.tick(BeltBlockEntity.java:118) ~[create-1.20.1-0.5.1.f.jar%23412!/:0.5.1.f]', 'mods/create-1.20.1-0.5.1.f.jar'],
  ['\tat net.minecraft.world.level.Level.m_46653_(Level.java:479) ~[client-1.20.1-20230612.114412-srg.jar%23410!/:?]', null],
  ['\tat dev.engine_room.flywheel.backend.instancing.InstanceWorld.tick(InstanceWorld.java:122) ~[flywheel-forge-1.20.1-0.6.10.jar%23413!/:0.6.10]', 'mods/flywheel-forge-1.20.1-0.6.10.jar'],
  ['\tat net.minecraft.client.multiplayer.ClientLevel.m_104639_(ClientLevel.java:274) ~[client-1.20.1-20230612.114412-srg.jar%23410!/:?]', null],
];

const LOG_LINES: LogLine[] = [
  { n: 1, text: '---- Minecraft Crash Report ----', role: 'context' },
  { n: 2, text: '// Why did you do that?', role: 'context' },
  { n: 4, text: 'Time: 2024-11-02 21:14:07', role: 'context' },
  { n: 5, text: 'Description: Ticking block entity', role: 'context' },
  { n: 6, text: '', role: 'context' },
  ...STACK.map(([text], i): LogLine => ({ n: 7 + i, text, role: i === 0 || i === 1 ? 'culprit' : 'context' })),
  { n: 1216, text: '-- Block entity being ticked --', role: 'context' },
  { n: 1217, text: 'Details:', role: 'context' },
  { n: 1218, text: '\tName: create:belt // com.simibubi.create.content.kinetics.belt.BeltBlockEntity', role: 'culprit' },
  { n: 1219, text: '\tBlock location: World: (-212,64,388), Section: (at 12,0,4 in -14,4,24; chunk contains blocks -224,-64,384 to -209,319,399)', role: 'context' },
];
const LOG_FRAMES: FrameRef[] = STACK.flatMap(([, jar], i) => (jar ? [{ line: 7 + i, jarId: jar }] : []));

export function LogSection({ onSelectJar }: Pick<JarSelection, 'onSelectJar'>) {
  return (
    <Section id="log" title="Evidence / log viewer" spec="§6.3" meta="t-log · gutter · culprit wash · ⋯ elision · jar chips">
      <SpecRow>
        <Spec label="Crash report" note="crash-reports/crash-2024-11-02_21.14.07-client.txt · 2,431 lines" className="w-full">
          <LogViewer
            lines={LOG_LINES}
            frames={LOG_FRAMES}
            totalLines={2431}
            jarLabel={(id) => JAR_NAMES[id] ?? id}
            onJarClick={onSelectJar}
            label="Crash report excerpt"
          />
        </Spec>
      </SpecRow>
    </Section>
  );
}
