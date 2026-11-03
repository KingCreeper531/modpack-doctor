/** #controls: buttons, toggles, chips, severity marks, mono text, tooltip, input, table, resizer, errors, glyphs. */
import { ArrowClockwise, Copy, FolderPlus } from '@phosphor-icons/react';
import { useState } from 'react';

import type { LoaderKind, LogSource } from '../../bindings';
import { Button } from '../components/Button';
import { Chip } from '../components/Chip';
import { ErrorRow } from '../components/ErrorRow';
import { formatAgo, formatBytes } from '../components/format';
import { MonoText } from '../components/MonoText';
import { Panel } from '../components/Panel';
import { INSPECTOR_MAX, INSPECTOR_MIN } from '../components/resize';
import { Resizer } from '../components/Resizer';
import { Pip, SeverityRail, SeverityText } from '../components/Severity';
import { sortRows, type SortState } from '../components/sort';
import { Table, type Column } from '../components/Table';
import { TextInput } from '../components/TextInput';
import { Toggle } from '../components/Toggle';
import { Tooltip, TooltipBox } from '../components/Tooltip';
import { LoaderGlyph } from '../glyphs/LoaderGlyph';
import { LOADER_NAME } from '../glyphs/loaders';
import { ERRORS } from './fixtures';
import { Section, Spec, SpecRow } from './Section';

const NOW = 1_730_581_247_118;
const SOURCES: LogSource[] = [
  { id: 'crash-reports/crash-2024-11-02_21.14.07-client.txt', kind: 'crashReport', modifiedMs: NOW - 125_000, size: 48_213 },
  { id: 'logs/latest.log', kind: 'latestLog', modifiedMs: NOW - 2_100, size: 1_843_200 },
  { id: 'logs/debug.log', kind: 'debugLog', modifiedMs: NOW - 2_100, size: 12_582_912 },
  { id: 'hs_err_pid18244.log', kind: 'hsErr', modifiedMs: NOW - 86_400_000 * 3, size: 96_412 },
];
type SourceKey = 'id' | 'kind' | 'size' | 'modified';
const SOURCE_COLUMNS: ReadonlyArray<Column<LogSource, SourceKey>> = [
  { key: 'id', label: 'Source', width: 'minmax(0,1fr)', sortable: true, render: (s) => <MonoText truncate>{s.id}</MonoText> },
  { key: 'kind', label: 'Kind', width: '112px', sortable: true, render: (s) => <MonoText tone="dim">{s.kind}</MonoText> },
  { key: 'size', label: 'Size', width: '96px', align: 'right', sortable: true, render: (s) => <MonoText tone="dim">{formatBytes(s.size)}</MonoText> },
  { key: 'modified', label: 'Modified', width: '96px', align: 'right', sortable: true, render: (s) => <MonoText tone="faint">{formatAgo(NOW - s.modifiedMs)}</MonoText> },
];
const SOURCE_SORT: Record<SourceKey, (s: LogSource) => string | number> = {
  id: (s) => s.id,
  kind: (s) => s.kind,
  size: (s) => s.size,
  modified: (s) => -s.modifiedMs,
};

const LOADERS: LoaderKind[] = ['forge', 'neoforge', 'fabric', 'quilt', 'legacyforge', 'unknown'];

export function ControlsSection() {
  const [toggles, setToggles] = useState([true, false]);
  const [chip, setChip] = useState<string | null>('sodium-0.5.8.jar');
  const [sort, setSort] = useState<SortState<SourceKey>>({ key: 'size', dir: 'desc' });
  const [split, setSplit] = useState(360);

  return (
    <Section id="controls" title="Controls" spec="§6.5" meta="buttons · toggles · chips · table · resizer · errors · glyphs">
      <SpecRow>
        <Spec label="Button 32">
          <div className="flex items-center gap-2">
            <Button icon={<ArrowClockwise size={16} />} hint="Ctrl+R">
              Rescan
            </Button>
            <Button variant="primary">Execute</Button>
            <Button variant="danger">Remove duplicate</Button>
            <Button disabled>Execute</Button>
          </div>
        </Spec>
        <Spec label="Button 24">
          <div className="flex items-center gap-2">
            <Button size={24} icon={<Copy size={16} />}>
              Copy report
            </Button>
            <Button size={24} variant="primary">
              Disable rubidium-0.7.1.jar
            </Button>
            <Button size={24} variant="danger">
              Move to backup
            </Button>
            <Button size={24} disabled>
              Install flywheel
            </Button>
          </div>
        </Spec>
        <Spec label="Focus" note="2px signal, 2px offset">
          <div className="flex items-center gap-4">
            <Button className="outline-2 outline-offset-2 outline-signal">Cancel</Button>
            <Button variant="primary" hint="↵" className="outline-2 outline-offset-2 outline-signal">
              Execute
            </Button>
          </div>
        </Spec>
      </SpecRow>

      <SpecRow>
        <Spec label="Toggle">
          <div className="flex items-center gap-4">
            <Toggle on={toggles[0]!} label="sodium" showState onChange={(v) => setToggles([v, toggles[1]!])} />
            <Toggle on={toggles[1]!} label="rubidium" showState onChange={(v) => setToggles([toggles[0]!, v])} />
            <Toggle on label="jei" />
            <Toggle on={false} label="iris" />
            <Toggle on label="locked" disabled />
          </div>
        </Spec>
        <Spec label="Chip">
          <div className="flex items-center gap-1">
            {['sodium-0.5.8.jar', 'embeddium-0.3.18.jar', 'create-1.20.1-0.5.1.f.jar'].map((c) => (
              <Chip key={c} selected={chip === c} onClick={() => setChip(c)}>
                {c}
              </Chip>
            ))}
            <Chip>static.jar</Chip>
          </div>
        </Spec>
        <Spec label="Input">
          <div className="flex items-center gap-2">
            <TextInput placeholder="1.20.1" aria-label="Minecraft version override" className="w-30" />
            <TextInput defaultValue="47.3.0" aria-label="Loader version override" className="w-30" />
          </div>
        </Spec>
      </SpecRow>

      <SpecRow>
        <Spec label="Severity">
          <div className="flex flex-col border border-line">
            {(['error', 'warning', 'info'] as const).map((s) => (
              <div key={s} className="flex h-8 items-stretch border-b border-line bg-panel last:border-b-0">
                <SeverityRail severity={s} />
                <span className="flex w-20 items-center pl-2">
                  <SeverityText severity={s} />
                </span>
                <span className="flex items-center pr-4">
                  <SeverityText severity={s}>{s === 'error' ? 'E-DUP-ID' : s === 'warning' ? 'W-CORRUPT-JAR' : 'I-SPLIT-PKG'}</SeverityText>
                </span>
              </div>
            ))}
          </div>
        </Spec>
        <Spec label="Pip">
          <div className="flex flex-col gap-2 t-mono text-fg-dim">
            {(['ok', 'warning', 'error', 'info', 'none'] as const).map((t) => (
              <span key={t} className="flex items-center gap-2">
                <Pip tone={t} />
                {t}
              </span>
            ))}
          </div>
        </Spec>
        <Spec label="Mono text">
          <div className="flex w-[280px] flex-col gap-1">
            <MonoText truncate>sha1 4f2c9e1a7b3d5f6081c2e4a6b8d0f1e3c5a7b9d1</MonoText>
            <MonoText tone="dim">mods/create-1.20.1-0.5.1.f.jar</MonoText>
            <MonoText tone="faint">META-INF/jarjar/metadata.json</MonoText>
            <MonoText truncate>C:\Users\alex\curseforge\minecraft\Instances\All the Mods 9\mods</MonoText>
          </div>
        </Spec>
        <Spec label="Tooltip" note="400ms on DOM, 0ms on canvas">
          <div className="flex flex-col items-start gap-4">
            <TooltipBox>{'sodium  0.5.8  ·  WARN 2'}</TooltipBox>
            <Tooltip content="mods/sodium-0.5.8.jar · 312 KB · sha1 4f2c9e1a">
              <Chip>hover me</Chip>
            </Tooltip>
          </div>
        </Spec>
        <Spec label="Loader glyphs" note="16 · 12">
          <div className="grid grid-cols-[16px_12px_auto] items-center gap-x-2 gap-y-1 text-fg-dim">
            {LOADERS.map((k) => (
              <div key={k} className="contents">
                <LoaderGlyph kind={k} size={16} labelled />
                <LoaderGlyph kind={k} size={12} />
                <span className="t-small">{LOADER_NAME[k]}</span>
              </div>
            ))}
          </div>
        </Spec>
      </SpecRow>

      <SpecRow>
        <Spec label="Table" note="sortable · numbers right-aligned" className="w-[640px] max-w-full">
          <div className="border border-line bg-panel">
            <Table
              label="Log sources"
              columns={SOURCE_COLUMNS}
              rows={sortRows(SOURCES, SOURCE_SORT[sort.key], sort.dir)}
              rowKey={(s) => s.id}
              sort={sort}
              onSort={setSort}
              selectedKey="logs/latest.log"
              onRowClick={() => undefined}
            />
          </div>
        </Spec>
        <Spec label="Resizer" note={`inspector ${split}px · ${INSPECTOR_MIN}–${INSPECTOR_MAX} · arrows ±8, Shift ±32`} className="min-w-[480px] flex-1">
          <div className="flex h-32 border border-line">
            <div className="flex min-w-0 flex-1 items-center justify-center bg-panel t-mono text-fg-faint">workspace</div>
            <Resizer size={split} min={INSPECTOR_MIN} max={INSPECTOR_MAX} onResize={setSplit} label="Resize inspector" />
            <div className="flex min-w-0 shrink-0 bg-panel" style={{ width: Math.round(split / 2) }}>
              <Panel legend="Inspector" meta={`${split}px`} className="flex-1">
                <span className="t-mono text-fg-faint">half scale</span>
              </Panel>
            </div>
          </div>
        </Spec>
      </SpecRow>

      <div>
        <div className="flex h-6 items-center px-4">
          <span className="t-label text-fg-faint">Error rows</span>
          <span className="ml-2 t-mono text-fg-faint">AppError, inline, never toasts</span>
        </div>
        {ERRORS.map((e, i) => (
          <ErrorRow
            key={e.kind}
            error={e}
            {...(i === 0 ? { action: <Button size={24} icon={<FolderPlus size={16} />}>Choose folder</Button> } : {})}
          />
        ))}
      </div>
    </Section>
  );
}
