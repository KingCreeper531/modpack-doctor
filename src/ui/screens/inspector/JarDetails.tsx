/**
 * Inspector: one jar. File facts (path, hashes, size, status, loaders, Java level, packages,
 * mixins, module, nesting), its Modrinth project (M5), then each declared mod with its ranges,
 * dependencies and `provides`, then the findings that cite the jar.
 */
import { ArrowSquareOut } from '@phosphor-icons/react';
import { useMemo } from 'react';

import type { JarRecord, ModMeta } from '../../../bindings';
import { Chip } from '../../components/Chip';
import { formatBytes, formatInt } from '../../components/format';
import { FindingCode, SeverityRail } from '../../components/Severity';
import { Table, type Column } from '../../components/Table';
import { LoaderGlyph } from '../../glyphs/LoaderGlyph';
import { LOADER_NAME } from '../../glyphs/loaders';
import { jarMatch } from '../../../core/modrinth';
import { crashFindingsCiting, sourceName } from '../../app/crashState';
import { javaRelease } from '../../app/derive';
import { openExternal } from '../../app/external';
import { matchProject, projectUrl, sideSupport, updateWords, viewContext } from '../../app/modrinthState';
import { useActions, useApp } from '../../app/StoreContext';
import { Plate, PlateRow, rangeText, SubLegend } from './Plate';

type Dep = ModMeta['deps'][number];

const DEP_COLUMNS: ReadonlyArray<Column<Dep>> = [
  { key: 'modId', label: 'Mod id', width: 'minmax(0,1fr)', render: (d) => <span className="truncate t-mono text-fg">{d.modId}</span> },
  { key: 'kind', label: 'Kind', width: '88px', render: (d) => <span className="truncate t-mono text-fg-dim">{d.kind}</span> },
  {
    key: 'range',
    label: 'Range',
    width: 'minmax(0,1fr)',
    render: (d) => (
      <span className="truncate t-mono text-fg-dim" title={rangeText(d.range)}>
        {rangeText(d.range)}
      </span>
    ),
  },
];

const PACKAGES_SHOWN = 8;

function ModBlock({ meta }: { meta: ModMeta }) {
  return (
    <section aria-label={`Mod ${meta.modId}`}>
      <SubLegend meta={meta.metadataFile}>
        <span className="flex items-center gap-1 normal-case">
          <LoaderGlyph kind={meta.loader} size={12} />
          <span className="t-mono text-fg">{meta.modId}</span>
          <span className="t-mono text-fg-dim">{meta.version}</span>
        </span>
      </SubLegend>
      <Plate>
        {meta.name ? <PlateRow label="Name">{meta.name}</PlateRow> : null}
        <PlateRow label="Loader">{LOADER_NAME[meta.loader]}</PlateRow>
        <PlateRow label="Side">{meta.environment}</PlateRow>
        <PlateRow label="Minecraft">{rangeText(meta.mcRange)}</PlateRow>
        <PlateRow label="Loader range">{rangeText(meta.loaderRange)}</PlateRow>
        {meta.languageLoader ? (
          <PlateRow label="Language">
            {meta.languageLoader} <span className="text-fg-dim">{rangeText(meta.languageRange)}</span>
          </PlateRow>
        ) : null}
        {meta.provides.length ? <PlateRow label="Provides">{meta.provides.join(', ')}</PlateRow> : null}
      </Plate>
      {meta.deps.length ? <Table label={`Dependencies of ${meta.modId}`} columns={DEP_COLUMNS} rows={meta.deps} rowKey={(d) => `${d.modId}:${d.kind}`} /> : null}
    </section>
  );
}

function CitingFindings({ instanceId, jarId }: { instanceId: string; jarId: string }) {
  const findings = useApp((s) => s.scans[instanceId]?.findings);
  const a = useActions();
  const citing = useMemo(() => (findings ?? []).filter((f) => f.culprits.some((c) => c.jarId === jarId)), [findings, jarId]);
  if (!citing.length) return null;
  return (
    <section aria-label="Findings for this jar">
      <SubLegend meta={citing.length}>Findings</SubLegend>
      <ul>
        {citing.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => a.select({ kind: 'finding', id: f.id })}
              className="flex h-6 w-full items-stretch border-b border-line text-left hover:bg-raised focus-visible:bg-raised focus-visible:outline-1 focus-visible:-outline-offset-1"
            >
              <SeverityRail severity={f.severity} />
              <FindingCode code={f.code} severity={f.severity} className="flex w-36 shrink-0 items-center truncate pl-4" />
              <span className="flex min-w-0 flex-1 items-center truncate pr-4 t-small text-fg">{f.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Crash findings (any analysed log of the instance) that name this jar (M4). */
function CitingCrashes({ instanceId, jarId }: { instanceId: string; jarId: string }) {
  const crashes = useApp((s) => s.crashes[instanceId]);
  const a = useActions();
  const citing = useMemo(() => crashFindingsCiting(crashes, jarId), [crashes, jarId]);
  if (!citing.length) return null;
  return (
    <section aria-label="Crash findings for this jar">
      <SubLegend meta={citing.length}>Crash findings</SubLegend>
      <ul>
        {citing.map(({ sourceId, finding: f }) => (
          <li key={`${sourceId}:${f.id}`}>
            <button
              type="button"
              onClick={() => a.selectCrash(instanceId, sourceId, f.id)}
              className="flex h-8 w-full items-stretch border-b border-line text-left hover:bg-raised focus-visible:bg-raised focus-visible:outline-1 focus-visible:-outline-offset-1"
            >
              <SeverityRail severity={f.severity} />
              <span className="flex min-w-0 flex-1 flex-col justify-center pr-4 pl-4">
                <span className="flex min-w-0 items-center gap-2">
                  <FindingCode code={f.code} severity={f.severity} className="shrink-0" />
                  <span className="min-w-0 truncate t-small text-fg">{f.title}</span>
                </span>
                <span className="truncate t-mono text-fg-faint">from {sourceName(sourceId)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Why a jar's Modrinth state is unknown, in words. */
function unknownReason(enabled: boolean, status: string | undefined, notice: string | undefined): string {
  if (!enabled) return 'unknown (Modrinth off)';
  if (status === 'loading') return 'looking up…';
  if (status === 'idle' || status === undefined) return 'not looked up yet';
  if (notice === 'offline') return 'unknown (Modrinth unreachable)';
  return 'unknown (Modrinth lookup failed)';
}

const UPDATE_TONE = { ok: 'text-ok', dim: 'text-fg-dim', faint: 'text-fg-faint' } as const;

/**
 * The jar's Modrinth project: title with a link to its page (opened in the browser), the
 * identified version, the suggested update (with a `beta` label), and where it runs.
 */
function ModrinthFacts({ instanceId, jar }: { instanceId: string; jar: JarRecord }) {
  const result = useApp((s) => s.scans[instanceId]?.result ?? null);
  const pack = useApp((s) => s.scans[instanceId]?.pack ?? null);
  const m = useApp((s) => s.modrinth[instanceId]);
  const enabled = useApp((s) => s.settings.modrinthEnabled);
  const backendKind = useApp((s) => s.backendKind);
  const ctx = viewContext(m, result);
  const match = useMemo(() => {
    try {
      return jarMatch(jar, ctx);
    } catch {
      return { state: 'unknown' } as const;
    }
  }, [jar, ctx]);
  const project = matchProject(match);
  const words = updateWords(ctx?.updateStatus?.[jar.sha1.trim().toLowerCase()], m?.filters ?? null, {
    loaderName: pack?.loader ? LOADER_NAME[pack.loader.kind] : null,
    mcVersion: pack?.mcVersion ?? null,
  });
  return (
    <Plate label="Modrinth">
      {match.state === 'missing' ? (
        <PlateRow label="Project">
          <span className="text-fg-dim">Not on Modrinth (possibly CurseForge or manual)</span>
        </PlateRow>
      ) : match.state === 'unknown' ? (
        <PlateRow label="Project">
          <span className="text-fg-faint">{unknownReason(enabled, m?.status, m?.notice?.kind)}</span>
        </PlateRow>
      ) : (
        <>
          <PlateRow label="Project">
            {project ? (
              <span className="flex min-w-0 flex-col items-start">
                <span className="text-fg">{project.title}</span>
                <button
                  type="button"
                  onClick={() => void openExternal(projectUrl(project), backendKind)}
                  title={`Open ${projectUrl(project)} in your browser`}
                  className="flex items-center gap-1 text-fg-dim underline decoration-line-strong underline-offset-2 hover:text-fg hover:decoration-fg"
                >
                  modrinth.com/mod/{project.slug}
                  <ArrowSquareOut size={12} aria-hidden />
                </button>
              </span>
            ) : (
              <span className="text-fg-dim">{match.version.projectId}</span>
            )}
          </PlateRow>
          <PlateRow label="Version">
            {match.version.versionNumber}
            {match.version.versionType !== 'release' ? <span className="pl-2 text-fg-dim">{match.version.versionType}</span> : null}
          </PlateRow>
          <PlateRow label="Update">
            {match.state === 'update' ? (
              <span className="text-signal">
                {match.update.versionNumber}
                {match.beta ? <span className="pl-2 t-small">beta</span> : null}
              </span>
            ) : (
              <span className={UPDATE_TONE[words.tone]}>{words.text}</span>
            )}
          </PlateRow>
          <PlateRow label="Runs on">{sideSupport(match.version, project)}</PlateRow>
        </>
      )}
    </Plate>
  );
}

function JarFacts({ jar, byId }: { jar: JarRecord; byId: ReadonlyMap<string, JarRecord> }) {
  const a = useActions();
  const extra = jar.packages.length - PACKAGES_SHOWN;
  return (
    <Plate label="Jar">
      <PlateRow label="File">{jar.fileName}</PlateRow>
      <PlateRow label="Path">{jar.path}</PlateRow>
      <PlateRow label="Size">{formatBytes(jar.size)}</PlateRow>
      <PlateRow label="SHA-1">{jar.sha1}</PlateRow>
      <PlateRow label="SHA-512">
        <span className="line-clamp-2" title={jar.sha512}>
          {jar.sha512}
        </span>
      </PlateRow>
      <PlateRow label="Status">
        {jar.status.state === 'ok' ? (
          <span className="text-ok">{jar.disabled ? 'readable · disabled' : 'readable'}</span>
        ) : (
          <span className="text-err-text">
            {jar.status.state}: {jar.status.reason}
          </span>
        )}
      </PlateRow>
      <PlateRow label="Loaders">
        {jar.loaders.length ? (
          <span className="flex flex-wrap items-center gap-2">
            {jar.loaders.map((l) => (
              <span key={l} className="flex items-center gap-1">
                <LoaderGlyph kind={l} size={12} />
                {LOADER_NAME[l]}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-fg-dim">no metadata file</span>
        )}
      </PlateRow>
      <PlateRow label="Classes">
        {jar.maxClassMajor !== null ? (
          <>
            major {jar.maxClassMajor} <span className="text-fg-dim">→ Java {javaRelease(jar.maxClassMajor)}</span>
          </>
        ) : (
          <span className="text-fg-dim">no class files</span>
        )}
      </PlateRow>
      <PlateRow label="Packages">
        {formatInt(jar.packages.length)}
        {jar.packages.length ? (
          <span className="mt-1 flex flex-col text-fg-dim">
            {jar.packages.slice(0, PACKAGES_SHOWN).map((p) => (
              <span key={p} className="truncate" title={p}>
                {p}
              </span>
            ))}
            {extra > 0 ? <span className="text-fg-faint">+{formatInt(extra)} more</span> : null}
          </span>
        ) : null}
      </PlateRow>
      <PlateRow label="Mixins">{jar.mixinConfigs.length ? jar.mixinConfigs.join(', ') : <span className="text-fg-dim">none</span>}</PlateRow>
      {jar.moduleName ? <PlateRow label="Module">{jar.moduleName}</PlateRow> : null}
      {jar.jarjar ? (
        <PlateRow label="JarJar">
          {jar.jarjar.group}:{jar.jarjar.artifact} <span className="text-fg-dim">{jar.jarjar.version ?? '?'} in {jar.jarjar.range ?? 'any'}</span>
        </PlateRow>
      ) : null}
      {jar.parentId ? (
        <PlateRow label="Inside">
          <Chip title={jar.parentId} onClick={() => a.revealJar(jar.parentId!)}>
            {byId.get(jar.parentId)?.fileName ?? jar.parentId}
          </Chip>
        </PlateRow>
      ) : null}
      {jar.nested.length ? (
        <PlateRow label="Nested">
          <span className="flex flex-wrap gap-1">
            {jar.nested.map((id) => (
              <Chip key={id} title={id} onClick={() => a.revealJar(id)}>
                {byId.get(id)?.fileName ?? id}
              </Chip>
            ))}
          </span>
        </PlateRow>
      ) : null}
    </Plate>
  );
}

export function JarDetails({ instanceId, jarId }: { instanceId: string; jarId: string }) {
  const result = useApp((s) => s.scans[instanceId]?.result ?? null);
  const stub = useApp((s) => s.scans[instanceId]?.stubs.find((j) => j.id === jarId) ?? null);
  const byId = useMemo(() => new Map((result?.jars ?? []).map((j) => [j.id, j])), [result]);
  const jar = byId.get(jarId);

  if (!jar) {
    return (
      <div className="px-4 py-2">
        <h3 className="truncate t-title text-fg">{stub?.fileName ?? jarId}</h3>
        <p className="t-small text-fg-faint">Details appear when the scan finishes.</p>
      </div>
    );
  }
  const primary = jar.mods[0];
  return (
    <div className="flex flex-col">
      <div className="flex flex-col px-4 py-2">
        <h3 className="truncate t-title text-fg" title={primary?.name ?? jar.fileName}>
          {primary?.name ?? primary?.modId ?? jar.fileName}
        </h3>
        {primary ? (
          <span className="t-mono text-fg-dim">
            {primary.modId} {primary.version}
          </span>
        ) : null}
      </div>
      <div className="border-t border-line">
        <JarFacts jar={jar} byId={byId} />
      </div>
      <SubLegend>Modrinth</SubLegend>
      <ModrinthFacts instanceId={instanceId} jar={jar} />
      <CitingFindings instanceId={instanceId} jarId={jarId} />
      <CitingCrashes instanceId={instanceId} jarId={jarId} />
      {jar.mods.length ? (
        <>
          <SubLegend meta={jar.mods.length}>Declared mods</SubLegend>
          {jar.mods.map((m, i) => (
            <ModBlock key={`${m.modId}:${m.loader}:${i}`} meta={m} />
          ))}
        </>
      ) : null}
    </div>
  );
}
