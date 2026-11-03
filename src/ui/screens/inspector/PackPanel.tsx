/**
 * PACK IDENTITY panel: the effective pack identity `resolvePack` settled on (and where it came
 * from), plus an override editor for MC version, loader, loader version and side. Applying
 * stores the override through `set_settings` and re-runs the checks; Clear removes it.
 */
import { useState, type FormEvent, type ReactNode } from 'react';

import type { LoaderKind, PackOverride, Side } from '../../../bindings';
import type { PackContext } from '../../../core/model';
import { Button } from '../../components/Button';
import { ErrorRow } from '../../components/ErrorRow';
import { Panel } from '../../components/Panel';
import { TextInput } from '../../components/TextInput';
import { LoaderGlyph } from '../../glyphs/LoaderGlyph';
import { LOADER_NAME } from '../../glyphs/loaders';
import { useActions, useApp } from '../../app/StoreContext';
import { Plate, PlateRow, SubLegend } from './Plate';

const SOURCE: Record<PackContext['source'], string> = {
  override: 'your override',
  launcher: 'launcher metadata',
  mrpack: '.mrpack index',
  majority: 'majority of jars',
  unknown: 'unknown',
};

const LOADERS: readonly LoaderKind[] = ['forge', 'neoforge', 'fabric', 'quilt', 'legacyforge'];

const SELECT = 'h-6 min-w-0 rounded-1 border border-line-strong bg-raised px-1 t-mono text-fg';

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-2 px-4">
      <label htmlFor={id} className="w-24 shrink-0 t-label text-fg-faint">
        {label}
      </label>
      <div className="flex min-w-0 flex-1">{children}</div>
    </div>
  );
}

function OverrideEditor({
  instanceId,
  current,
  detectedMc,
  detectedLoaderVersion,
}: {
  instanceId: string;
  current: PackOverride | null;
  /** Shown as placeholders so a blank field visibly means "keep the detected value". */
  detectedMc: string | null;
  detectedLoaderVersion: string | null;
}) {
  const a = useActions();
  const error = useApp((s) => s.overrideError);
  const [mc, setMc] = useState(current?.mcVersion ?? '');
  const [kind, setKind] = useState<LoaderKind | ''>(current?.loader?.kind ?? '');
  const [version, setVersion] = useState(current?.loader?.version ?? '');
  const [side, setSide] = useState<Side | ''>(current?.side ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const o: PackOverride = {
      mcVersion: mc.trim() || null,
      loader: kind ? { kind, version: version.trim() || null } : null,
      side: side || null,
    };
    setBusy(true);
    await a.setOverride(instanceId, o.mcVersion || o.loader || o.side ? o : null);
    setBusy(false);
  };
  const clear = async () => {
    setMc('');
    setKind('');
    setVersion('');
    setSide('');
    setBusy(true);
    await a.setOverride(instanceId, null);
    setBusy(false);
  };

  const id = (f: string) => `override-${f}`;
  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Pack identity override">
      <SubLegend meta={current ? 'active' : 'none'}>Override</SubLegend>
      <p className="px-4 pt-2 t-small text-fg-dim">Blank fields keep the detected value. Overrides apply to the checks and to fixes.</p>
      <div className="py-1">
        <Field id={id('mc')} label="Minecraft">
          <TextInput id={id('mc')} value={mc} onChange={(e) => setMc(e.target.value)} placeholder={detectedMc ?? 'e.g. 1.21.1'} className="w-full" />
        </Field>
        <Field id={id('loader')} label="Loader">
          <select id={id('loader')} value={kind} onChange={(e) => setKind(e.target.value as LoaderKind | '')} className={`${SELECT} w-full`}>
            <option value="">detected</option>
            {LOADERS.map((l) => (
              <option key={l} value={l}>
                {LOADER_NAME[l]}
              </option>
            ))}
          </select>
        </Field>
        <Field id={id('version')} label="Loader ver.">
          <TextInput
            id={id('version')}
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder={kind ? (detectedLoaderVersion ?? 'version') : 'pick a loader first'}
            disabled={!kind}
            className="w-full"
          />
        </Field>
        <Field id={id('side')} label="Side">
          <select id={id('side')} value={side} onChange={(e) => setSide(e.target.value as Side | '')} className={`${SELECT} w-full`}>
            <option value="">detected</option>
            <option value="client">client</option>
            <option value="server">server</option>
          </select>
        </Field>
      </div>
      {error ? <ErrorRow error={error} className="border-t" /> : null}
      <div className="flex items-center gap-2 border-t border-line px-4 py-2">
        <Button type="submit" size={24} variant="primary" disabled={busy}>
          Apply and recheck
        </Button>
        <Button size={24} disabled={busy || !current} onClick={() => void clear()}>
          Clear override
        </Button>
      </div>
    </form>
  );
}

export function PackPanel({ instanceId }: { instanceId: string }) {
  const instance = useApp((s) => s.discovery?.instances.find((i) => i.id === instanceId) ?? null);
  const pack = useApp((s) => s.scans[instanceId]?.pack ?? null);
  const current = useApp((s) => s.settings.overrides[instanceId] ?? null);
  if (!instance) return null;
  const mc = pack?.mcVersion ?? instance.mcVersion;
  const loader = pack ? pack.loader : instance.loader;
  const side = pack?.side ?? instance.side;
  return (
    <Panel legend="Pack identity" meta={pack ? `from ${SOURCE[pack.source]}` : 'before checks'} flush className="shrink-0">
      <Plate label="Effective pack identity">
        <PlateRow label="Minecraft">{mc ?? <span className="text-fg-dim">unknown</span>}</PlateRow>
        <PlateRow label="Loader">
          {loader ? (
            <span className="flex items-center gap-1">
              <LoaderGlyph kind={loader.kind} size={12} />
              {LOADER_NAME[loader.kind]} {loader.version ?? <span className="text-fg-dim">version unknown</span>}
            </span>
          ) : (
            <span className="text-fg-dim">{instance.metadataSource === 'launcher' ? 'none (vanilla)' : 'unknown'}</span>
          )}
        </PlateRow>
        <PlateRow label="Side">{side}</PlateRow>
      </Plate>
      <OverrideEditor
        key={JSON.stringify(current)}
        instanceId={instanceId}
        current={current}
        detectedMc={mc}
        detectedLoaderVersion={loader?.version ?? null}
      />
    </Panel>
  );
}
