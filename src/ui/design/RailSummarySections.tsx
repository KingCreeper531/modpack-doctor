/** #rail and #summary: instance rail rows and the summary strip variants. */
import { FolderPlus } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '../components/Button';
import { InstanceRailRow } from '../components/InstanceRailRow';
import { Panel } from '../components/Panel';
import { SummaryStrip } from '../components/SummaryStrip';
import { INSTANCE_STATUS, INSTANCES } from './fixtures';
import { Section, Spec, SpecRow } from './Section';

export function RailSection() {
  const [selected, setSelected] = useState(INSTANCES[0]!.id);
  return (
    <Section id="rail" title="Instance rail" spec="§5" meta="48px rows · MR PR MMC CF VAN DIR PACK">
      <div className="flex">
        <Panel
          legend="Instances"
          meta={INSTANCES.length}
          flush
          className="w-[240px] shrink-0 border-r border-line"
          bodyClassName="flex flex-col"
        >
          {INSTANCES.map((inst, i) => (
            <InstanceRailRow key={inst.id} instance={inst} status={INSTANCE_STATUS[i] ?? 'unscanned'} selected={selected === inst.id} onSelect={setSelected} />
          ))}
          <div className="p-2">
            <Button size={24} icon={<FolderPlus size={16} />} className="w-full justify-start">
              Add folder
            </Button>
          </div>
        </Panel>
        <dl className="grid flex-1 grid-cols-[160px_minmax(0,1fr)] content-start gap-y-1 px-4 py-4 t-mono">
          {(
            [
              ['row 1', 'name, t-body 500'],
              ['row 2', 'launcher · MC · loader glyph + version · mods (right)'],
              ['pip', 'last scan: ok / signal / err / hollow = not scanned'],
              ['selected', '2px signal left rule + raised'],
              ['focus', 'inset 1px signal (dense-row rule)'],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="t-label text-fg-faint">{k}</dt>
              <dd className="text-fg-dim">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}

export function SummarySection() {
  const atm = INSTANCES[0]!;
  return (
    <Section id="summary" title="Summary strip" spec="§5 §10" meta="one 32px mono line, no stat cards">
      <div className="border-b border-line bg-panel px-4 pt-2">
        <h1 className="t-head text-fg">{atm.name}</h1>
        <SummaryStrip mcVersion="1.20.1" loader={atm.loader} modCount={214} counts={{ error: 3, warning: 5, info: 2 }} scannedAgoMs={2100} />
      </div>
      <SpecRow className="flex-col">
        <Spec label="Scanning" className="w-full">
          <SummaryStrip mcVersion="1.20.1" loader={atm.loader} modCount={214} scanning={{ done: 132, total: 214 }} />
        </Spec>
        <Spec label="Offline" className="w-full">
          <SummaryStrip mcVersion="1.21.1" loader={{ kind: 'fabric', version: '0.16.5' }} modCount={87} counts={{ error: 0, warning: 1, info: 0 }} scannedAgoMs={185_000} offline />
        </Spec>
        <Spec label="Clean" className="w-full">
          <SummaryStrip mcVersion="1.21.1" loader={{ kind: 'neoforge', version: '21.1.77' }} modCount={42} counts={{ error: 0, warning: 0, info: 0 }} scannedAgoMs={7_200_000} />
        </Spec>
        <Spec label="Never scanned, identity unknown" className="w-full">
          <SummaryStrip mcVersion={null} loader={null} modCount={118} />
        </Spec>
      </SpecRow>
    </Section>
  );
}
